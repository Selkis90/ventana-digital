const video = document.getElementById("video");
const videoRemoto = document.getElementById("video-remoto");

// ============================================
// 📱 DETECCIÓN DE DISPOSITIVO
// ============================================
const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent);
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

console.log(`📱 Dispositivo: ${isMobile ? 'Móvil' : 'Desktop'}`);
console.log(`🌐 Navegador: ${isSafari ? 'Safari' : 'Otro'}`);
console.log(`🍎 iOS: ${isiOS}`);

// ============================================
// 🔌 CONFIGURACIÓN DE SOCKET
// ============================================
const socket = io("https://ventana-digital.onrender.com", {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 50,
    reconnectionDelay: isMobile ? 2000 : 1000,
    reconnectionDelayMax: 10000,
    timeout: isMobile ? 60000 : 30000,
    forceNew: true,
    autoConnect: true
});

const peers = {};
let streamLocal = null;
let turnServers = [];
let isProcessingAnswer = {};
let peerIdRemoto = null;
let isConnecting = false;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 3;
let audioTrackCreated = false;

// ============================================
// 🔊 CONTROL DE AUDIO
// ============================================
class AudioController {
    constructor() {
        this.audioContexts = new Map();
        this.isInitialized = false;
        this.isIOS = isiOS;
        this.globalContext = null;
    }

    async init() {
        if (this.isInitialized && this.globalContext && this.globalContext.state !== 'closed') {
            return true;
        }
        
        try {
            if (this.isIOS) {
                if (!window._iosAudioContext) {
                    window._iosAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                }
                if (window._iosAudioContext.state === 'suspended') {
                    await window._iosAudioContext.resume();
                }
                this.globalContext = window._iosAudioContext;
            } else {
                this.globalContext = new (window.AudioContext || window.webkitAudioContext)();
                if (this.globalContext.state === 'suspended') {
                    await this.globalContext.resume();
                }
            }
            
            this.isInitialized = true;
            console.log('✅ AudioController inicializado');
            return true;
        } catch (error) {
            console.warn('⚠️ Error inicializando AudioContext:', error);
            return false;
        }
    }

    createAudioForPeer(peerId, stream) {
        try {
            if (!stream) return false;
            if (stream === streamLocal) {
                console.log(`⚠️ Ignorando stream local`);
                return false;
            }
            
            const audioTracks = stream.getAudioTracks();
            console.log(`🎵 Stream para ${peerId} tiene ${audioTracks.length} tracks de audio`);
            
            if (audioTracks.length === 0) {
                console.warn(`⚠️ NO HAY AUDIO en stream para ${peerId}`);
                return false;
            }

            audioTracks.forEach(track => {
                track.enabled = true;
                console.log(`🎵 Track de audio remoto: ${track.label}`);
            });

            if (this.audioContexts.has(peerId)) {
                this.destroyAudioForPeer(peerId);
            }

            if (!this.globalContext || this.globalContext.state === 'closed') {
                this.isInitialized = false;
                return false;
            }

            const source = this.globalContext.createMediaStreamSource(stream);
            const gainNode = this.globalContext.createGain();
            gainNode.gain.value = 0.3;
            
            const filter = this.globalContext.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = isMobile ? 6000 : 8000;
            
            source.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(this.globalContext.destination);
            
            this.audioContexts.set(peerId, {
                source: source,
                gainNode: gainNode,
                filter: filter
            });
            
            console.log(`✅ Audio remoto CREADO para peer ${peerId}`);
            return true;
        } catch (error) {
            console.error(`❌ Error creando audio:`, error);
            return false;
        }
    }

    setVolume(peerId, volume) {
        const audioData = this.audioContexts.get(peerId);
        if (audioData && audioData.gainNode) {
            audioData.gainNode.gain.value = Math.max(0, Math.min(1, volume));
            return true;
        }
        return false;
    }

    muteAudio(peerId, muted) {
        const audioData = this.audioContexts.get(peerId);
        if (audioData && audioData.gainNode) {
            audioData.gainNode.gain.value = muted ? 0 : 0.3;
            return true;
        }
        return false;
    }

    destroyAudioForPeer(peerId) {
        const audioData = this.audioContexts.get(peerId);
        if (audioData) {
            try {
                audioData.source.disconnect();
            } catch (e) {}
            this.audioContexts.delete(peerId);
            console.log(`🗑️ Audio destruido para peer ${peerId}`);
        }
    }

    destroyAll() {
        for (const [peerId, audioData] of this.audioContexts) {
            try {
                audioData.source.disconnect();
            } catch (e) {}
        }
        this.audioContexts.clear();
        console.log('🗑️ Todos los audios destruidos');
    }

    resumeContext() {
        if (this.isIOS && this.globalContext && this.globalContext.state === 'suspended') {
            this.globalContext.resume().catch(e => console.warn('⚠️ No se pudo reanudar AudioContext'));
        }
    }
}

const audioController = new AudioController();

// ============================================
// 🖥️ UI State
// ============================================
video.style.display = "none";
videoRemoto.style.display = "none";
video.muted = true;
video.volume = 0;
videoRemoto.muted = false;
videoRemoto.volume = 0.3;

if (isMobile) {
    video.setAttribute('playsinline', '');
    videoRemoto.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    videoRemoto.setAttribute('autoplay', '');
}

// ============================================
// 🔧 Funciones Core
// ============================================

async function obtenerTurnServers() {
    try {
        const response = await fetch('/turn-credentials');
        if (response.ok) {
            const data = await response.json();
            if (data.iceServers) {
                turnServers = data.iceServers;
                console.log('✅ Servidores TURN obtenidos:', turnServers.length);
                return turnServers;
            }
        }
    } catch (error) {
        console.warn('⚠️ No se pudo obtener TURN:', error.message);
    }
    
    console.log('🔄 Usando TURN de respaldo');
    turnServers = [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
        {
            urls: [
                "turn:openrelay.metered.ca:80",
                "turn:openrelay.metered.ca:443",
                "turn:openrelay.metered.ca:3478"
            ],
            username: "openrelayproject",
            credential: "openrelayproject"
        }
    ];
    return turnServers;
}

function actualizarEstado(mensaje, tipo) {
    const estado = document.getElementById("estado");
    if (estado) {
        estado.textContent = mensaje;
        estado.className = tipo || "inicializando";
    }
}

function actualizarInfoPeer(id) {
    const miId = document.getElementById('mi-id');
    const peerInfo = document.getElementById('peer-conectado');
    if (miId) {
        miId.textContent = `ID: ${socket.id ? socket.id.substring(0, 8) : 'Conectando...'}`;
    }
    if (peerInfo) {
        peerInfo.textContent = `Peer: ${id ? id.substring(0, 8) : 'Ninguno'}`;
    }
}

function mostrarVideoRemoto(stream, peerId) {
    console.log(`📹 ASIGNANDO VIDEO REMOTO de ${peerId}`);
    if (!stream) {
        console.warn('⚠️ Stream nulo');
        return;
    }
    
    if (stream === streamLocal) {
        console.warn('⚠️ Ignorando stream local');
        return;
    }
    
    peerIdRemoto = peerId;
    actualizarInfoPeer(peerId);
    
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`📊 Stream remoto: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
    
    if (audioTracks.length === 0) {
        console.warn('⚠️ EL STREAM REMOTO NO TIENE AUDIO - Solo video');
        actualizarEstado("🔴 Sin audio remoto", "desconectado");
    } else {
        console.log(`🎵 Audio remoto encontrado: ${audioTracks.length} tracks`);
        audioTracks.forEach(track => {
            track.enabled = true;
            console.log(`   - ${track.label}`);
        });
    }
    
    if (videoRemoto.srcObject === stream) {
        console.log(`ℹ️ Stream ya asignado`);
        return;
    }
    
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject = null;
    }
    
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    video.style.display = "block";
    
    if (isMobile) {
        videoRemoto.setAttribute('playsinline', 'true');
        videoRemoto.setAttribute('webkit-playsinline', 'true');
    }
    
    videoRemoto.muted = false;
    videoRemoto.volume = 0.3;
    
    const playVideo = async () => {
        try {
            await videoRemoto.play();
            console.log(`✅ Video remoto reproduciendo`);
            
            await new Promise(resolve => setTimeout(resolve, 300));
            await audioController.init();
            
            if (audioTracks.length > 0) {
                const audioCreated = audioController.createAudioForPeer(peerId, stream);
                if (audioCreated) {
                    audioController.setVolume(peerId, 0.3);
                    console.log(`✅ Audio remoto configurado`);
                    actualizarEstado(`🟢 Conectado con audio`, "conectado");
                }
            } else {
                console.warn('⚠️ No se crea audio - sin tracks de audio');
            }
            
            isConnecting = false;
            connectionAttempts = 0;
        } catch (error) {
            console.warn(`⚠️ Error al reproducir video:`, error.message);
            setTimeout(() => {
                videoRemoto.play()
                    .then(() => {
                        console.log(`✅ Video reproducido en reintento`);
                        if (audioTracks.length > 0) {
                            audioController.createAudioForPeer(peerId, stream);
                        }
                        isConnecting = false;
                    })
                    .catch(e => {
                        console.warn(`⚠️ Error en reintento:`, e.message);
                        isConnecting = false;
                    });
            }, 1000);
        }
    };
    
    playVideo();
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject = null;
    }
    if (peerIdRemoto) {
        audioController.destroyAudioForPeer(peerIdRemoto);
        peerIdRemoto = null;
        actualizarInfoPeer(null);
    }
    if (streamLocal) {
        video.style.display = "block";
    }
}

function limpiarPeer(targetId) {
    if (peers[targetId]) {
        try {
            const oldPc = peers[targetId];
            oldPc.onicecandidate = null;
            oldPc.ontrack = null;
            oldPc.onconnectionstatechange = null;
            oldPc.oniceconnectionstatechange = null;
            oldPc.onnegotiationneeded = null;
            oldPc.close();
        } catch (e) {}
        delete peers[targetId];
        audioController.destroyAudioForPeer(targetId);
        console.log(`🧹 Peer limpiado: ${targetId}`);
    }
}

// ============================================
// 🔥🔥🔥 CREAR TRACK DE AUDIO SILENCIOSO (FALLBACK)
// ============================================
function crearTrackAudioSilencioso() {
    try {
        // Crear un AudioContext
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        // Crear un buffer de 1 segundo en silencio
        const bufferSize = audioContext.sampleRate * 1;
        const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
        // Llenar con ceros (silencio)
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = 0;
        }
        // Crear una fuente y conectarla
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(audioContext.destination);
        source.start(0);
        
        // Obtener el stream del AudioContext
        const dest = audioContext.createMediaStreamDestination();
        source.connect(dest);
        
        // Devolver el track de audio
        const track = dest.stream.getAudioTracks()[0];
        console.log('✅ Track de audio silencioso creado como fallback');
        return track;
    } catch (error) {
        console.error('❌ Error creando track de audio silencioso:', error);
        return null;
    }
}

// ============================================
// 🔥🔥🔥 CREACIÓN DE PEER CON AUDIO GARANTIZADO
// ============================================
function crearPeerConnection(targetId) {
    console.log(`🔗 Creando conexión con: ${targetId}`);
    
    limpiarPeer(targetId);
    
    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: isMobile ? 5 : 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        iceTransportPolicy: "all"
    });

    // ============================================
    // 🔥 CRÍTICO: GARANTIZAR QUE HAYA AUDIO
    // ============================================
    if (streamLocal) {
        let audioTracks = streamLocal.getAudioTracks();
        let videoTracks = streamLocal.getVideoTracks();
        console.log(`📹 Tracks locales: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
        
        // 🔥 Si NO hay audio tracks, crear uno silencioso
        if (audioTracks.length === 0) {
            console.warn('⚠️ NO HAY AUDIO LOCAL - Creando track silencioso');
            const silentTrack = crearTrackAudioSilencioso();
            if (silentTrack) {
                // Agregar el track silencioso al stream local
                streamLocal.addTrack(silentTrack);
                audioTracks = streamLocal.getAudioTracks();
                console.log(`✅ Track silencioso agregado. Audio ahora: ${audioTracks.length}`);
                audioTrackCreated = true;
            }
        }
        
        // 🔥 Habilitar TODOS los tracks de audio
        audioTracks.forEach(track => {
            track.enabled = true;
            console.log(`🎤 Audio local habilitado: ${track.label}`);
        });
        
        // 🔥 Agregar TODOS los tracks
        streamLocal.getTracks().forEach(track => {
            try {
                const sender = pc.addTrack(track, streamLocal);
                console.log(`✅ Track agregado: ${track.kind} (${track.label})`);
            } catch (error) {
                console.error(`❌ Error agregando track ${track.kind}:`, error);
            }
        });
        
        // 🔥 VERIFICAR SENDERS
        const senders = pc.getSenders();
        console.log(`📤 Senders: ${senders.length}`);
        const hasAudio = senders.some(s => s.track && s.track.kind === 'audio');
        const hasVideo = senders.some(s => s.track && s.track.kind === 'video');
        console.log(`   Audio sender: ${hasAudio ? '✅' : '❌'}`);
        console.log(`   Video sender: ${hasVideo ? '✅' : '❌'}`);
        
        // 🔥 SI NO HAY AUDIO, FORZAR AGREGADO
        if (!hasAudio) {
            console.error('❌ CRÍTICO: No hay sender de audio - FORZANDO...');
            // Intentar con cada track de audio
            audioTracks.forEach(track => {
                try {
                    track.enabled = true;
                    const sender = pc.addTrack(track, streamLocal);
                    console.log(`✅ Audio forzado: ${track.label} - Sender: ${sender ? 'OK' : 'FALLÓ'}`);
                } catch (e) {
                    console.error('❌ Error forzando audio:', e);
                }
            });
            
            // Verificar nuevamente
            const senders2 = pc.getSenders();
            const hasAudio2 = senders2.some(s => s.track && s.track.kind === 'audio');
            console.log(`   Audio después de forzar: ${hasAudio2 ? '✅' : '❌'}`);
        }
    } else {
        console.warn('⚠️ No hay streamLocal');
    }

    pc.ontrack = (event) => {
        console.log(`📥 Track remoto recibido: ${event.track.kind} (${event.track.label})`);
        
        if (event.track.kind === 'audio') {
            event.track.enabled = true;
            console.log(`🎵 Track de audio remoto habilitado`);
        }
        
        if (event.streams && event.streams[0]) {
            const stream = event.streams[0];
            if (stream === streamLocal) {
                console.warn('⚠️ Ignorando stream local');
                return;
            }
            
            const audioTracks = stream.getAudioTracks();
            const videoTracks = stream.getVideoTracks();
            console.log(`📦 Stream recibido: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
            
            audioTracks.forEach(t => {
                t.enabled = true;
                console.log(`   🎵 Track de audio remoto: ${t.label}`);
            });
            
            mostrarVideoRemoto(stream, targetId);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit("ice-candidate", { target: targetId, candidate: event.candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`🔗 ICE con ${targetId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === "connected") {
            console.log(`✅ ICE conectado`);
            connectionAttempts = 0;
        }
        if (pc.iceConnectionState === "failed") {
            console.log(`❌ ICE falló`);
            handleConnectionFailure(targetId);
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado con ${targetId}: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            console.log(`✅ CONEXIÓN ESTABLECIDA!`);
            actualizarEstado(`🟢 Conectado`, "conectado");
            actualizarInfoPeer(targetId);
            isConnecting = false;
            connectionAttempts = 0;
        } else if (pc.connectionState === "failed") {
            console.log(`❌ Conexión fallida`);
            handleConnectionFailure(targetId);
        }
    };

    pc.onnegotiationneeded = () => {
        console.log(`🤝 Negociación necesaria`);
        const senders = pc.getSenders();
        const hasAudio = senders.some(s => s.track && s.track.kind === 'audio');
        console.log(`   Audio en negociación: ${hasAudio ? '✅' : '❌'}`);
        
        if (!hasAudio && streamLocal) {
            console.warn('⚠️ Negociación sin audio - FORZANDO...');
            streamLocal.getAudioTracks().forEach(track => {
                try {
                    track.enabled = true;
                    pc.addTrack(track, streamLocal);
                    console.log(`✅ Audio forzado en negociación: ${track.label}`);
                } catch (e) {
                    console.error('❌ Error en negociación:', e);
                }
            });
        }
    };

    pc._pendingCandidates = [];
    peers[targetId] = pc;
    return pc;
}

function handleConnectionFailure(targetId) {
    if (peerIdRemoto === targetId) {
        ocultarVideoRemoto();
    }
    limpiarPeer(targetId);
    isConnecting = false;
    
    connectionAttempts++;
    if (connectionAttempts <= MAX_CONNECTION_ATTEMPTS) {
        console.log(`🔄 Reintento ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS} en 5 segundos...`);
        setTimeout(() => {
            if (!peers[targetId]) {
                socket.emit("clientes-conectados");
            }
        }, 5000);
    } else {
        console.log(`❌ Máximo de intentos`);
        connectionAttempts = 0;
        actualizarEstado("🔴 Error de conexión", "error");
    }
}

function iniciarOferta(targetId, pc) {
    console.log(`📤 Iniciando oferta para ${targetId}`);
    
    if (!pc || pc.signalingState === 'closed') {
        console.warn(`⚠️ PC cerrado`);
        limpiarPeer(targetId);
        isConnecting = false;
        return;
    }
    
    // 🔥 Verificar senders
    const senders = pc.getSenders();
    const hasAudio = senders.some(s => s.track && s.track.kind === 'audio');
    console.log(`📤 Senders: ${senders.length}, Audio: ${hasAudio ? '✅' : '❌'}`);
    
    if (!hasAudio && streamLocal) {
        console.warn('⚠️ Sin audio - FORZANDO antes de ofertar');
        streamLocal.getAudioTracks().forEach(track => {
            try {
                track.enabled = true;
                pc.addTrack(track, streamLocal);
                console.log(`✅ Audio forzado antes de ofertar: ${track.label}`);
            } catch (e) {
                console.error('❌ Error:', e);
            }
        });
    }
    
    pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
    })
    .then(offer => {
        // 🔥 Verificar que el SDP contenga audio
        const hasAudioInSDP = offer.sdp ? offer.sdp.includes('m=audio') : false;
        console.log(`📝 SDP contiene audio? ${hasAudioInSDP ? '✅' : '❌'}`);
        if (!hasAudioInSDP) {
            console.error('❌ EL SDP NO CONTIENE AUDIO - El otro lado NO te escuchará');
            // Reintentar con forzado
            if (streamLocal) {
                streamLocal.getAudioTracks().forEach(track => {
                    track.enabled = true;
                    try {
                        pc.addTrack(track, streamLocal);
                        console.log(`✅ Audio forzado en SDP: ${track.label}`);
                    } catch (e) {}
                });
                // Recrear oferta
                return pc.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: true
                });
            }
        }
        return offer;
    })
    .then(offer => pc.setLocalDescription(offer))
    .then(() => {
        socket.emit("offer", { target: targetId, offer: pc.localDescription });
        console.log(`✅ Oferta enviada a ${targetId}`);
    })
    .catch(error => {
        console.error(`❌ Error creando oferta:`, error);
        limpiarPeer(targetId);
        isConnecting = false;
    });
}

function conectarConTodos(clientes) {
    if (isConnecting) {
        console.log(`⏳ Conexión en proceso...`);
        return;
    }
    
    const otros = clientes.filter(id => id !== socket.id);
    if (otros.length === 0) {
        console.log("⏳ No hay otros clientes");
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
        actualizarInfoPeer(null);
        return;
    }
    
    const targetId = otros[0];
    console.log(`🎯 Conectando con: ${targetId}`);
    
    if (peers[targetId]) {
        const state = peers[targetId].connectionState;
        if (state === "connected") {
            console.log(`✅ Ya conectado`);
            actualizarInfoPeer(targetId);
            return;
        }
        if (state === "connecting") {
            console.log(`⏳ Conectando...`);
            return;
        }
        limpiarPeer(targetId);
    }
    
    isConnecting = true;
    const pc = crearPeerConnection(targetId);
    
    setTimeout(() => {
        if (pc.signalingState === 'closed') {
            console.warn(`⚠️ PC cerrado`);
            limpiarPeer(targetId);
            isConnecting = false;
            return;
        }
        iniciarOferta(targetId, pc);
    }, isMobile ? 1000 : 500);
}

// ============================================
// 📡 Eventos Socket.IO
// ============================================

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);
    console.log(`🔍 SDP contiene audio? ${offer.sdp ? offer.sdp.includes('m=audio') : 'N/A'}`);
    
    try {
        limpiarPeer(from);
        const pc = crearPeerConnection(from);
        
        if (pc.signalingState === 'closed') {
            console.warn(`⚠️ PC cerrado`);
            limpiarPeer(from);
            isConnecting = false;
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida`);
        
        if (pc._pendingCandidates && pc._pendingCandidates.length > 0) {
            console.log(`📦 Aplicando ${pc._pendingCandidates.length} candidatos`);
            for (const candidate of pc._pendingCandidates) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {
                    console.warn(`⚠️ Error en candidate:`, e.message);
                }
            }
            pc._pendingCandidates = [];
        }

        const answer = await pc.createAnswer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(answer);

        socket.emit("answer", { target: from, answer: pc.localDescription });
        console.log(`✅ Respuesta enviada a: ${from}`);
        isConnecting = false;
        connectionAttempts = 0;
    } catch (error) {
        console.error(`❌ Error manejando oferta:`, error);
        limpiarPeer(from);
        isConnecting = false;
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA RECIBIDA DE: ${from}`);
    
    if (isProcessingAnswer[from]) {
        console.log(`⏳ Procesando...`);
        return;
    }
    
    const pc = peers[from];
    if (!pc) {
        console.log(`⚠️ No hay peer`);
        return;
    }

    if (pc.signalingState === 'closed') {
        console.log(`⚠️ PC cerrado`);
        limpiarPeer(from);
        return;
    }

    if (pc.signalingState === 'stable') {
        console.log(`ℹ️ Estado stable`);
        return;
    }

    if (pc.signalingState !== 'have-local-offer') {
        console.log(`⚠️ Estado incorrecto: ${pc.signalingState}`);
        limpiarPeer(from);
        isConnecting = false;
        setTimeout(() => socket.emit("clientes-conectados"), 2000);
        return;
    }

    isProcessingAnswer[from] = true;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida`);
        isConnecting = false;
        connectionAttempts = 0;
    } catch (error) {
        console.error(`❌ Error procesando respuesta:`, error);
        limpiarPeer(from);
        isConnecting = false;
        setTimeout(() => socket.emit("clientes-conectados"), 2000);
    } finally {
        delete isProcessingAnswer[from];
    }
});

socket.on("ice-candidate", async (data) => {
    const { from, candidate } = data;
    const pc = peers[from];
    if (!pc) {
        console.log(`⚠️ No hay peer`);
        return;
    }

    try {
        if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log(`✅ ICE Candidate agregado`);
        } else {
            console.log(`⏳ Guardando candidate`);
            if (!pc._pendingCandidates) pc._pendingCandidates = [];
            pc._pendingCandidates.push(candidate);
        }
    } catch (error) {
        console.warn(`⚠️ Error ICE:`, error.message);
    }
});

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    isConnecting = false;
    connectionAttempts = 0;
    actualizarEstado("🟢 Conectado", "conectado");
    actualizarInfoPeer(null);
    await obtenerTurnServers();
    await audioController.init();
    
    if (streamLocal) {
        streamLocal.getAudioTracks().forEach(track => {
            track.enabled = true;
            console.log(`🎤 Audio local habilitado: ${track.label}`);
        });
    }
    
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Lista de clientes recibida:", lista);
    
    const clientesActuales = new Set(lista);
    Object.keys(peers).forEach(id => {
        if (!clientesActuales.has(id) && id !== socket.id) {
            limpiarPeer(id);
        }
    });
    
    if (!isConnecting) {
        conectarConTodos(lista);
    }
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente:", data.id);
    isConnecting = false;
    setTimeout(() => socket.emit("clientes-conectados"), 1500);
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    limpiarPeer(data.id);
    if (peerIdRemoto === data.id) {
        ocultarVideoRemoto();
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
        actualizarInfoPeer(null);
    }
    isConnecting = false;
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    isConnecting = false;
    actualizarEstado("🔴 Reconectando...", "desconectado");
    ocultarVideoRemoto();
    Object.keys(peers).forEach(key => limpiarPeer(key));
    actualizarInfoPeer(null);
});

// ============================================
// 🎬 Iniciar Cámara
// ============================================

async function iniciarCamara() {
    try {
        console.log("📷 Solicitando cámara...");
        
        const constraints = {
            video: {
                width: { ideal: isMobile ? 480 : 640 },
                height: { ideal: isMobile ? 360 : 480 },
                facingMode: 'user'
            },
            audio: {
                echoCancellation: !isiOS,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: isMobile ? 16000 : 44100,
                channelCount: 1
            }
        };
        
        if (isiOS) {
            constraints.video = { facingMode: 'user' };
            constraints.audio = { echoCancellation: false };
        }
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamLocal = stream;
        
        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        console.log(`📊 Stream local: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
        
        if (audioTracks.length === 0) {
            console.warn('⚠️ NO HAY AUDIO - Creando track silencioso');
            const silentTrack = crearTrackAudioSilencioso();
            if (silentTrack) {
                streamLocal.addTrack(silentTrack);
                console.log('✅ Track silencioso agregado');
                audioTrackCreated = true;
            }
        }
        
        audioTracks.forEach(track => {
            track.enabled = true;
            console.log(`🎤 Audio local: ${track.label}`);
        });
        
        videoTracks.forEach(track => {
            track.enabled = true;
            console.log(`📹 Video local: ${track.label}`);
        });
        
        video.srcObject = stream;
        video.style.display = "block";
        video.muted = true;
        video.volume = 0;
        
        if (isMobile) {
            video.setAttribute('playsinline', 'true');
            video.setAttribute('webkit-playsinline', 'true');
        }
        
        try {
            await video.play();
            console.log("📹 Cámara local iniciada");
        } catch (e) {
            console.warn("⚠️ Error en video local:", e.message);
        }
        
        await obtenerTurnServers();
        await audioController.init();
        isConnecting = false;
        connectionAttempts = 0;
        setTimeout(() => socket.emit("clientes-conectados"), 1000);
    } catch (error) {
        console.error("❌ Error al acceder a cámara:", error);
        alert("⚠️ No se pudo acceder a la cámara/micrófono.\n\n" + error.message);
        actualizarEstado("🔴 Error", "desconectado");
        isConnecting = false;
    }
}

// ============================================
// 🎛️ UI Controles
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    const controlVolumen = document.getElementById('volumen');
    const labelVolumen = document.getElementById('volumen-label');
    const btnSilenciar = document.getElementById('btn-silenciar');
    const btnReconectar = document.getElementById('btn-reconectar');
    const btnToggleCamara = document.getElementById('btn-camara');
    const btnToggleMicrofono = document.getElementById('btn-microfono');
    const btnFullscreen = document.getElementById('btn-fullscreen');
    const btnDiagnostico = document.getElementById('btn-diagnostico');
    
    if (controlVolumen) {
        controlVolumen.value = 0.3;
        controlVolumen.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            if (peerIdRemoto) {
                audioController.setVolume(peerIdRemoto, vol);
                videoRemoto.volume = vol;
            }
            if (labelVolumen) labelVolumen.textContent = `${Math.round(vol * 100)}%`;
        });
    }
    
    if (btnSilenciar) {
        let silenciado = false;
        btnSilenciar.addEventListener('click', () => {
            silenciado = !silenciado;
            videoRemoto.muted = silenciado;
            if (peerIdRemoto) {
                audioController.muteAudio(peerIdRemoto, silenciado);
            }
            btnSilenciar.textContent = silenciado ? '🔊 Activar' : '🔇 Silenciar';
            btnSilenciar.classList.toggle('silenciado', silenciado);
        });
    }
    
    if (btnToggleMicrofono) {
        let microfonoActivo = true;
        btnToggleMicrofono.addEventListener('click', () => {
            microfonoActivo = !microfonoActivo;
            if (streamLocal) {
                streamLocal.getAudioTracks().forEach(track => {
                    track.enabled = microfonoActivo;
                    console.log(`🎤 Micrófono ${microfonoActivo ? 'activado' : 'silenciado'}`);
                });
            }
            btnToggleMicrofono.textContent = microfonoActivo ? '🎤 Micrófono' : '🎤 Silenciado';
            btnToggleMicrofono.classList.toggle('activo', microfonoActivo);
            btnToggleMicrofono.classList.toggle('inactivo', !microfonoActivo);
        });
        btnToggleMicrofono.classList.add('activo');
    }
    
    if (btnToggleCamara) {
        let camaraActiva = true;
        btnToggleCamara.addEventListener('click', () => {
            camaraActiva = !camaraActiva;
            if (streamLocal) {
                streamLocal.getVideoTracks().forEach(track => {
                    track.enabled = camaraActiva;
                });
            }
            video.style.display = camaraActiva ? 'block' : 'none';
            btnToggleCamara.textContent = camaraActiva ? '📷 Cámara' : '📷 Apagada';
            btnToggleCamara.classList.toggle('activo', camaraActiva);
            btnToggleCamara.classList.toggle('inactivo', !camaraActiva);
        });
        btnToggleCamara.classList.add('activo');
    }
    
    if (btnFullscreen) {
        btnFullscreen.addEventListener('click', () => {
            const videoElement = document.getElementById('video-remoto');
            if (videoElement.requestFullscreen) {
                videoElement.requestFullscreen();
            } else if (videoElement.webkitRequestFullscreen) {
                videoElement.webkitRequestFullscreen();
            }
        });
    }
    
    if (btnDiagnostico) {
        let visible = false;
        btnDiagnostico.addEventListener('click', () => {
            visible = !visible;
            if (visible) {
                mostrarDiagnostico();
                btnDiagnostico.classList.add('activo');
            } else {
                ocultarDiagnostico();
                btnDiagnostico.classList.remove('activo');
            }
        });
    }
    
    if (btnReconectar) {
        btnReconectar.addEventListener('click', () => {
            console.log("🔄 Reconectando...");
            isConnecting = false;
            connectionAttempts = 0;
            ocultarVideoRemoto();
            Object.keys(peers).forEach(key => limpiarPeer(key));
            audioController.destroyAll();
            socket.disconnect();
            setTimeout(() => socket.connect(), 1000);
            actualizarEstado("🔄 Reconectando...", "inicializando");
        });
    }
    
    if (isiOS) {
        document.addEventListener('touchstart', () => {
            audioController.resumeContext();
        }, { once: true });
    }
});

// ============================================
// 📊 Diagnóstico
// ============================================

function mostrarDiagnostico() {
    let badge = document.querySelector('.diagnostico-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'diagnostico-badge';
        document.body.appendChild(badge);
    }
    
    const peerIds = Object.keys(peers);
    const activePeers = peerIds.filter(id => {
        const pc = peers[id];
        return pc && pc.connectionState === 'connected';
    });
    
    const audioTracksLocal = streamLocal ? streamLocal.getAudioTracks() : [];
    const tieneAudioLocal = audioTracksLocal.some(t => t.enabled);
    const tieneVideoLocal = streamLocal && streamLocal.getVideoTracks().some(t => t.enabled);
    
    let tieneAudioRemoto = false;
    let audioTracksRemoto = 0;
    if (peerIdRemoto && videoRemoto.srcObject) {
        audioTracksRemoto = videoRemoto.srcObject.getAudioTracks().length;
        tieneAudioRemoto = audioTracksRemoto > 0;
    }
    
    let audioSenders = 0;
    let videoSenders = 0;
    if (peerIdRemoto && peers[peerIdRemoto]) {
        const senders = peers[peerIdRemoto].getSenders();
        audioSenders = senders.filter(s => s.track && s.track.kind === 'audio').length;
        videoSenders = senders.filter(s => s.track && s.track.kind === 'video').length;
    }
    
    badge.innerHTML = `
        <div class="info-line">
            <span class="label">🔗 Socket ID:</span>
            <span class="value">${socket.id ? socket.id.substring(0, 8) : 'N/A'}</span>
        </div>
        <div class="info-line">
            <span class="label">📡 Conexiones:</span>
            <span class="value ${activePeers.length === 0 ? 'warning' : ''}">${activePeers.length} / ${peerIds.length}</span>
        </div>
        <div class="info-line">
            <span class="label">🎤 Micrófono LOCAL:</span>
            <span class="value ${!tieneAudioLocal ? 'error' : ''}">${tieneAudioLocal ? '✅ Activo' : '❌ Silenciado'}</span>
        </div>
        <div class="info-line">
            <span class="label">📤 Envío de audio:</span>
            <span class="value ${audioSenders === 0 ? 'error' : ''}">${audioSenders > 0 ? `✅ ${audioSenders} sender` : '❌ Sin sender'}</span>
        </div>
        <div class="info-line">
            <span class="label">🎵 Audio REMOTO:</span>
            <span class="value ${!tieneAudioRemoto ? 'error' : ''}">${tieneAudioRemoto ? `✅ ${audioTracksRemoto} tracks` : '❌ Solo video'}</span>
        </div>
        <div class="info-line" style="border-bottom: none;">
            <span class="label">📹 Video REMOTO:</span>
            <span class="value">${videoRemoto.srcObject ? '✅ Activo' : '❌ Inactivo'}</span>
        </div>
    `;
    badge.classList.add('visible');
}

function ocultarDiagnostico() {
    const badge = document.querySelector('.diagnostico-badge');
    if (badge) {
        badge.classList.remove('visible');
    }
}

// ============================================
// 🚀 Inicialización
// ============================================

window.addEventListener("load", () => {
    console.log("🚀 Iniciando Ventana Digital...");
    iniciarCamara();
});

window.addEventListener("beforeunload", () => {
    Object.keys(peers).forEach(key => limpiarPeer(key));
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
    audioController.destroyAll();
});

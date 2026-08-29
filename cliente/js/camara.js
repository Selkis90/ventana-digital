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
let reconnectAttempts = 0;
let audioEnabled = true;

// ============================================
// 🔊 CONTROL DE AUDIO - SOLO REPRODUCCIÓN REMOTA
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
            
            // IGNORAR EL STREAM LOCAL - SOLO REPRODUCIR REMOTO
            if (stream === streamLocal) {
                console.log(`⚠️ Ignorando stream local en audio remoto`);
                return false;
            }
            
            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) {
                console.log(`ℹ️ No hay audio en stream para ${peerId}`);
                return false;
            }

            audioTracks.forEach(track => {
                if (!track.enabled) {
                    track.enabled = true;
                    console.log(`🎵 Habilitando track de audio remoto: ${track.label}`);
                }
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
            
            console.log(`✅ Audio remoto creado para peer ${peerId}`);
            return true;
        } catch (error) {
            console.error(`❌ Error creando audio para ${peerId}:`, error);
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
            console.log(`🗑️ Audio remoto destruido para peer ${peerId}`);
        }
    }

    destroyAll() {
        for (const [peerId, audioData] of this.audioContexts) {
            try {
                audioData.source.disconnect();
            } catch (e) {}
        }
        this.audioContexts.clear();
        console.log('🗑️ Todos los audios remotos destruidos');
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

// CRÍTICO: Video local SIEMPRE muteado para evitar eco
video.muted = true;
video.volume = 0;

// Video remoto NO muteado para escuchar al otro
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
    if (!stream) return;
    
    // CRÍTICO: IGNORAR EL STREAM LOCAL
    if (stream === streamLocal) {
        console.warn('⚠️ Ignorando stream local en video remoto');
        return;
    }
    
    peerIdRemoto = peerId;
    actualizarInfoPeer(peerId);
    
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`🎵 Audio remoto: ${audioTracks.length}, Video remoto: ${videoTracks.length}`);
    
    audioTracks.forEach(track => {
        if (!track.enabled) {
            track.enabled = true;
            console.log(`🎵 Habilitando track de audio remoto: ${track.label}`);
        }
    });
    
    if (videoRemoto.srcObject === stream) {
        console.log(`ℹ️ Stream ya asignado a video-remoto`);
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
            console.log(`✅ Video remoto de ${peerId} reproduciendo`);
            
            await new Promise(resolve => setTimeout(resolve, 200));
            await audioController.init();
            const audioCreated = audioController.createAudioForPeer(peerId, stream);
            
            if (audioCreated) {
                audioController.setVolume(peerId, 0.3);
                console.log(`✅ Audio remoto configurado para ${peerId}`);
            }
            
            actualizarEstado(`🟢 Conectado`, "conectado");
            isConnecting = false;
        } catch (error) {
            console.warn(`⚠️ Error al reproducir video remoto:`, error.message);
            setTimeout(() => {
                videoRemoto.play()
                    .then(() => {
                        console.log(`✅ Video remoto reproducido en reintento`);
                        audioController.createAudioForPeer(peerId, stream);
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
// 🔥 CRÍTICO: CREACIÓN DE PEER CON ENVÍO DE AUDIO
// ============================================
function crearPeerConnection(targetId, iceRestart = false) {
    console.log(`🔗 Creando conexión con: ${targetId} (iceRestart: ${iceRestart})`);
    
    limpiarPeer(targetId);
    
    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: isMobile ? 5 : 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        iceTransportPolicy: "all"
    });

    // ============================================
    // 🔥🔥🔥 CRÍTICO: AGREGAR TRACKS LOCALES CORRECTAMENTE
    // ============================================
    if (streamLocal) {
        const audioTracks = streamLocal.getAudioTracks();
        const videoTracks = streamLocal.getVideoTracks();
        console.log(`📹 Tracks locales: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
        
        // 🔥 CRÍTICO: Asegurar que el audio esté habilitado
        audioTracks.forEach(track => {
            track.enabled = true;
            console.log(`🎤 Track de audio local habilitado para envío: ${track.label}`);
        });
        
        // 🔥 CRÍTICO: Agregar TODOS los tracks (audio y video)
        streamLocal.getTracks().forEach(track => {
            try {
                const sender = pc.addTrack(track, streamLocal);
                console.log(`✅ Track local agregado: ${track.kind} (${track.label}) - Sender: ${sender ? 'OK' : 'FALLÓ'}`);
            } catch (error) {
                console.error(`❌ Error agregando track ${track.kind}:`, error);
            }
        });
        
        // 🔥 VERIFICAR QUE LOS SENDERS SE CREARON
        const senders = pc.getSenders();
        console.log(`📤 Senders en peer: ${senders.length}`);
        senders.forEach((s, i) => {
            console.log(`   Sender ${i}: ${s.track ? s.track.kind : 'sin track'} (${s.track ? s.track.label : 'N/A'}) - ${s.track ? s.track.enabled : 'N/A'}`);
        });
        
        // 🔥 SI NO HAY SENDERS DE AUDIO, REINTENTAR
        const hasAudioSender = senders.some(s => s.track && s.track.kind === 'audio');
        if (!hasAudioSender && audioTracks.length > 0) {
            console.warn('⚠️ No hay sender de audio, reintentando...');
            audioTracks.forEach(track => {
                try {
                    const sender = pc.addTrack(track, streamLocal);
                    console.log(`✅ Track de audio agregado en reintento: ${track.label} - Sender: ${sender ? 'OK' : 'FALLÓ'}`);
                } catch (e) {
                    console.error('❌ Error en reintento de audio:', e);
                }
            });
        }
    } else {
        console.warn('⚠️ No hay streamLocal disponible');
    }

    pc.ontrack = (event) => {
        console.log(`📥 Track remoto recibido: ${event.track.kind} (${event.track.label})`);
        
        if (event.track.kind === 'audio') {
            console.log(`🎵 Track de audio remoto recibido, enabled: ${event.track.enabled}`);
            event.track.enabled = true;
        }
        
        if (event.streams && event.streams[0]) {
            const stream = event.streams[0];
            // 🔥 IGNORAR STREAM LOCAL
            if (stream === streamLocal) {
                console.warn('⚠️ Ignorando stream local en ontrack');
                return;
            }
            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length > 0) {
                console.log(`🎵 Stream remoto tiene ${audioTracks.length} tracks de audio`);
                audioTracks.forEach(t => {
                    t.enabled = true;
                    console.log(`🎵 Track de audio remoto habilitado: ${t.label}`);
                });
            }
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
        if (pc.iceConnectionState === "failed") {
            console.log(`❌ ICE falló con ${targetId}, reiniciando...`);
            setTimeout(() => {
                if (peers[targetId]) {
                    limpiarPeer(targetId);
                    isConnecting = false;
                    setTimeout(() => socket.emit("clientes-conectados"), 2000);
                }
            }, 3000);
        }
        if (pc.iceConnectionState === "connected") {
            console.log(`✅ ICE conectado con ${targetId}`);
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado con ${targetId}: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            console.log(`✅ CONEXIÓN ESTABLECIDA con ${targetId}!`);
            actualizarEstado(`🟢 Conectado`, "conectado");
            actualizarInfoPeer(targetId);
            isConnecting = false;
        } else if (pc.connectionState === "failed") {
            console.log(`❌ Conexión fallida con ${targetId}`);
            if (peerIdRemoto === targetId) {
                ocultarVideoRemoto();
            }
            limpiarPeer(targetId);
            isConnecting = false;
            setTimeout(() => {
                if (!peers[targetId]) {
                    socket.emit("clientes-conectados");
                }
            }, 5000);
        }
    };

    pc.onnegotiationneeded = () => {
        console.log(`🤝 Negociación necesaria con ${targetId}`);
        const senders = pc.getSenders();
        console.log(`📤 Senders en negociación: ${senders.length}`);
        senders.forEach(s => {
            console.log(`   - ${s.track ? s.track.kind : 'sin track'} (${s.track ? s.track.label : 'N/A'})`);
        });
    };

    pc._pendingCandidates = [];
    peers[targetId] = pc;
    return pc;
}

function iniciarOferta(targetId, pc) {
    console.log(`📤 Iniciando oferta para ${targetId}`);
    
    if (!pc || pc.signalingState === 'closed') {
        console.warn(`⚠️ PC cerrado o inexistente para ${targetId}`);
        limpiarPeer(targetId);
        return;
    }
    
    // 🔥 VERIFICAR SENDERS ANTES DE CREAR OFERTA
    const senders = pc.getSenders();
    console.log(`📤 Senders antes de createOffer: ${senders.length}`);
    const hasAudio = senders.some(s => s.track && s.track.kind === 'audio');
    const hasVideo = senders.some(s => s.track && s.track.kind === 'video');
    console.log(`   Audio sender: ${hasAudio ? '✅' : '❌'}, Video sender: ${hasVideo ? '✅' : '❌'}`);
    
    if (!hasAudio) {
        console.warn('⚠️ No hay sender de audio, el otro lado NO te escuchará!');
        // Reintentar agregar audio
        if (streamLocal) {
            const audioTracks = streamLocal.getAudioTracks();
            audioTracks.forEach(track => {
                try {
                    track.enabled = true;
                    pc.addTrack(track, streamLocal);
                    console.log(`✅ Track de audio agregado en último intento: ${track.label}`);
                } catch (e) {
                    console.error('❌ Error agregando audio en último intento:', e);
                }
            });
        }
    }
    
    pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
    })
    .then(offer => pc.setLocalDescription(offer))
    .then(() => {
        socket.emit("offer", { target: targetId, offer: pc.localDescription });
        console.log(`✅ Oferta enviada a ${targetId}`);
    })
    .catch(error => {
        console.error(`❌ Error creando oferta para ${targetId}:`, error);
        limpiarPeer(targetId);
        isConnecting = false;
    });
}

function conectarConTodos(clientes) {
    if (isConnecting) {
        console.log(`⏳ Ya hay una conexión en proceso, esperando...`);
        return;
    }
    
    console.log("🔄 CONECTANDO CON TODOS...");
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
            console.log(`✅ Ya conectado con ${targetId}`);
            actualizarInfoPeer(targetId);
            return;
        }
        if (state === "connecting") {
            console.log(`⏳ Conectando con ${targetId}...`);
            return;
        }
        limpiarPeer(targetId);
    }
    
    isConnecting = true;
    const pc = crearPeerConnection(targetId);
    
    // Esperar a que los tracks se agreguen
    setTimeout(() => {
        if (pc.signalingState === 'closed') {
            console.warn(`⚠️ PC cerrado, no se puede crear oferta para ${targetId}`);
            limpiarPeer(targetId);
            isConnecting = false;
            return;
        }
        iniciarOferta(targetId, pc);
    }, isMobile ? 1500 : 800);
}

// ============================================
// 📡 Eventos Socket.IO
// ============================================

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);
    
    try {
        limpiarPeer(from);
        
        const pc = crearPeerConnection(from);
        
        if (pc.signalingState === 'closed') {
            console.warn(`⚠️ PC cerrado, no se puede procesar oferta de ${from}`);
            limpiarPeer(from);
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida (oferta) de ${from}`);
        
        if (pc._pendingCandidates && pc._pendingCandidates.length > 0) {
            console.log(`📦 Aplicando ${pc._pendingCandidates.length} candidatos pendientes`);
            for (const candidate of pc._pendingCandidates) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {
                    console.warn(`⚠️ Error agregando candidate pendiente:`, e.message);
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
    } catch (error) {
        console.error(`❌ Error manejando oferta de ${from}:`, error);
        limpiarPeer(from);
        isConnecting = false;
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA RECIBIDA DE: ${from}`);
    
    if (isProcessingAnswer[from]) {
        console.log(`⏳ Ya procesando respuesta de ${from}`);
        return;
    }
    
    const pc = peers[from];
    if (!pc) {
        console.log(`⚠️ No hay peer para ${from}, ignorando respuesta`);
        return;
    }

    if (pc.signalingState === 'closed') {
        console.log(`⚠️ PC cerrado para ${from}, ignorando respuesta`);
        limpiarPeer(from);
        return;
    }

    if (pc.signalingState === 'stable') {
        console.log(`ℹ️ Respuesta normal en estado stable, ignorando`);
        return;
    }

    if (pc.signalingState !== 'have-local-offer') {
        console.log(`⚠️ Estado incorrecto: ${pc.signalingState} para ${from}`);
        limpiarPeer(from);
        isConnecting = false;
        setTimeout(() => socket.emit("clientes-conectados"), 2000);
        return;
    }

    isProcessingAnswer[from] = true;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida de ${from}`);
        isConnecting = false;
    } catch (error) {
        console.error(`❌ Error procesando respuesta de ${from}:`, error);
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
        console.log(`⚠️ No hay peer para ${from}, ignorando ICE candidate`);
        return;
    }

    try {
        if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log(`✅ ICE Candidate agregado de: ${from}`);
        } else {
            console.log(`⏳ Descripción remota no lista para ${from}, guardando candidate`);
            if (!pc._pendingCandidates) pc._pendingCandidates = [];
            pc._pendingCandidates.push(candidate);
        }
    } catch (error) {
        console.warn(`⚠️ Error ICE para ${from}:`, error.message);
    }
});

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    reconnectAttempts = 0;
    isConnecting = false;
    actualizarEstado("🟢 Conectado", "conectado");
    actualizarInfoPeer(null);
    await obtenerTurnServers();
    await audioController.init();
    
    if (streamLocal) {
        streamLocal.getAudioTracks().forEach(track => {
            track.enabled = true;
            console.log(`🎤 Audio local habilitado en reconexión: ${track.label}`);
        });
    }
    
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Lista de clientes recibida:", lista);
    
    const clientesActuales = new Set(lista);
    Object.keys(peers).forEach(id => {
        if (!clientesActuales.has(id) && id !== socket.id) {
            console.log(`🧹 Limpiando peer antiguo: ${id}`);
            limpiarPeer(id);
        }
    });
    
    conectarConTodos(lista);
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
    reconnectAttempts++;
    isConnecting = false;
    actualizarEstado(`🔴 Reconectando... (${reconnectAttempts})`, "desconectado");
    ocultarVideoRemoto();
    Object.keys(peers).forEach(key => limpiarPeer(key));
    actualizarInfoPeer(null);
});

socket.on("connect_error", (error) => {
    console.error("❌ Error de conexión:", error);
    actualizarEstado("🔴 Error de conexión", "desconectado");
    isConnecting = false;
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
        
        // 🔥 CRÍTICO: Asegurar que el audio esté habilitado
        const audioTracks = stream.getAudioTracks();
        console.log(`🎤 Tracks de audio locales: ${audioTracks.length}`);
        audioTracks.forEach(track => {
            track.enabled = true;
            console.log(`🎤 Audio local habilitado: ${track.label}`);
            console.log(`   - Estado: ${track.readyState}, Enabled: ${track.enabled}`);
        });
        
        const videoTracks = stream.getVideoTracks();
        console.log(`📹 Tracks de video locales: ${videoTracks.length}`);
        videoTracks.forEach(track => {
            track.enabled = true;
            console.log(`📹 Video local habilitado: ${track.label}`);
        });
        
        // Mostrar video local (muteado para evitar eco)
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
            console.log("📹 Cámara local iniciada (muteada)");
        } catch (e) {
            console.warn("⚠️ Error al iniciar video local:", e.message);
        }
        
        await obtenerTurnServers();
        await audioController.init();
        isConnecting = false;
        
        // Verificar que el audio sigue habilitado
        setTimeout(() => {
            if (streamLocal) {
                streamLocal.getAudioTracks().forEach(track => {
                    console.log(`🎤 Verificación: ${track.label} - Enabled: ${track.enabled}`);
                });
            }
        }, 2000);
        
        setTimeout(() => socket.emit("clientes-conectados"), 1000);
    } catch (error) {
        console.error("❌ Error al acceder a cámara:", error);
        alert("⚠️ No se pudo acceder a la cámara/micrófono.");
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
    
    // Control de volumen (audio remoto)
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
    
    // Silenciar audio REMOTO (lo que escuchas del otro)
    if (btnSilenciar) {
        let silenciado = false;
        btnSilenciar.addEventListener('click', () => {
            silenciado = !silenciado;
            videoRemoto.muted = silenciado;
            if (peerIdRemoto) {
                audioController.muteAudio(peerIdRemoto, silenciado);
            }
            btnSilenciar.textContent = silenciado ? '🔊 Activar sonido' : '🔇 Silenciar';
            btnSilenciar.classList.toggle('silenciado', silenciado);
        });
    }
    
    // 🔥 CONTROL DE MICRÓFONO LOCAL (ENVÍO DE AUDIO)
    if (btnToggleMicrofono) {
        let microfonoActivo = true;
        btnToggleMicrofono.addEventListener('click', () => {
            microfonoActivo = !microfonoActivo;
            audioEnabled = microfonoActivo;
            
            if (streamLocal) {
                streamLocal.getAudioTracks().forEach(track => {
                    track.enabled = microfonoActivo;
                    console.log(`🎤 Micrófono local ${microfonoActivo ? 'activado' : 'silenciado'}: ${track.label}`);
                });
            }
            
            btnToggleMicrofono.textContent = microfonoActivo ? '🎤 Micrófono' : '🎤 Silenciado';
            btnToggleMicrofono.classList.toggle('activo', microfonoActivo);
            btnToggleMicrofono.classList.toggle('inactivo', !microfonoActivo);
            
            // Notificar cambio
            actualizarEstado(microfonoActivo ? '🟢 Micrófono activo' : '🔴 Micrófono silenciado', 
                           microfonoActivo ? 'conectado' : 'desconectado');
            setTimeout(() => {
                actualizarEstado('🟢 Conectado', 'conectado');
            }, 2000);
        });
        btnToggleMicrofono.classList.add('activo');
    }
    
    // Apagar/encender cámara LOCAL
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
            } else if (videoElement.msRequestFullscreen) {
                videoElement.msRequestFullscreen();
            }
        });
    }
    
    if (btnDiagnostico) {
        let diagnosticoVisible = false;
        btnDiagnostico.addEventListener('click', () => {
            diagnosticoVisible = !diagnosticoVisible;
            if (diagnosticoVisible) {
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
            console.log("🔄 Forzando reconexión...");
            isConnecting = false;
            ocultarVideoRemoto();
            Object.keys(peers).forEach(key => limpiarPeer(key));
            audioController.destroyAll();
            socket.disconnect();
            setTimeout(() => {
                socket.connect();
            }, 1000);
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
    
    const tieneAudioLocal = streamLocal && streamLocal.getAudioTracks().some(t => t.enabled);
    const tieneVideoLocal = streamLocal && streamLocal.getVideoTracks().some(t => t.enabled);
    const tieneAudioRemoto = peerIdRemoto && audioController.audioContexts.has(peerIdRemoto);
    
    // Verificar senders
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
            <span class="label">📹 Cámara LOCAL:</span>
            <span class="value ${!tieneVideoLocal ? 'error' : ''}">${tieneVideoLocal ? '✅ Activa' : '❌ Apagada'}</span>
        </div>
        <div class="info-line">
            <span class="label">🎵 Audio REMOTO:</span>
            <span class="value ${!tieneAudioRemoto ? 'error' : ''}">${tieneAudioRemoto ? '✅ Reproduciendo' : '❌ Inactivo'}</span>
        </div>
        <div class="info-line" style="border-bottom: none;">
            <span class="label">🔄 Estado:</span>
            <span class="value">${isConnecting ? '⏳ Conectando' : '✅ Estable'}</span>
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
    console.log(`📱 Modo: ${isMobile ? 'Móvil' : 'Desktop'}`);
    console.log(`🌐 Navegador: ${isSafari ? 'Safari' : isiOS ? 'iOS' : 'Otro'}`);
    iniciarCamara();
});

window.addEventListener("beforeunload", () => {
    Object.keys(peers).forEach(key => limpiarPeer(key));
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
    audioController.destroyAll();
});

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

let streamLocal = null;
let turnServers = [];
let peerConnection = null;
let connectedPeerId = null;
let isReconnecting = false;
let reconnectTimer = null;
let connectionAttempts = 0;
const MAX_ATTEMPTS = 10;
let isProcessingOffer = false;
let pendingCandidates = [];
let isConnecting = false;

// ============================================
// 🔊 CONTROL DE AUDIO
// ============================================
class AudioController {
    constructor() {
        this.audioContexts = new Map();
        this.isInitialized = false;
        this.isIOS = isiOS;
        this.globalContext = null;
        this.isAudioActive = false;
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
            
            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) {
                console.log(`ℹ️ No hay audio en stream para ${peerId}`);
                return false;
            }

            if (stream === streamLocal) {
                console.log(`⚠️ Intentando crear audio con stream local - ignorado`);
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
                console.warn('⚠️ AudioContext no disponible, reiniciando...');
                this.isInitialized = false;
                this.init().catch(e => console.warn('⚠️ Error reiniciando AudioContext:', e));
                return false;
            }

            if (videoRemoto.srcObject === stream) {
                console.log(`ℹ️ Stream ya está en video-remoto, no duplicar audio`);
                videoRemoto.muted = false;
                videoRemoto.volume = 0.3;
                return true;
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
            this.isAudioActive = true;
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
        if (peerId === connectedPeerId && videoRemoto.srcObject) {
            videoRemoto.volume = Math.max(0, Math.min(1, volume));
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
        if (peerId === connectedPeerId && videoRemoto.srcObject) {
            videoRemoto.muted = muted;
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
        if (this.audioContexts.size === 0) {
            this.isAudioActive = false;
        }
    }

    destroyAll() {
        for (const [peerId, audioData] of this.audioContexts) {
            try {
                audioData.source.disconnect();
            } catch (e) {}
        }
        this.audioContexts.clear();
        this.isAudioActive = false;
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
// 🔥 FUNCIÓN PARA LIMPIAR CONEXIÓN
// ============================================

function limpiarConexion() {
    console.log("🧹 Limpiando conexión...");
    
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (peerConnection) {
        try {
            peerConnection.onicecandidate = null;
            peerConnection.ontrack = null;
            peerConnection.onconnectionstatechange = null;
            peerConnection.oniceconnectionstatechange = null;
            peerConnection.onnegotiationneeded = null;
            peerConnection.close();
        } catch (e) {
            console.warn('⚠️ Error cerrando peerConnection:', e);
        }
        peerConnection = null;
    }
    
    if (videoRemoto) {
        videoRemoto.srcObject = null;
        videoRemoto.style.display = "none";
    }
    
    connectedPeerId = null;
    isReconnecting = false;
    isConnecting = false;
    pendingCandidates = [];
    
    console.log("✅ Limpieza completada");
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

function mostrarVideoRemoto(stream, peerId) {
    console.log(`📹 ASIGNANDO VIDEO REMOTO de ${peerId}`);
    if (!stream) return;
    
    if (stream === streamLocal) {
        console.warn('⚠️ Ignorando stream local en video remoto');
        return;
    }
    
    if (videoRemoto.srcObject === stream) {
        console.log(`ℹ️ Stream ya asignado a video-remoto`);
        return;
    }
    
    connectedPeerId = peerId;
    
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`🎵 Audio remoto: ${audioTracks.length}, Video remoto: ${videoTracks.length}`);
    
    audioTracks.forEach(track => {
        if (!track.enabled) {
            track.enabled = true;
            console.log(`🎵 Habilitando track de audio remoto: ${track.label}`);
        }
    });
    
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
            console.log(`✅ Video remoto de ${peerId} reproduciendo correctamente`);
            actualizarEstado(`🟢 Conectado`, "conectado");
            
            // Inicializar audio después de que el video empiece a reproducirse
            await audioController.init();
            const audioCreated = audioController.createAudioForPeer(peerId, stream);
            
            if (audioCreated) {
                audioController.setVolume(peerId, 0.3);
                console.log(`✅ Audio remoto configurado para ${peerId}`);
            }
        } catch (error) {
            console.warn(`⚠️ Error al reproducir video remoto:`, error.message);
            setTimeout(() => {
                videoRemoto.play()
                    .then(() => {
                        console.log(`✅ Video remoto reproducido en reintento`);
                        audioController.createAudioForPeer(peerId, stream);
                    })
                    .catch(e => console.warn(`⚠️ Error en reintento:`, e.message));
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
    if (connectedPeerId) {
        audioController.destroyAudioForPeer(connectedPeerId);
    }
    if (streamLocal) {
        video.style.display = "block";
    }
}

function aplicarCandidatosPendientes(pc) {
    if (pendingCandidates.length > 0) {
        console.log(`📦 Aplicando ${pendingCandidates.length} candidatos pendientes`);
        const candidates = [...pendingCandidates];
        pendingCandidates = [];
        candidates.forEach(candidate => {
            pc.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.warn('⚠️ Error aplicando candidato pendiente:', e.message));
        });
    }
}

function crearPeerConnection(targetId) {
    console.log(`🔗 Creando conexión con: ${targetId}`);
    
    limpiarConexion();
    
    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: isMobile ? 5 : 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    });

    peerConnection = pc;
    pendingCandidates = [];
    isConnecting = true;

    if (streamLocal) {
        const audioTracks = streamLocal.getAudioTracks();
        const videoTracks = streamLocal.getVideoTracks();
        
        console.log(`📹 Tracks locales: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
        
        audioTracks.forEach(track => {
            track.enabled = true;
            console.log(`🎤 Track de audio local habilitado para envío: ${track.label}`);
        });
        
        streamLocal.getTracks().forEach(track => {
            try {
                pc.addTrack(track, streamLocal);
                console.log(`✅ Agregando track local para envío: ${track.kind} (${track.label})`);
            } catch (error) {
                console.warn(`⚠️ Error agregando track ${track.kind}:`, error);
            }
        });
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
        if (pc.iceConnectionState === "connected") {
            console.log(`✅ ICE conectado con ${targetId}`);
            isConnecting = false;
        } else if (pc.iceConnectionState === "failed") {
            console.log(`❌ ICE falló con ${targetId}`);
            isConnecting = false;
            if (!isReconnecting && connectedPeerId) {
                isReconnecting = true;
                reconnectTimer = setTimeout(() => {
                    if (connectedPeerId) {
                        limpiarConexion();
                        socket.emit("clientes-conectados");
                    }
                    isReconnecting = false;
                    reconnectTimer = null;
                }, 3000);
            }
        } else if (pc.iceConnectionState === "disconnected") {
            console.log(`⚠️ ICE desconectado con ${targetId}`);
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado con ${targetId}: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            console.log(`✅ CONEXIÓN ESTABLECIDA con ${targetId}!`);
            connectedPeerId = targetId;
            isReconnecting = false;
            connectionAttempts = 0;
            isConnecting = false;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            actualizarEstado(`🟢 Conectado`, "conectado");
        } else if (pc.connectionState === "failed") {
            console.log(`❌ Conexión fallida con ${targetId}`);
            connectedPeerId = null;
            isConnecting = false;
            ocultarVideoRemoto();
            if (!isReconnecting && connectionAttempts < MAX_ATTEMPTS) {
                connectionAttempts++;
                isReconnecting = true;
                reconnectTimer = setTimeout(() => {
                    socket.emit("clientes-conectados");
                    isReconnecting = false;
                    reconnectTimer = null;
                }, 5000);
            }
        } else if (pc.connectionState === "disconnected") {
            console.log(`⚠️ Conexión desconectada con ${targetId}`);
        }
    };

    pc.onnegotiationneeded = async () => {
        console.log(`🤝 Negociación con ${targetId}`);
        try {
            if (pc.signalingState === 'closed') {
                console.warn(`⚠️ PC cerrado, no se puede negociar con ${targetId}`);
                return;
            }
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            await pc.setLocalDescription(offer);
            socket.emit("offer", { target: targetId, offer: pc.localDescription });
            console.log(`✅ Oferta enviada a ${targetId}`);
        } catch (error) {
            console.error(`❌ Error en negociación con ${targetId}:`, error);
            isConnecting = false;
        }
    };

    return pc;
}

function iniciarConexion(targetId) {
    console.log(`🔄 Iniciando conexión con: ${targetId}`);
    
    if (isReconnecting) {
        console.log(`⏳ Ya hay una reconexión en curso`);
        return;
    }
    
    if (targetId === connectedPeerId) {
        console.log(`ℹ️ Ya conectado con ${targetId}`);
        return;
    }
    
    if (isConnecting) {
        console.log(`⏳ Ya hay una conexión en progreso`);
        return;
    }
    
    limpiarConexion();
    
    setTimeout(() => {
        const pc = crearPeerConnection(targetId);
        setTimeout(() => {
            if (pc.signalingState === 'closed') {
                console.warn(`⚠️ PC cerrado, no se puede crear oferta para ${targetId}`);
                isConnecting = false;
                return;
            }
            pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            })
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                socket.emit("offer", { target: targetId, offer: pc.localDescription });
                console.log(`✅ Oferta enviada a: ${targetId}`);
            })
            .catch(error => {
                console.error(`❌ Error creando oferta para ${targetId}:`, error);
                isConnecting = false;
            });
        }, isMobile ? 1000 : 500);
    }, isMobile ? 1500 : 1000);
}

function conectarConTodos(clientes) {
    console.log("🔄 CLIENTES CONECTADOS:", clientes);
    
    const otros = clientes.filter(id => id !== socket.id);
    
    if (otros.length === 0) {
        console.log(`ℹ️ Solo estamos nosotros conectados`);
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
        return;
    }

    const targetId = otros[0];
    console.log(`🎯 Conectando SOLO con: ${targetId}`);
    
    if (otros.length > 1) {
        console.warn(`⚠️ IGNORANDO a otros ${otros.length - 1} clientes: ${otros.slice(1).join(', ')}`);
        actualizarEstado(`⚠️ Solo conectando con ${targetId.substring(0, 6)}...`, "inicializando");
    }
    
    if (connectedPeerId === targetId) {
        console.log(`✅ Ya conectado con ${targetId}`);
        return;
    }
    
    if (isConnecting) {
        console.log(`⏳ Conexión en progreso, esperando...`);
        return;
    }
    
    setTimeout(() => {
        iniciarConexion(targetId);
    }, isMobile ? 1500 : 1000);
}

// ============================================
// 📡 Eventos Socket.IO
// ============================================

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);
    
    if (connectedPeerId && connectedPeerId !== from) {
        console.log(`⛔ YA CONECTADO con ${connectedPeerId}, IGNORANDO oferta de ${from}`);
        return;
    }
    
    if (isConnecting) {
        console.log(`⏳ Conexión en progreso, ignorando oferta de ${from}`);
        return;
    }
    
    if (isProcessingOffer) {
        console.log(`⏳ Ya procesando una oferta, ignorando`);
        return;
    }
    
    isProcessingOffer = true;
    isConnecting = true;
    
    try {
        limpiarConexion();
        
        const pc = crearPeerConnection(from);
        if (pc.signalingState === 'closed') {
            console.warn(`⚠️ PC cerrado, no se puede procesar oferta de ${from}`);
            isProcessingOffer = false;
            isConnecting = false;
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida (oferta) de ${from}`);
        
        aplicarCandidatosPendientes(pc);

        const answer = await pc.createAnswer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(answer);

        socket.emit("answer", { target: from, answer: pc.localDescription });
        console.log(`✅ Respuesta enviada a: ${from}`);
        isProcessingOffer = false;
        isConnecting = false;
    } catch (error) {
        console.error(`❌ Error manejando oferta de ${from}:`, error);
        limpiarConexion();
        isProcessingOffer = false;
        isConnecting = false;
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA RECIBIDA DE: ${from}`);
    
    if (!peerConnection) {
        console.log(`⚠️ No hay peer para ${from}, ignorando respuesta`);
        return;
    }

    if (peerConnection.signalingState === 'closed') {
        console.log(`⚠️ PC cerrado para ${from}, ignorando respuesta`);
        limpiarConexion();
        return;
    }

    if (peerConnection.signalingState === 'stable') {
        console.log(`ℹ️ Estado stable para ${from}, ignorando respuesta`);
        return;
    }

    if (peerConnection.signalingState !== 'have-local-offer') {
        console.log(`⚠️ Estado incorrecto: ${peerConnection.signalingState} para ${from}`);
        return;
    }

    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida de ${from}`);
    } catch (error) {
        console.error(`❌ Error procesando respuesta de ${from}:`, error);
        limpiarConexion();
    }
});

socket.on("ice-candidate", async (data) => {
    const { from, candidate } = data;
    
    if (connectedPeerId && connectedPeerId !== from) {
        console.log(`⛔ Ignorando ICE de ${from}, conectado con ${connectedPeerId}`);
        return;
    }
    
    if (!peerConnection) {
        console.log(`⚠️ No hay peer para ${from}, ignorando ICE candidate`);
        return;
    }

    try {
        if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            console.log(`✅ ICE Candidate agregado de: ${from}`);
        } else {
            console.log(`⏳ Descripción remota no lista para ${from}, guardando candidate`);
            pendingCandidates.push(candidate);
        }
    } catch (error) {
        console.warn(`⚠️ Error ICE para ${from}:`, error.message);
        // Ignorar Unknown ufrag (es normal en ICE restart)
        if (error.message && error.message.includes('Unknown ufrag')) {
            console.log(`ℹ️ Unknown ufrag detectado (ICE restart), ignorando`);
        }
    }
});

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    connectionAttempts = 0;
    isReconnecting = false;
    isConnecting = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    actualizarEstado("🟢 Conectado", "conectado");
    await obtenerTurnServers();
    await audioController.init();
    
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
    setTimeout(() => socket.emit("clientes-conectados"), 3000);
    setTimeout(() => socket.emit("clientes-conectados"), 5000);
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Lista de clientes recibida:", lista);
    
    if (lista.length > 2) {
        console.warn(`⚠️ ATENCIÓN: Hay ${lista.length} clientes conectados. WebRTC solo funciona 1 a 1.`);
        actualizarEstado(`⚠️ ${lista.length} clientes - cerrando extras`, "inicializando");
    }
    
    conectarConTodos(lista);
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente:", data.id);
    setTimeout(() => socket.emit("clientes-conectados"), 500);
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    
    if (data.id === socket.id) {
        console.log(`ℹ️ Ignorando nuestra propia desconexión`);
        return;
    }
    
    if (connectedPeerId === data.id) {
        limpiarConexion();
        ocultarVideoRemoto();
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
    }
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    connectionAttempts++;
    actualizarEstado(`🔴 Reconectando... (${connectionAttempts})`, "desconectado");
    limpiarConexion();
    ocultarVideoRemoto();
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
});

socket.on("connect_error", (error) => {
    console.error("❌ Error de conexión:", error);
    actualizarEstado("🔴 Error de conexión", "desconectado");
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
                sampleRate: isMobile ? 16000 : 44100
            }
        };
        
        if (isiOS) {
            constraints.video = { facingMode: 'user' };
            constraints.audio = { echoCancellation: false };
        }
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamLocal = stream;
        
        const audioTracks = stream.getAudioTracks();
        console.log(`🎤 Tracks de audio locales: ${audioTracks.length}`);
        audioTracks.forEach(track => {
            track.enabled = true;
            console.log(`🎤 Audio local habilitado para envío: ${track.label}`);
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
            console.log("📹 Cámara local iniciada (muteada)");
        } catch (e) {
            console.warn("⚠️ Error al iniciar video local:", e.message);
        }
        
        await obtenerTurnServers();
        await audioController.init();
        
        setTimeout(() => socket.emit("clientes-conectados"), 1000);
        setTimeout(() => socket.emit("clientes-conectados"), 3000);
    } catch (error) {
        console.error("❌ Error al acceder a cámara:", error);
        alert("⚠️ No se pudo acceder a la cámara/micrófono.");
        actualizarEstado("🔴 Error", "desconectado");
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
            if (connectedPeerId) {
                audioController.setVolume(connectedPeerId, vol);
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
            if (connectedPeerId) {
                audioController.muteAudio(connectedPeerId, silenciado);
            }
            btnSilenciar.textContent = silenciado ? '🔊 Activar sonido' : '🔇 Silenciar';
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
                    console.log(`🎤 Micrófono local ${microfonoActivo ? 'activado' : 'silenciado'}`);
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
            limpiarConexion();
            isProcessingOffer = false;
            isConnecting = false;
            ocultarVideoRemoto();
            actualizarEstado("🔄 Reconectando...", "inicializando");
            
            socket.disconnect();
            setTimeout(() => {
                socket.connect();
            }, 1000);
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
    
    const tieneAudioLocal = streamLocal && streamLocal.getAudioTracks().some(t => t.enabled);
    const tieneVideoLocal = streamLocal && streamLocal.getVideoTracks().some(t => t.enabled);
    const tieneAudioRemoto = connectedPeerId && audioController.audioContexts.has(connectedPeerId);
    
    badge.innerHTML = `
        <div class="info-line">
            <span class="label">🔗 Socket ID:</span>
            <span class="value">${socket.id ? socket.id.substring(0, 8) : 'N/A'}</span>
        </div>
        <div class="info-line">
            <span class="label">📡 Conectado a:</span>
            <span class="value ${!connectedPeerId ? 'warning' : ''}">${connectedPeerId ? connectedPeerId.substring(0, 8) : 'Ninguno'}</span>
        </div>
        <div class="info-line">
            <span class="label">🎤 Micrófono LOCAL:</span>
            <span class="value ${!tieneAudioLocal ? 'error' : ''}">${tieneAudioLocal ? '✅ Activo' : '❌ Silenciado'}</span>
        </div>
        <div class="info-line">
            <span class="label">📹 Cámara LOCAL:</span>
            <span class="value ${!tieneVideoLocal ? 'error' : ''}">${tieneVideoLocal ? '✅ Activa' : '❌ Apagada'}</span>
        </div>
        <div class="info-line">
            <span class="label">🎵 Audio REMOTO:</span>
            <span class="value ${!tieneAudioRemoto ? 'warning' : ''}">${tieneAudioRemoto ? '✅ Procesado' : '⚠️ Solo video'}</span>
        </div>
        <div class="info-line" style="border-bottom: none;">
            <span class="label">📱 Dispositivo:</span>
            <span class="value">${isMobile ? 'Móvil' : 'Desktop'}</span>
        </div>
        <div class="info-line" style="border-bottom: none;">
            <span class="label">🔄 Intentos:</span>
            <span class="value">${connectionAttempts}/${MAX_ATTEMPTS}</span>
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
    limpiarConexion();
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
    audioController.destroyAll();
});

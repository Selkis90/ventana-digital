// ============================================
// 📱 CONFIGURACIÓN INICIAL Y DETECCIÓN
// ============================================
const video = document.getElementById("video");
const videoRemoto = document.getElementById("video-remoto");
const audioRemoto = document.getElementById("audio-remoto");

const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent);
const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

console.log(`📱 Dispositivo: ${isMobile ? 'Móvil' : 'Desktop'}`);

video.style.display = "none";
videoRemoto.style.display = "none";
audioRemoto.style.display = "none";

video.muted = true;
video.volume = 0;
videoRemoto.muted = false;
videoRemoto.volume = 0.3;
audioRemoto.muted = false;
audioRemoto.volume = 0.3;

if (isMobile) {
    video.setAttribute('playsinline', '');
    videoRemoto.setAttribute('playsinline', '');
    audioRemoto.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    videoRemoto.setAttribute('autoplay', '');
    audioRemoto.setAttribute('autoplay', '');
}

// ============================================
// 🔌 CONFIGURACIÓN DE SOCKET
// ============================================
const socket = io("https://ventana-digital.onrender.com", {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: isMobile ? 2000 : 1000,
    reconnectionDelayMax: 5000,
    timeout: isMobile ? 60000 : 30000,
    forceNew: true,
    autoConnect: true
});

// ============================================
// 📦 VARIABLES GLOBALES
// ============================================
const peers = {};
let streamLocal = null;
let turnServers = [];
let peerIdRemoto = null;
let isConnecting = false;
let reconnectTimer = null;
let isOfferSent = false;
let soyOfertante = false;
let soyAnswer = false;
let rolAsignado = false;

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
            if (!stream || stream === streamLocal) return false;
            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) return false;

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
                audioData.filter.disconnect();
                audioData.gainNode.disconnect();
            } catch (e) {}
            this.audioContexts.delete(peerId);
            console.log(`🗑️ Audio destruido para peer ${peerId}`);
        }
    }

    destroyAll() {
        for (const [peerId, audioData] of this.audioContexts) {
            try {
                audioData.source.disconnect();
                audioData.filter.disconnect();
                audioData.gainNode.disconnect();
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

    getContextState() {
        return this.globalContext ? this.globalContext.state : 'none';
    }
}

const audioController = new AudioController();

// ============================================
// 🎵 CREAR TRACK DE AUDIO SILENCIOSO
// ============================================
function crearTrackAudioSilencioso() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const bufferSize = audioContext.sampleRate * 1;
        const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = 0;
        }
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const dest = audioContext.createMediaStreamDestination();
        source.connect(dest);
        source.start(0);
        const track = dest.stream.getAudioTracks()[0];
        console.log('✅ Track de audio silencioso creado');
        return track;
    } catch (error) {
        console.error('❌ Error creando track silencioso:', error);
        return null;
    }
}

function asegurarAudioLocal() {
    if (!streamLocal) return false;
    let audioTracks = streamLocal.getAudioTracks();
    if (audioTracks.length === 0) {
        const silentTrack = crearTrackAudioSilencioso();
        if (silentTrack) {
            streamLocal.addTrack(silentTrack);
            audioTracks = streamLocal.getAudioTracks();
        }
    }
    audioTracks.forEach(track => track.enabled = true);
    return audioTracks.length > 0;
}

// ============================================
// 🔧 FUNCIONES DE UI
// ============================================
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

// ============================================
// 🌐 OBTENER TURN SERVERS
// ============================================
async function obtenerTurnServers() {
    try {
        const response = await fetch('/turn-credentials');
        if (response.ok) {
            const data = await response.json();
            if (data.iceServers && data.iceServers.length > 0) {
                turnServers = data.iceServers;
                console.log('✅ Servidores TURN obtenidos');
                return turnServers;
            }
        }
    } catch (error) {
        console.warn('⚠️ No se pudo obtener TURN:', error.message);
    }
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

// ============================================
// 📹 MOSTRAR VIDEO REMOTO
// ============================================
function mostrarVideoRemoto(stream, peerId) {
    console.log(`📹 ASIGNANDO VIDEO REMOTO de ${peerId}`);
    
    if (!stream || stream === streamLocal) return;
    
    if (videoRemoto.srcObject === stream && !videoRemoto.paused) {
        console.log('ℹ️ Video ya está reproduciendo');
        return;
    }
    
    peerIdRemoto = peerId;
    actualizarInfoPeer(peerId);
    
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`🎵 Audio: ${audioTracks.length}, Video: ${videoTracks.length}`);
    
    if (videoRemoto.srcObject && videoRemoto.srcObject !== stream) {
        try { videoRemoto.pause(); } catch(e) {}
        videoRemoto.srcObject = null;
    }
    if (audioRemoto.srcObject && audioRemoto.srcObject !== stream) {
        try { audioRemoto.pause(); } catch(e) {}
        audioRemoto.srcObject = null;
    }
    
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    video.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = 0.3;
    
    if (audioTracks.length > 0) {
        audioRemoto.srcObject = stream;
        audioRemoto.style.display = "block";
        audioRemoto.muted = false;
        audioRemoto.volume = 0.3;
        audioTracks.forEach(t => t.enabled = true);
    }
    
    if (isMobile) {
        videoRemoto.setAttribute('playsinline', 'true');
        videoRemoto.setAttribute('webkit-playsinline', 'true');
        audioRemoto.setAttribute('playsinline', 'true');
    }
    
    setTimeout(() => {
        videoRemoto.play().then(() => {
            console.log('✅ Video remoto reproduciendo');
            if (audioTracks.length > 0) {
                audioRemoto.play().then(() => {
                    console.log('✅ Audio remoto reproduciendo');
                    actualizarEstado('🟢 Conectado con audio', 'conectado');
                }).catch(() => {
                    audioController.createAudioForPeer(peerId, stream);
                });
            }
            isConnecting = false;
        }).catch(err => {
            console.warn('⚠️ Error en video:', err.message);
            setTimeout(() => videoRemoto.play().catch(() => {}), 500);
        });
    }, 300);
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    audioRemoto.style.display = "none";
    if (videoRemoto.srcObject) {
        try { videoRemoto.pause(); } catch(e) {}
        videoRemoto.srcObject = null;
    }
    if (audioRemoto.srcObject) {
        try { audioRemoto.pause(); } catch(e) {}
        audioRemoto.srcObject = null;
    }
    if (peerIdRemoto) {
        audioController.destroyAudioForPeer(peerIdRemoto);
        peerIdRemoto = null;
        actualizarInfoPeer(null);
    }
    if (streamLocal) video.style.display = "block";
}

// ============================================
// 🧹 LIMPIAR PEER
// ============================================
function limpiarPeer(targetId) {
    if (peers[targetId]) {
        try {
            const pc = peers[targetId];
            pc.onicecandidate = null;
            pc.ontrack = null;
            pc.onconnectionstatechange = null;
            pc.oniceconnectionstatechange = null;
            pc.close();
        } catch (e) {}
        delete peers[targetId];
        audioController.destroyAudioForPeer(targetId);
        console.log(`🧹 Peer limpiado: ${targetId}`);
    }
}

// ============================================
// 🔥 CREAR PEER CONNECTION
// ============================================
function crearPeerConnection(targetId) {
    console.log(`🔗 Creando conexión con: ${targetId}`);
    
    limpiarPeer(targetId);
    
    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    });

    if (streamLocal) {
        asegurarAudioLocal();
        streamLocal.getTracks().forEach(track => {
            try {
                pc.addTrack(track, streamLocal);
                console.log(`✅ Track agregado: ${track.kind}`);
            } catch (error) {
                console.error(`❌ Error agregando track ${track.kind}:`, error);
            }
        });
        const senders = pc.getSenders();
        const hasAudio = senders.some(s => s.track && s.track.kind === 'audio');
        const hasVideo = senders.some(s => s.track && s.track.kind === 'video');
        console.log(`📤 Senders: Audio=${hasAudio ? '✅' : '❌'}, Video=${hasVideo ? '✅' : '❌'}`);
    }

    pc.ontrack = (event) => {
        console.log(`📥 Track recibido: ${event.track.kind}`);
        if (event.streams && event.streams[0]) {
            const stream = event.streams[0];
            if (stream === streamLocal) return;
            stream.getAudioTracks().forEach(t => t.enabled = true);
            mostrarVideoRemoto(stream, targetId);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit("ice-candidate", { target: targetId, candidate: event.candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`🔗 ICE: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === "failed") {
            handleConnectionFailure(targetId);
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            console.log(`✅ CONEXIÓN ESTABLECIDA con ${targetId}!`);
            actualizarEstado('🟢 Conectado', 'conectado');
            actualizarInfoPeer(targetId);
            isConnecting = false;
            isOfferSent = false;
        } else if (pc.connectionState === "failed") {
            handleConnectionFailure(targetId);
        }
    };

    pc._pendingCandidates = [];
    peers[targetId] = pc;
    return pc;
}

// ============================================
// 🔄 MANEJAR FALLAS
// ============================================
function handleConnectionFailure(targetId) {
    console.log(`❌ Falla con ${targetId}`);
    if (peerIdRemoto === targetId) ocultarVideoRemoto();
    limpiarPeer(targetId);
    isConnecting = false;
    isOfferSent = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

// ============================================
// 📤 INICIAR OFERTA
// ============================================
function iniciarOferta(targetId, pc) {
    console.log(`📤 Iniciando oferta para ${targetId}`);
    
    if (isOfferSent) {
        console.log(`⏳ Oferta ya enviada`);
        return;
    }
    
    if (!pc || pc.signalingState === 'closed') {
        console.warn(`⚠️ PC cerrado`);
        limpiarPeer(targetId);
        isConnecting = false;
        return;
    }
    
    if (pc.signalingState !== 'stable') {
        console.log(`⏳ Signaling state: ${pc.signalingState}, esperando...`);
        setTimeout(() => {
            if (pc.signalingState === 'stable' && peers[targetId]) {
                iniciarOferta(targetId, pc);
            } else {
                isConnecting = false;
            }
        }, 500);
        return;
    }
    
    if (!asegurarAudioLocal()) {
        console.error('❌ No hay audio local');
        isConnecting = false;
        return;
    }
    
    isOfferSent = true;
    
    pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
    })
    .then(offer => {
        const hasAudio = offer.sdp ? offer.sdp.includes('m=audio') : false;
        console.log(`📝 SDP: Audio=${hasAudio ? '✅' : '❌'}`);
        return pc.setLocalDescription(offer);
    })
    .then(() => {
        socket.emit("offer", { target: targetId, offer: pc.localDescription });
        console.log(`✅ Oferta enviada a ${targetId}`);
        actualizarEstado('🔄 Esperando respuesta...', 'inicializando');
    })
    .catch(error => {
        console.error(`❌ Error:`, error);
        limpiarPeer(targetId);
        isConnecting = false;
        isOfferSent = false;
    });
}

// ============================================
// 🔗 CONECTAR CON TODOS - CON ROLES FIJOS
// ============================================
function conectarConTodos(clientes) {
    if (isConnecting) {
        console.log(`⏳ Conexión en proceso...`);
        return;
    }
    
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
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
    
    // Verificar peer existente
    if (peers[targetId]) {
        const pc = peers[targetId];
        const state = pc.connectionState;
        if (state === "connected") {
            console.log(`✅ Ya conectado con ${targetId}`);
            actualizarInfoPeer(targetId);
            return;
        }
        if (state === "connecting") {
            console.log(`⏳ Ya conectando con ${targetId}`);
            return;
        }
        limpiarPeer(targetId);
    }
    
    // 🔥 DECIDIR QUIÉN OFERTA: EL QUE TIENE EL ID MÁS PEQUEÑO
    soyOfertante = socket.id < targetId;
    soyAnswer = !soyOfertante;
    rolAsignado = true;
    
    console.log(`📌 ROL: ${soyOfertante ? '🟢 OFERTANTE' : '🔴 ANSWER'} (${socket.id.substring(0,6)} vs ${targetId.substring(0,6)})`);
    
    isConnecting = true;
    isOfferSent = false;
    
    // SOLO EL OFERTANTE INICIA LA CONEXIÓN
    if (soyOfertante) {
        console.log(`📤 INICIANDO COMO OFERTANTE...`);
        reconnectTimer = setTimeout(() => {
            const pc = crearPeerConnection(targetId);
            if (pc && pc.signalingState !== 'closed') {
                iniciarOferta(targetId, pc);
            } else {
                isConnecting = false;
            }
            reconnectTimer = null;
        }, 500);
    } else {
        console.log(`📥 ESPERANDO COMO ANSWER...`);
        actualizarEstado("🟢 Esperando conexión entrante...", "conectado");
        isConnecting = false;
    }
}

// ============================================
// 📡 EVENTOS SOCKET.IO - VERSIÓN DEFINITIVA
// ============================================

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    isConnecting = false;
    isOfferSent = false;
    soyOfertante = false;
    soyAnswer = false;
    rolAsignado = false;
    actualizarEstado("🟢 Conectado al servidor", "conectado");
    actualizarInfoPeer(null);
    await obtenerTurnServers();
    await audioController.init();
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
});

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA DE: ${from}`);
    
    // 🔥 SI YA TENEMOS ROL ASIGNADO Y SOMOS OFERTANTE, IGNORAR
    if (rolAsignado && soyOfertante) {
        console.log(`⚠️ Soy OFERTANTE (rol asignado), ignorando oferta de ${from}`);
        return;
    }
    
    // Si ya estamos conectados, ignorar
    if (peers[from] && peers[from].connectionState === "connected") {
        console.log(`ℹ️ Ya conectado con ${from}`);
        return;
    }
    
    // Si ya estamos en negociación, ignorar
    if (peers[from] && (peers[from].signalingState === 'have-local-offer' || peers[from].signalingState === 'have-remote-offer')) {
        console.log(`⏳ Ya en negociación`);
        return;
    }
    
    // 🔥 SI ENVIAMOS OFERTA, IGNORAR LA DEL OTRO
    if (isOfferSent) {
        console.log(`⏳ Ya enviamos oferta, ignorando la de ${from}`);
        return;
    }
    
    limpiarPeer(from);
    
    try {
        console.log(`📥 RESPONDIENDO COMO ANSWER...`);
        const pc = crearPeerConnection(from);
        
        if (pc.signalingState === 'closed') {
            limpiarPeer(from);
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida`);
        
        if (pc._pendingCandidates && pc._pendingCandidates.length > 0) {
            for (const candidate of pc._pendingCandidates) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {}
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
        console.error(`❌ Error:`, error);
        limpiarPeer(from);
        isConnecting = false;
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA DE: ${from}`);
    
    // 🔥 SOLO EL OFERTANTE PROCESA RESPUESTAS
    if (rolAsignado && !soyOfertante) {
        console.log(`⚠️ Soy ANSWER, ignorando respuesta de ${from}`);
        return;
    }
    
    const pc = peers[from];
    if (!pc) {
        console.log(`⚠️ No hay peer para ${from}`);
        return;
    }

    if (pc.signalingState === 'closed') {
        limpiarPeer(from);
        return;
    }

    if (pc.signalingState !== 'have-local-offer') {
        console.log(`ℹ️ Estado ${pc.signalingState}, ignorando respuesta`);
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida (respuesta)`);
        isConnecting = false;
        isOfferSent = false;
    } catch (error) {
        console.error(`❌ Error:`, error);
        limpiarPeer(from);
        isConnecting = false;
        isOfferSent = false;
    }
});

socket.on("ice-candidate", async (data) => {
    const { from, candidate } = data;
    const pc = peers[from];
    if (!pc) return;

    try {
        if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
            if (!pc._pendingCandidates) pc._pendingCandidates = [];
            pc._pendingCandidates.push(candidate);
        }
    } catch (error) {
        console.warn(`⚠️ Error ICE:`, error.message);
    }
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Clientes:", lista);
    const clientesActuales = new Set(lista);
    Object.keys(peers).forEach(id => {
        if (!clientesActuales.has(id) && id !== socket.id) {
            limpiarPeer(id);
        }
    });
    if (!isConnecting && lista.length > 1) {
        setTimeout(() => conectarConTodos(lista), 500);
    } else if (lista.length === 1) {
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
        actualizarInfoPeer(null);
    }
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente:", data.id);
    if (!isConnecting) {
        setTimeout(() => socket.emit("clientes-conectados"), 1000);
    }
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
    isOfferSent = false;
    soyOfertante = false;
    soyAnswer = false;
    rolAsignado = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    isConnecting = false;
    isOfferSent = false;
    soyOfertante = false;
    soyAnswer = false;
    rolAsignado = false;
    actualizarEstado("🔴 Reconectando...", "desconectado");
    ocultarVideoRemoto();
    Object.keys(peers).forEach(key => limpiarPeer(key));
    actualizarInfoPeer(null);
});

// ============================================
// 🎬 INICIAR CÁMARA
// ============================================
async function iniciarCamara() {
    try {
        console.log("📷 Solicitando cámara...");
        const constraints = {
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: 'user'
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        };
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamLocal = stream;
        
        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        console.log(`📊 Stream local: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
        
        if (audioTracks.length === 0) {
            const silentTrack = crearTrackAudioSilencioso();
            if (silentTrack) streamLocal.addTrack(silentTrack);
        }
        
        audioTracks.forEach(track => track.enabled = true);
        
        video.srcObject = stream;
        video.style.display = "block";
        video.muted = true;
        
        try { await video.play(); } catch(e) {}
        
        await obtenerTurnServers();
        await audioController.init();
        isConnecting = false;
        isOfferSent = false;
        soyOfertante = false;
        soyAnswer = false;
        rolAsignado = false;
        actualizarEstado("🟢 Cámara lista", "conectado");
        
        setTimeout(() => socket.emit("clientes-conectados"), 1000);
    } catch (error) {
        console.error("❌ Error:", error);
        alert("⚠️ No se pudo acceder a la cámara/micrófono.\n\n" + error.message);
        actualizarEstado("🔴 Error de cámara", "desconectado");
    }
}

// ============================================
// 🎛️ CONTROLES DE UI
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
                audioRemoto.volume = vol;
            }
            if (labelVolumen) labelVolumen.textContent = `${Math.round(vol * 100)}%`;
        });
    }
    
    if (btnSilenciar) {
        let muted = false;
        btnSilenciar.addEventListener('click', () => {
            muted = !muted;
            videoRemoto.muted = muted;
            audioRemoto.muted = muted;
            if (peerIdRemoto) audioController.muteAudio(peerIdRemoto, muted);
            btnSilenciar.textContent = muted ? '🔊 Activar' : '🔇 Silenciar';
            btnSilenciar.classList.toggle('silenciado', muted);
        });
    }
    
    if (btnToggleMicrofono) {
        let audioEnabled = true;
        btnToggleMicrofono.addEventListener('click', () => {
            audioEnabled = !audioEnabled;
            if (streamLocal) {
                streamLocal.getAudioTracks().forEach(track => track.enabled = audioEnabled);
            }
            btnToggleMicrofono.textContent = audioEnabled ? '🎤 Micrófono' : '🎤 Silenciado';
            btnToggleMicrofono.classList.toggle('activo', audioEnabled);
            btnToggleMicrofono.classList.toggle('inactivo', !audioEnabled);
        });
        btnToggleMicrofono.classList.add('activo');
    }
    
    if (btnToggleCamara) {
        let videoEnabled = true;
        btnToggleCamara.addEventListener('click', () => {
            videoEnabled = !videoEnabled;
            if (streamLocal) {
                streamLocal.getVideoTracks().forEach(track => track.enabled = videoEnabled);
            }
            video.style.display = videoEnabled ? 'block' : 'none';
            btnToggleCamara.textContent = videoEnabled ? '📷 Cámara' : '📷 Apagada';
            btnToggleCamara.classList.toggle('activo', videoEnabled);
            btnToggleCamara.classList.toggle('inactivo', !videoEnabled);
        });
        btnToggleCamara.classList.add('activo');
    }
    
    if (btnFullscreen) {
        btnFullscreen.addEventListener('click', () => {
            if (videoRemoto.requestFullscreen) {
                videoRemoto.requestFullscreen();
            } else if (videoRemoto.webkitRequestFullscreen) {
                videoRemoto.webkitRequestFullscreen();
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
            console.log("🔄 Forzando reconexión...");
            isConnecting = false;
            isOfferSent = false;
            soyOfertante = false;
            soyAnswer = false;
            rolAsignado = false;
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
            if (audioRemoto.srcObject) {
                audioRemoto.play().catch(() => {});
            }
        }, { once: true });
    }
});

// ============================================
// 📊 DIAGNÓSTICO
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
    
    let tieneAudioRemoto = false;
    let audioTracksRemoto = 0;
    if (peerIdRemoto && videoRemoto.srcObject) {
        audioTracksRemoto = videoRemoto.srcObject.getAudioTracks().length;
        tieneAudioRemoto = audioTracksRemoto > 0;
    }
    
    let audioSenders = 0;
    let connectionState = 'N/A';
    if (peerIdRemoto && peers[peerIdRemoto]) {
        const pc = peers[peerIdRemoto];
        connectionState = pc.connectionState || 'N/A';
        const senders = pc.getSenders();
        audioSenders = senders.filter(s => s.track && s.track.kind === 'audio').length;
    }
    
    const audioContextState = audioController.getContextState();
    
    badge.innerHTML = `
        <div class="diagnostico-header">📊 DIAGNÓSTICO</div>
        <div class="info-line"><span class="label">🔗 Socket ID:</span><span class="value">${socket.id ? socket.id.substring(0, 8) : 'N/A'}</span></div>
        <div class="info-line"><span class="label">📌 ROL:</span><span class="value ${soyOfertante ? 'success' : 'warning'}">${soyOfertante ? '🟢 OFERTANTE' : soyAnswer ? '🔴 ANSWER' : '⏳ SIN DEFINIR'}</span></div>
        <div class="info-line"><span class="label">📡 Conexiones:</span><span class="value ${activePeers.length === 0 ? 'warning' : ''}">${activePeers.length} / ${peerIds.length}</span></div>
        <div class="info-line"><span class="label">🔗 Estado peer:</span><span class="value">${connectionState}</span></div>
        <div class="info-line"><span class="label">🎤 Micrófono LOCAL:</span><span class="value ${!tieneAudioLocal ? 'error' : ''}">${tieneAudioLocal ? '✅ Activo' : '❌ Sin audio'}</span></div>
        <div class="info-line"><span class="label">📤 Envío de audio:</span><span class="value ${audioSenders === 0 ? 'error' : ''}">${audioSenders > 0 ? `✅ ${audioSenders} sender` : '❌ Sin sender'}</span></div>
        <div class="info-line"><span class="label">🎵 Audio REMOTO:</span><span class="value ${!tieneAudioRemoto ? 'error' : ''}">${tieneAudioRemoto ? `✅ ${audioTracksRemoto} tracks` : '❌ Solo video'}</span></div>
        <div class="info-line"><span class="label">📹 Video REMOTO:</span><span class="value">${videoRemoto.srcObject ? '✅ Activo' : '❌ Inactivo'}</span></div>
        <div class="info-line" style="border-bottom: none;"><span class="label">🎚️ AudioContext:</span><span class="value ${audioContextState === 'suspended' ? 'warning' : ''}">${audioContextState}</span></div>
    `;
    badge.classList.add('visible');
}

function ocultarDiagnostico() {
    const badge = document.querySelector('.diagnostico-badge');
    if (badge) badge.classList.remove('visible');
}

// ============================================
// 🚀 INICIALIZACIÓN
// ============================================
window.addEventListener("load", () => {
    console.log("🚀 Iniciando Ventana Digital...");
    iniciarCamara();
});

window.addEventListener("beforeunload", () => {
    Object.keys(peers).forEach(key => limpiarPeer(key));
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
    audioController.destroyAll();
    socket.disconnect();
});

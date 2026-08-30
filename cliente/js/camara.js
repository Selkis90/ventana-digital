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
    reconnectionAttempts: 3,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 5000,
    timeout: 30000,
    forceNew: true,
    autoConnect: true
});

// ============================================
// 📦 VARIABLES GLOBALES - SIMPLIFICADAS
// ============================================
let streamLocal = null;
let turnServers = [];
let isConnecting = false;
let isOfferSent = false;
let soyOfertante = false;
let rolAsignado = false;
let pc = null;
let targetPeerId = null;

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

    createAudioForPeer(stream) {
        try {
            if (!stream || stream === streamLocal) return false;
            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) return false;

            if (this.audioContexts.has('remoto')) {
                this.destroyAudioForPeer();
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
            
            this.audioContexts.set('remoto', {
                source: source,
                gainNode: gainNode,
                filter: filter
            });
            
            console.log('✅ Audio remoto CREADO');
            return true;
        } catch (error) {
            console.error('❌ Error creando audio:', error);
            return false;
        }
    }

    setVolume(volume) {
        const audioData = this.audioContexts.get('remoto');
        if (audioData && audioData.gainNode) {
            audioData.gainNode.gain.value = Math.max(0, Math.min(1, volume));
            return true;
        }
        return false;
    }

    muteAudio(muted) {
        const audioData = this.audioContexts.get('remoto');
        if (audioData && audioData.gainNode) {
            audioData.gainNode.gain.value = muted ? 0 : 0.3;
            return true;
        }
        return false;
    }

    destroyAudioForPeer() {
        const audioData = this.audioContexts.get('remoto');
        if (audioData) {
            try {
                audioData.source.disconnect();
                audioData.filter.disconnect();
                audioData.gainNode.disconnect();
            } catch (e) {}
            this.audioContexts.delete('remoto');
            console.log('🗑️ Audio destruido');
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
function mostrarVideoRemoto(stream) {
    console.log('📹 ASIGNANDO VIDEO REMOTO');
    
    if (!stream || stream === streamLocal) return;
    
    // Si ya está reproduciendo, no hacer nada
    if (videoRemoto.srcObject === stream && !videoRemoto.paused) {
        console.log('ℹ️ Video ya está reproduciendo');
        return;
    }
    
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`🎵 Audio: ${audioTracks.length}, Video: ${videoTracks.length}`);
    
    // Limpiar si hay otro stream
    if (videoRemoto.srcObject && videoRemoto.srcObject !== stream) {
        try { videoRemoto.pause(); } catch(e) {}
        videoRemoto.srcObject = null;
    }
    if (audioRemoto.srcObject && audioRemoto.srcObject !== stream) {
        try { audioRemoto.pause(); } catch(e) {}
        audioRemoto.srcObject = null;
    }
    
    // Asignar stream
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
    
    // Reproducir
    setTimeout(() => {
        videoRemoto.play().then(() => {
            console.log('✅ Video remoto reproduciendo');
            if (audioTracks.length > 0) {
                audioRemoto.play().then(() => {
                    console.log('✅ Audio remoto reproduciendo');
                    actualizarEstado('🟢 Conectado con audio', 'conectado');
                }).catch(() => {
                    audioController.createAudioForPeer(stream);
                });
            }
            isConnecting = false;
        }).catch(err => {
            console.warn('⚠️ Error en video:', err.message);
            // Reintentar una vez
            setTimeout(() => {
                videoRemoto.play().catch(() => {});
            }, 500);
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
    audioController.destroyAll();
    if (streamLocal) video.style.display = "block";
    actualizarInfoPeer(null);
}

// ============================================
// 🧹 LIMPIAR PEER - UNA SOLA CONEXIÓN
// ============================================
function limpiarPeer() {
    if (pc) {
        try {
            pc.onicecandidate = null;
            pc.ontrack = null;
            pc.onconnectionstatechange = null;
            pc.oniceconnectionstatechange = null;
            pc.close();
        } catch (e) {}
        pc = null;
        console.log('🧹 Peer limpiado');
    }
    audioController.destroyAll();
    isConnecting = false;
    isOfferSent = false;
    targetPeerId = null;
}

// ============================================
// 🔥 CREAR PEER CONNECTION - UNA SOLA
// ============================================
function crearPeerConnection(targetId) {
    // LIMPIAR CONEXIÓN ANTERIOR
    limpiarPeer();
    
    console.log(`🔗 Creando conexión con: ${targetId}`);
    targetPeerId = targetId;
    
    try {
        pc = new RTCPeerConnection({
            iceServers: turnServers,
            iceCandidatePoolSize: 10,
            bundlePolicy: "max-bundle",
            rtcpMuxPolicy: "require"
        });
    } catch (error) {
        console.error('❌ Error creando RTCPeerConnection:', error);
        return null;
    }

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
    }

    pc.ontrack = (event) => {
        console.log(`📥 Track recibido: ${event.track.kind}`);
        if (event.streams && event.streams[0]) {
            const stream = event.streams[0];
            if (stream === streamLocal) return;
            stream.getAudioTracks().forEach(t => t.enabled = true);
            mostrarVideoRemoto(stream);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate && targetId) {
            socket.emit("ice-candidate", { target: targetId, candidate: event.candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`🔗 ICE: ${pc ? pc.iceConnectionState : 'null'}`);
        if (pc && pc.iceConnectionState === "failed") {
            handleConnectionFailure();
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado: ${pc ? pc.connectionState : 'null'}`);
        if (pc && pc.connectionState === "connected") {
            console.log('✅ CONEXIÓN ESTABLECIDA!');
            actualizarEstado('🟢 Conectado', 'conectado');
            isConnecting = false;
            isOfferSent = false;
        } else if (pc && pc.connectionState === "failed") {
            handleConnectionFailure();
        }
    };

    pc._pendingCandidates = [];
    return pc;
}

// ============================================
// 🔄 MANEJAR FALLAS
// ============================================
function handleConnectionFailure() {
    console.log('❌ Falla de conexión');
    ocultarVideoRemoto();
    limpiarPeer();
    isConnecting = false;
    isOfferSent = false;
    soyOfertante = false;
    rolAsignado = false;
    actualizarEstado('🔴 Desconectado', 'desconectado');
}

// ============================================
// 📤 INICIAR OFERTA
// ============================================
function iniciarOferta(targetId) {
    console.log(`📤 Iniciando oferta para ${targetId}`);
    
    if (isOfferSent) {
        console.log('⏳ Oferta ya enviada');
        return;
    }
    
    if (!pc || pc.signalingState === 'closed') {
        console.warn('⚠️ PC cerrado');
        limpiarPeer();
        isConnecting = false;
        return;
    }
    
    if (pc.signalingState !== 'stable') {
        console.log(`⏳ Signaling state: ${pc.signalingState}, esperando...`);
        setTimeout(() => {
            if (pc && pc.signalingState === 'stable') {
                iniciarOferta(targetId);
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
        console.error('❌ Error:', error);
        limpiarPeer();
        isConnecting = false;
        isOfferSent = false;
    });
}

// ============================================
// 🔗 CONECTAR CON TODOS - VERSIÓN FINAL
// ============================================
function conectarConTodos(clientes) {
    // SI YA ESTAMOS CONECTANDO, SALIR
    if (isConnecting) {
        console.log('⏳ Conexión en proceso...');
        return;
    }
    
    const otros = clientes.filter(id => id !== socket.id);
    if (otros.length === 0) {
        console.log('⏳ No hay otros clientes');
        actualizarEstado('🟢 Esperando otro equipo', 'conectado');
        return;
    }
    
    const targetId = otros[0];
    console.log(`🎯 Conectando con: ${targetId}`);
    
    // SI YA HAY CONEXIÓN, NO CREAR OTRA
    if (pc && pc.connectionState === "connected") {
        console.log('✅ Ya conectado');
        actualizarInfoPeer(targetId);
        return;
    }
    
    // SI YA HAY PEER PERO ESTÁ CONECTANDO, ESPERAR
    if (pc && pc.connectionState === "connecting") {
        console.log('⏳ Ya conectando...');
        return;
    }
    
    // DECIDIR QUIÉN OFERTA (ID MÁS PEQUEÑO = OFERTANTE)
    soyOfertante = socket.id < targetId;
    rolAsignado = true;
    
    console.log(`📌 ROL: ${soyOfertante ? '🟢 OFERTANTE' : '🔴 ANSWER'}`);
    
    isConnecting = true;
    isOfferSent = false;
    
    if (soyOfertante) {
        console.log('📤 INICIANDO COMO OFERTANTE...');
        const newPc = crearPeerConnection(targetId);
        if (newPc && newPc.signalingState !== 'closed') {
            setTimeout(() => iniciarOferta(targetId), 500);
        } else {
            isConnecting = false;
        }
    } else {
        console.log('📥 ESPERANDO COMO ANSWER...');
        actualizarEstado('🟢 Esperando conexión entrante...', 'conectado');
        isConnecting = false;
    }
}

// ============================================
// 📡 EVENTOS SOCKET.IO - VERSIÓN FINAL
// ============================================

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    isConnecting = false;
    isOfferSent = false;
    soyOfertante = false;
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
    
    // IGNORAR SI YA ESTAMOS CONECTADOS
    if (pc && pc.connectionState === "connected") {
        console.log('ℹ️ Ya conectado, ignorando');
        return;
    }
    
    // IGNORAR SI SOMOS OFERTANTE
    if (rolAsignado && soyOfertante) {
        console.log('⚠️ Soy OFERTANTE, ignorando');
        return;
    }
    
    // IGNORAR SI YA ENVIAMOS OFERTA
    if (isOfferSent) {
        console.log('⏳ Ya enviamos oferta, ignorando');
        return;
    }
    
    // IGNORAR SI YA ESTAMOS EN NEGOCIACIÓN
    if (pc && (pc.signalingState === 'have-local-offer' || pc.signalingState === 'have-remote-offer')) {
        console.log('⏳ Ya en negociación');
        return;
    }
    
    // LIMPIAR CONEXIÓN ANTERIOR
    limpiarPeer();
    
    try {
        console.log('📥 RESPONDIENDO COMO ANSWER...');
        const newPc = crearPeerConnection(from);
        if (!newPc) {
            console.error('❌ No se pudo crear PeerConnection');
            return;
        }
        
        if (newPc.signalingState === 'closed') {
            limpiarPeer();
            return;
        }
        
        await newPc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log('✅ Descripción remota establecida');
        
        if (newPc._pendingCandidates && newPc._pendingCandidates.length > 0) {
            for (const candidate of newPc._pendingCandidates) {
                try {
                    await newPc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {}
            }
            newPc._pendingCandidates = [];
        }

        const answer = await newPc.createAnswer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await newPc.setLocalDescription(answer);

        socket.emit("answer", { target: from, answer: newPc.localDescription });
        console.log('✅ Respuesta enviada');
        isConnecting = false;
        actualizarInfoPeer(from);
    } catch (error) {
        console.error('❌ Error:', error);
        limpiarPeer();
        isConnecting = false;
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA DE: ${from}`);
    
    // SOLO EL OFERTANTE PROCESA RESPUESTAS
    if (rolAsignado && !soyOfertante) {
        console.log('⚠️ Soy ANSWER, ignorando');
        return;
    }
    
    if (!pc) {
        console.log('⚠️ No hay peer');
        return;
    }

    if (pc.signalingState === 'closed') {
        limpiarPeer();
        return;
    }

    if (pc.signalingState !== 'have-local-offer') {
        console.log(`ℹ️ Estado ${pc.signalingState}, ignorando`);
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('✅ Descripción remota establecida');
        isConnecting = false;
        isOfferSent = false;
        actualizarInfoPeer(from);
    } catch (error) {
        console.error('❌ Error:', error);
        limpiarPeer();
        isConnecting = false;
        isOfferSent = false;
    }
});

socket.on("ice-candidate", async (data) => {
    const { from, candidate } = data;
    if (!pc) return;

    try {
        if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log('✅ ICE Candidate agregado');
        } else {
            if (!pc._pendingCandidates) pc._pendingCandidates = [];
            pc._pendingCandidates.push(candidate);
            console.log('⏳ ICE Candidate guardado');
        }
    } catch (error) {
        console.warn('⚠️ Error ICE:', error.message);
    }
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Clientes:", lista);
    
    // SI YA HAY CONEXIÓN, NO HACER NADA
    if (pc && pc.connectionState === "connected") {
        console.log('✅ Ya conectado, ignorando lista');
        return;
    }
    
    if (!isConnecting && lista.length > 1) {
        setTimeout(() => conectarConTodos(lista), 500);
    } else if (lista.length === 1) {
        actualizarEstado('🟢 Esperando otro equipo', 'conectado');
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
    if (pc) {
        handleConnectionFailure();
    }
    actualizarEstado('🟢 Esperando otro equipo', 'conectado');
    actualizarInfoPeer(null);
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    handleConnectionFailure();
    actualizarEstado("🔴 Reconectando...", "desconectado");
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
            videoRemoto.volume = vol;
            audioRemoto.volume = vol;
            audioController.setVolume(vol);
            if (labelVolumen) labelVolumen.textContent = `${Math.round(vol * 100)}%`;
        });
    }
    
    if (btnSilenciar) {
        let muted = false;
        btnSilenciar.addEventListener('click', () => {
            muted = !muted;
            videoRemoto.muted = muted;
            audioRemoto.muted = muted;
            audioController.muteAudio(muted);
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
            handleConnectionFailure();
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
    
    const audioTracksLocal = streamLocal ? streamLocal.getAudioTracks() : [];
    const tieneAudioLocal = audioTracksLocal.some(t => t.enabled);
    
    let tieneAudioRemoto = false;
    let audioTracksRemoto = 0;
    if (videoRemoto.srcObject) {
        audioTracksRemoto = videoRemoto.srcObject.getAudioTracks().length;
        tieneAudioRemoto = audioTracksRemoto > 0;
    }
    
    let audioSenders = 0;
    let connectionState = 'N/A';
    if (pc) {
        connectionState = pc.connectionState || 'N/A';
        const senders = pc.getSenders();
        audioSenders = senders.filter(s => s.track && s.track.kind === 'audio').length;
    }
    
    const audioContextState = audioController.getContextState();
    
    badge.innerHTML = `
        <div class="diagnostico-header">📊 DIAGNÓSTICO</div>
        <div class="info-line"><span class="label">🔗 Socket ID:</span><span class="value">${socket.id ? socket.id.substring(0, 8) : 'N/A'}</span></div>
        <div class="info-line"><span class="label">📌 ROL:</span><span class="value ${soyOfertante ? 'success' : 'warning'}">${soyOfertante ? '🟢 OFERTANTE' : rolAsignado ? '🔴 ANSWER' : '⏳ SIN DEFINIR'}</span></div>
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
    limpiarPeer();
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
    audioController.destroyAll();
    socket.disconnect();
});

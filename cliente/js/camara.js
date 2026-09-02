// ============================================
// 🔥 ESPERAR A QUE EL DOM ESTÉ LISTO
// ============================================
document.addEventListener('DOMContentLoaded', function() {
    iniciarApp();
});

function iniciarApp() {

// ============================================
// 📱 CONFIGURACIÓN INICIAL
// ============================================
const gridVideos = document.getElementById("grid-videos");
const audioRemoto = document.getElementById("audio-remoto");

if (!gridVideos || !audioRemoto) {
    console.error('❌ Error: Elementos HTML no encontrados');
    return;
}

const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent);
const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

console.log(`📱 Dispositivo: ${isMobile ? 'Móvil' : 'Desktop'}`);

// ============================================
// 🔌 SOCKET
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
// 📦 VARIABLES
// ============================================
let streamLocal = null;
let turnServers = [];
let isConnecting = false;
let isOfferSent = false;
let soyOfertante = false;
let rolAsignado = false;
let pc = null;
let conectado = false;
let peerId = null;
let audioCreado = false;

// Mapa para almacenar los streams de los peers
const peersStreams = new Map();
// Mapa para almacenar los contenedores de video
const videoContainers = new Map();
// Lista de IDs de peers conectados
let connectedPeers = [];
// ID del video en grande
let videoGrandeId = null;
// Máximo de dispositivos
const MAX_DEVICES = 4;

// ============================================
// 🔊 AUDIO CONTROLLER
// ============================================
class AudioController {
    constructor() {
        this.audioContexts = new Map();
        this.isInitialized = false;
        this.isIOS = isiOS;
        this.globalContext = null;
    }

    async init() {
        if (this.isInitialized && this.globalContext && this.globalContext.state !== 'closed') return true;
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

    createAudioForPeer(stream, peerId) {
        try {
            if (!stream || stream === streamLocal) return false;
            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) return false;
            
            if (this.audioContexts.has(peerId)) this.destroyAudioForPeer(peerId);
            
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
            
            this.audioContexts.set(peerId, { source, gainNode, filter });
            console.log(`✅ Audio creado para peer ${peerId}`);
            audioCreado = true;
            return true;
        } catch (error) {
            console.error('❌ Error creando audio:', error);
            return false;
        }
    }

    setVolume(volume) {
        let success = false;
        for (const [peerId, audioData] of this.audioContexts) {
            if (audioData && audioData.gainNode) {
                audioData.gainNode.gain.value = Math.max(0, Math.min(1, volume));
                success = true;
            }
        }
        return success;
    }

    muteAudio(muted) {
        let success = false;
        for (const [peerId, audioData] of this.audioContexts) {
            if (audioData && audioData.gainNode) {
                audioData.gainNode.gain.value = muted ? 0 : 0.3;
                success = true;
            }
        }
        return success;
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
        if (this.audioContexts.size === 0) {
            audioCreado = false;
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
        audioCreado = false;
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
// 🎵 TRACK SILENCIOSO
// ============================================
function crearTrackAudioSilencioso() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const bufferSize = audioContext.sampleRate * 1;
        const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = 0;
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
// 🔧 UI
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
    if (miId) miId.textContent = `ID: ${socket.id ? socket.id.substring(0, 8) : 'Conectando...'}`;
    if (peerInfo) peerInfo.textContent = `Peer: ${id ? id.substring(0, 8) : 'Ninguno'}`;
    if (id) peerId = id;
}

// ============================================
// 📹 GESTIÓN DE VIDEOS EN GRID
// ============================================

function crearContenedorVideo(id, esLocal = false) {
    // Verificar si ya existe
    if (videoContainers.has(id)) {
        return videoContainers.get(id);
    }
    
    // Verificar límite de dispositivos
    const totalVideos = videoContainers.size;
    if (totalVideos >= MAX_DEVICES) {
        console.warn(`⚠️ Máximo de ${MAX_DEVICES} dispositivos alcanzado`);
        return null;
    }
    
    // Crear contenedor
    const container = document.createElement('div');
    container.className = `video-container ${esLocal ? 'local' : 'remote'}`;
    container.dataset.peerId = id;
    container.dataset.esLocal = esLocal ? 'true' : 'false';
    
    // Crear video
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.webkitPlaysInline = true;
    if (esLocal) video.muted = true;
    video.className = 'video-element';
    
    // Crear etiqueta
    const label = document.createElement('div');
    label.className = `video-label ${esLocal ? 'local-label' : 'remote-label'}`;
    label.textContent = esLocal ? '📷 Tú' : `📹 ${id.substring(0, 6)}`;
    
    // Crear indicador de audio
    const audioIndicator = document.createElement('div');
    audioIndicator.className = 'audio-indicator';
    if (!esLocal) audioIndicator.classList.add('activo');
    
    // Crear indicador de video apagado
    const offIndicator = document.createElement('div');
    offIndicator.className = 'video-off-indicator';
    offIndicator.textContent = '📷';
    offIndicator.style.display = 'none';
    
    // Agregar elementos
    container.appendChild(video);
    container.appendChild(label);
    container.appendChild(audioIndicator);
    container.appendChild(offIndicator);
    
    // Click para hacer grande
    container.addEventListener('click', function(e) {
        // Evitar que se active si se hace clic en los controles
        if (e.target.closest('.btn-control') || e.target.closest('#controles')) return;
        toggleVideoGrande(id);
    });
    
    // Agregar al grid
    gridVideos.appendChild(container);
    videoContainers.set(id, container);
    
    // Actualizar layout
    actualizarLayout();
    
    return container;
}

function actualizarLayout() {
    const containers = Array.from(gridVideos.children);
    const total = containers.length;
    
    // Limpiar clases anteriores
    containers.forEach(c => {
        c.classList.remove('grande', 'pequeno');
    });
    
    if (total === 0) return;
    
    // Si hay un video en grande
    if (videoGrandeId && videoContainers.has(videoGrandeId)) {
        const grande = videoContainers.get(videoGrandeId);
        if (grande) {
            grande.classList.add('grande');
            // Los demás en pequeño
            containers.forEach(c => {
                if (c !== grande) c.classList.add('pequeno');
            });
        }
    } else {
        // Layout normal según cantidad
        if (total === 1) {
            containers[0].style.gridColumn = '1 / -1';
            containers[0].style.gridRow = '1 / -1';
        } else if (total === 2) {
            containers.forEach((c, i) => {
                if (i === 0) {
                    c.style.gridColumn = '1 / 2';
                    c.style.gridRow = '1 / -1';
                } else {
                    c.style.gridColumn = '2 / 3';
                    c.style.gridRow = '1 / -1';
                }
            });
        } else if (total === 3) {
            containers.forEach((c, i) => {
                if (i === 0) {
                    c.style.gridColumn = '1 / 2';
                    c.style.gridRow = '1 / -1';
                } else {
                    c.style.gridColumn = '2 / 3';
                    c.style.gridRow = i === 1 ? '1 / 2' : '2 / -1';
                }
            });
        } else if (total >= 4) {
            containers.forEach((c, i) => {
                const col = (i % 2) + 1;
                const row = Math.floor(i / 2) + 1;
                if (row <= 2 && col <= 2) {
                    c.style.gridColumn = `${col} / ${col + 1}`;
                    c.style.gridRow = `${row} / ${row + 1}`;
                }
            });
        }
    }
}

function toggleVideoGrande(id) {
    if (videoGrandeId === id) {
        // Si ya está grande, lo quitamos
        videoGrandeId = null;
    } else {
        videoGrandeId = id;
    }
    actualizarLayout();
}

function eliminarContenedorVideo(id) {
    const container = videoContainers.get(id);
    if (container) {
        container.remove();
        videoContainers.delete(id);
        if (videoGrandeId === id) {
            videoGrandeId = null;
        }
        actualizarLayout();
        console.log(`🗑️ Contenedor eliminado para ${id}`);
    }
}

function asignarVideo(id, stream, esLocal = false) {
    const container = videoContainers.get(id);
    if (!container) return false;
    
    const video = container.querySelector('video');
    if (!video) return false;
    
    // Si es local y ya tiene stream, no lo cambiamos
    if (esLocal && video.srcObject === stream) return true;
    
    video.srcObject = stream;
    video.style.display = 'block';
    
    // Ocultar indicador de off
    const offIndicator = container.querySelector('.video-off-indicator');
    if (offIndicator) offIndicator.style.display = 'none';
    
    // Marcar como activo
    container.classList.add('activo');
    
    // Si tiene audio, crear contexto de audio
    if (!esLocal && stream.getAudioTracks().length > 0) {
        audioController.createAudioForPeer(stream, id);
    }
    
    // Mostrar indicador de audio si tiene audio
    const audioIndicator = container.querySelector('.audio-indicator');
    if (audioIndicator) {
        if (stream.getAudioTracks().length > 0) {
            audioIndicator.classList.add('activo');
        } else {
            audioIndicator.classList.remove('activo');
        }
    }
    
    console.log(`✅ Video asignado para ${id}`);
    return true;
}

// ============================================
// 🌐 TURN SERVERS
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
            urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:3478"],
            username: "openrelayproject",
            credential: "openrelayproject"
        }
    ];
    return turnServers;
}

// ============================================
// 🧹 LIMPIAR PEER
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
    isConnecting = false;
    isOfferSent = false;
    conectado = false;
}

// ============================================
// 🔥 CREAR PEER
// ============================================
function crearPeerConnection(id) {
    limpiarPeer();
    
    console.log(`🔗 Creando conexión con: ${id}`);
    
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
        console.log(`📥 Track recibido: ${event.track.kind} de ${id}`);
        if (event.streams && event.streams[0]) {
            const stream = event.streams[0];
            if (stream === streamLocal) return;
            
            stream.getAudioTracks().forEach(t => t.enabled = true);
            
            // Guardar stream
            peersStreams.set(id, stream);
            
            // Crear contenedor si no existe
            if (!videoContainers.has(id)) {
                crearContenedorVideo(id, false);
            }
            
            // Asignar video
            asignarVideo(id, stream, false);
            
            // Actualizar estado
            actualizarEstado(`🟢 Conectado a ${id.substring(0, 6)}`, 'conectado');
            actualizarInfoPeer(id);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate && id) {
            socket.emit("ice-candidate", { target: id, candidate: event.candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`🔗 ICE: ${pc ? pc.iceConnectionState : 'null'} para ${id}`);
        if (pc && pc.iceConnectionState === "failed") {
            handleFailure(id);
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado: ${pc ? pc.connectionState : 'null'} para ${id}`);
        if (pc && pc.connectionState === "connected") {
            console.log(`✅ CONEXIÓN ESTABLECIDA con ${id}!`);
            conectado = true;
            isConnecting = false;
            isOfferSent = false;
        } else if (pc && pc.connectionState === "failed") {
            handleFailure(id);
        }
    };

    pc._pendingCandidates = [];
    return pc;
}

// ============================================
// 🔄 MANEJAR FALLAS
// ============================================
function handleFailure(id) {
    console.log(`❌ Falla de conexión con ${id}`);
    
    // Eliminar contenedor
    if (id) {
        eliminarContenedorVideo(id);
        peersStreams.delete(id);
        audioController.destroyAudioForPeer(id);
    }
    
    // Limpiar peer
    limpiarPeer();
    isConnecting = false;
    isOfferSent = false;
    soyOfertante = false;
    rolAsignado = false;
    conectado = false;
    actualizarEstado('🔴 Desconectado', 'desconectado');
}

// ============================================
// 📤 INICIAR OFERTA
// ============================================
function iniciarOferta(id) {
    console.log(`📤 Iniciando oferta para ${id}`);
    
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
                iniciarOferta(id);
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
        socket.emit("offer", { target: id, offer: pc.localDescription });
        console.log(`✅ Oferta enviada a ${id}`);
        actualizarEstado(`🔄 Conectando con ${id.substring(0, 6)}...`, 'inicializando');
    })
    .catch(error => {
        console.error('❌ Error:', error);
        limpiarPeer();
        isConnecting = false;
        isOfferSent = false;
    });
}

// ============================================
// 🔗 CONECTAR
// ============================================
function conectarConTodos(clientes) {
    // Filtrar clientes que ya están conectados
    const conectadosActuales = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
    const disponibles = clientes.filter(id => 
        id !== socket.id && 
        !conectadosActuales.includes(id) &&
        videoContainers.size < MAX_DEVICES
    );
    
    if (disponibles.length === 0) {
        console.log('⏳ No hay nuevos clientes disponibles');
        if (videoContainers.size === 0) {
            actualizarEstado('🟢 Esperando otro equipo', 'conectado');
        }
        return;
    }
    
    const id = disponibles[0];
    console.log(`🎯 Conectando con: ${id}`);
    
    if (isConnecting) {
        console.log('⏳ Conexión en proceso...');
        return;
    }
    
    soyOfertante = socket.id < id;
    rolAsignado = true;
    
    console.log(`📌 ROL: ${soyOfertante ? '🟢 OFERTANTE' : '🔴 ANSWER'}`);
    
    isConnecting = true;
    isOfferSent = false;
    
    if (soyOfertante) {
        console.log('📤 INICIANDO COMO OFERTANTE...');
        const newPc = crearPeerConnection(id);
        if (newPc && newPc.signalingState !== 'closed') {
            setTimeout(() => iniciarOferta(id), 500);
        } else {
            isConnecting = false;
        }
    } else {
        console.log('📥 ESPERANDO COMO ANSWER...');
        actualizarEstado('🟢 Esperando conexión...', 'conectado');
        isConnecting = false;
    }
}

// ============================================
// 📡 EVENTOS SOCKET
// ============================================

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    isConnecting = false;
    isOfferSent = false;
    soyOfertante = false;
    rolAsignado = false;
    conectado = false;
    actualizarEstado("🟢 Conectado al servidor", "conectado");
    actualizarInfoPeer(null);
    
    // Crear contenedor local
    if (!videoContainers.has(socket.id)) {
        crearContenedorVideo(socket.id, true);
    }
    
    await obtenerTurnServers();
    await audioController.init();
    
    // Iniciar cámara
    await iniciarCamara();
    
    setTimeout(() => socket.emit("clientes-conectados"), 1500);
});

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA DE: ${from}`);
    
    // Verificar límite de dispositivos
    if (videoContainers.size >= MAX_DEVICES) {
        console.warn(`⚠️ Máximo de ${MAX_DEVICES} dispositivos alcanzado, ignorando oferta`);
        return;
    }
    
    if (conectado || (pc && pc.connectionState === "connected")) {
        console.log('ℹ️ Ya conectado, ignorando oferta');
        return;
    }
    
    if (soyOfertante) {
        console.log('⚠️ Soy OFERTANTE, ignorando');
        return;
    }
    
    if (isOfferSent) {
        console.log('⏳ Ya enviamos oferta, ignorando');
        return;
    }
    
    if (pc && (pc.signalingState === 'have-local-offer' || pc.signalingState === 'have-remote-offer')) {
        console.log('⏳ Ya en negociación');
        return;
    }
    
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
    
    if (!soyOfertante) {
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
    
    // Verificar si hay espacio para más conexiones
    if (videoContainers.size >= MAX_DEVICES) {
        console.log(`ℹ️ Ya hay ${MAX_DEVICES} dispositivos conectados`);
        return;
    }
    
    // Eliminar clientes que ya no están
    const conectadosActuales = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
    for (const id of conectadosActuales) {
        if (!lista.includes(id)) {
            eliminarContenedorVideo(id);
            peersStreams.delete(id);
            audioController.destroyAudioForPeer(id);
        }
    }
    
    // Conectar con nuevos clientes
    if (!isConnecting && !conectado) {
        setTimeout(() => conectarConTodos(lista), 500);
    }
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente:", data.id);
    if (videoContainers.size < MAX_DEVICES && !conectado && !isConnecting) {
        setTimeout(() => socket.emit("clientes-conectados"), 1000);
    }
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    if (data.id) {
        eliminarContenedorVideo(data.id);
        peersStreams.delete(data.id);
        audioController.destroyAudioForPeer(data.id);
        if (peerId === data.id) {
            actualizarInfoPeer(null);
        }
    }
    actualizarEstado('🟢 Esperando otro equipo', 'conectado');
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    // Limpiar todos los videos remotos
    const ids = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
    for (const id of ids) {
        eliminarContenedorVideo(id);
        peersStreams.delete(id);
        audioController.destroyAudioForPeer(id);
    }
    limpiarPeer();
    isConnecting = false;
    isOfferSent = false;
    conectado = false;
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
        
        // Asignar video local
        const container = videoContainers.get(socket.id);
        if (container) {
            const video = container.querySelector('video');
            if (video) {
                video.srcObject = stream;
                video.muted = true;
                video.volume = 0;
                video.style.display = 'block';
                
                try { 
                    await video.play(); 
                    console.log('📹 Video local reproduciendo');
                } catch(e) {
                    console.warn('⚠️ Error en video local:', e.message);
                }
            }
        }
        
        await obtenerTurnServers();
        await audioController.init();
        isConnecting = false;
        isOfferSent = false;
        soyOfertante = false;
        rolAsignado = false;
        conectado = false;
        actualizarEstado("🟢 Cámara lista", "conectado");
        
        // Conectar con peers existentes
        setTimeout(() => socket.emit("clientes-conectados"), 1000);
    } catch (error) {
        console.error("❌ Error:", error);
        alert("⚠️ No se pudo acceder a la cámara/micrófono.\n\n" + error.message);
        actualizarEstado("🔴 Error de cámara", "desconectado");
    }
}

// ============================================
// 🎛️ CONTROLES
// ============================================
document.addEventListener('DOMContentLoaded', function() {
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
            audioController.setVolume(vol);
            if (labelVolumen) labelVolumen.textContent = `${Math.round(vol * 100)}%`;
        });
    }
    
    if (btnSilenciar) {
        let muted = false;
        btnSilenciar.addEventListener('click', () => {
            muted = !muted;
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
            // Mostrar/ocultar indicador en video local
            const container = videoContainers.get(socket.id);
            if (container) {
                const offIndicator = container.querySelector('.video-off-indicator');
                if (offIndicator) {
                    offIndicator.style.display = videoEnabled ? 'none' : 'block';
                }
                const video = container.querySelector('video');
                if (video) {
                    video.style.display = videoEnabled ? 'block' : 'none';
                }
            }
            btnToggleCamara.textContent = videoEnabled ? '📷 Cámara' : '📷 Apagada';
            btnToggleCamara.classList.toggle('activo', videoEnabled);
            btnToggleCamara.classList.toggle('inactivo', !videoEnabled);
        });
        btnToggleCamara.classList.add('activo');
    }
    
    if (btnFullscreen) {
        btnFullscreen.addEventListener('click', () => {
            const container = videoGrandeId ? videoContainers.get(videoGrandeId) : null;
            const elemento = container ? container.querySelector('video') : gridVideos;
            if (elemento) {
                if (elemento.requestFullscreen) {
                    elemento.requestFullscreen();
                } else if (elemento.webkitRequestFullscreen) {
                    elemento.webkitRequestFullscreen();
                }
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
            // Limpiar todo
            const ids = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
            for (const id of ids) {
                eliminarContenedorVideo(id);
                peersStreams.delete(id);
                audioController.destroyAudioForPeer(id);
            }
            limpiarPeer();
            isConnecting = false;
            isOfferSent = false;
            conectado = false;
            socket.disconnect();
            setTimeout(() => {
                socket.connect();
                // Recrear contenedor local si no existe
                if (!videoContainers.has(socket.id)) {
                    crearContenedorVideo(socket.id, true);
                    if (streamLocal) {
                        const container = videoContainers.get(socket.id);
                        if (container) {
                            const video = container.querySelector('video');
                            if (video) {
                                video.srcObject = streamLocal;
                                video.muted = true;
                                video.play().catch(() => {});
                            }
                        }
                    }
                }
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
    
    const videoContainersCount = videoContainers.size;
    const peersConnected = Array.from(videoContainers.keys()).filter(id => id !== socket.id).length;
    
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
        <div class="info-line"><span class="label">📹 Videos totales:</span><span class="value">${videoContainersCount}</span></div>
        <div class="info-line"><span class="label">👥 Peers conectados:</span><span class="value">${peersConnected}/${MAX_DEVICES - 1}</span></div>
        <div class="info-line"><span class="label">🎤 Micrófono LOCAL:</span><span class="value ${!tieneAudioLocal ? 'error' : ''}">${tieneAudioLocal ? '✅ Activo' : '❌ Sin audio'}</span></div>
        <div class="info-line"><span class="label">📤 Envío de audio:</span><span class="value ${audioSenders === 0 ? 'error' : ''}">${audioSenders > 0 ? `✅ ${audioSenders} sender` : '❌ Sin sender'}</span></div>
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
// Crear contenedor local
crearContenedorVideo(socket.id, true);

} // FIN DE iniciarApp()

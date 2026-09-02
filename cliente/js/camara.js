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
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 30000,
    forceNew: true,
    autoConnect: true
});

// ============================================
// 📦 VARIABLES GLOBALES
// ============================================
let streamLocal = null;
let turnServers = [];
let isConnecting = false;
let conectado = false;

// Mapa para almacenar las conexiones PeerConnection por peerId
const peerConnections = new Map();
// Mapa para almacenar los streams de los peers
const peersStreams = new Map();
// Mapa para almacenar los contenedores de video
const videoContainers = new Map();
// ID del video en grande
let videoGrandeId = null;
// Máximo de dispositivos
const MAX_DEVICES = 4;
// Estado de audio silenciado
let isAudioMuted = false;
// Control de volumen
let currentVolume = 0.3;
// 🔥 ID del dispositivo que inicia las conexiones
let orquestadorId = null;

// ============================================
// 🔊 AUDIO CONTROLLER
// ============================================
class AudioController {
    constructor() {
        this.audioContexts = new Map();
        this.isInitialized = false;
        this.isIOS = isiOS;
        this.globalContext = null;
        this.volume = 0.3;
        this.muted = false;
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
            
            if (this.audioContexts.has(peerId)) {
                this.destroyAudioForPeer(peerId);
            }
            
            if (!this.globalContext || this.globalContext.state === 'closed') {
                this.isInitialized = false;
                return false;
            }
            
            const source = this.globalContext.createMediaStreamSource(stream);
            const gainNode = this.globalContext.createGain();
            const vol = this.muted ? 0 : this.volume;
            gainNode.gain.value = vol;
            
            const filter = this.globalContext.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = isMobile ? 6000 : 8000;
            
            source.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(this.globalContext.destination);
            
            this.audioContexts.set(peerId, { source, gainNode, filter });
            console.log(`✅ Audio creado para peer ${peerId} (vol: ${vol})`);
            return true;
        } catch (error) {
            console.error('❌ Error creando audio:', error);
            return false;
        }
    }

    setVolume(volume) {
        this.volume = Math.max(0, Math.min(1, volume));
        const vol = this.muted ? 0 : this.volume;
        let success = false;
        for (const [peerId, audioData] of this.audioContexts) {
            if (audioData && audioData.gainNode) {
                audioData.gainNode.gain.value = vol;
                success = true;
            }
        }
        return success;
    }

    toggleMute() {
        this.muted = !this.muted;
        const vol = this.muted ? 0 : this.volume;
        for (const [peerId, audioData] of this.audioContexts) {
            if (audioData && audioData.gainNode) {
                audioData.gainNode.gain.value = vol;
            }
        }
        return this.muted;
    }

    muteAudio(muted) {
        this.muted = muted;
        const vol = this.muted ? 0 : this.volume;
        for (const [peerId, audioData] of this.audioContexts) {
            if (audioData && audioData.gainNode) {
                audioData.gainNode.gain.value = vol;
            }
        }
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

function actualizarInfoPeer() {
    const miId = document.getElementById('mi-id');
    const peerInfo = document.getElementById('peer-conectado');
    if (miId) miId.textContent = `ID: ${socket.id ? socket.id.substring(0, 8) : 'Conectando...'}`;
    
    const peers = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
    if (peers.length > 0) {
        peerInfo.textContent = `Peer: ${peers.length} conectados`;
    } else {
        peerInfo.textContent = 'Peer: Ninguno';
    }
}

// ============================================
// 📹 GESTIÓN DE VIDEOS EN GRID
// ============================================

function crearContenedorVideo(id, esLocal = false) {
    if (videoContainers.has(id)) {
        return videoContainers.get(id);
    }
    
    const totalVideos = videoContainers.size;
    if (totalVideos >= MAX_DEVICES) {
        console.warn(`⚠️ Máximo de ${MAX_DEVICES} dispositivos alcanzado`);
        return null;
    }
    
    const container = document.createElement('div');
    container.className = `video-container ${esLocal ? 'local' : 'remote'}`;
    container.dataset.peerId = id;
    container.dataset.esLocal = esLocal ? 'true' : 'false';
    
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.webkitPlaysInline = true;
    if (esLocal) video.muted = true;
    video.className = 'video-element';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'cover';
    video.style.background = '#1a1a1a';
    
    const label = document.createElement('div');
    label.className = `video-label ${esLocal ? 'local-label' : 'remote-label'}`;
    label.textContent = esLocal ? '📷 Tú' : `📹 ${id.substring(0, 6)}`;
    
    const audioIndicator = document.createElement('div');
    audioIndicator.className = 'audio-indicator';
    if (!esLocal) audioIndicator.classList.add('activo');
    
    const offIndicator = document.createElement('div');
    offIndicator.className = 'video-off-indicator';
    offIndicator.textContent = '📷';
    offIndicator.style.display = 'none';
    
    container.appendChild(video);
    container.appendChild(label);
    container.appendChild(audioIndicator);
    container.appendChild(offIndicator);
    
    container.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleVideoGrande(id);
    });
    
    gridVideos.appendChild(container);
    videoContainers.set(id, container);
    
    actualizarLayout();
    actualizarInfoPeer();
    
    return container;
}

// ============================================
// 🎨 NUEVA FUNCIÓN ACTUALIZAR LAYOUT
// ============================================
function actualizarLayout() {
    const containers = Array.from(gridVideos.children);
    const total = containers.length;
    
    containers.forEach(c => {
        c.style.position = 'static';
        c.style.width = '';
        c.style.height = '';
        c.style.left = '';
        c.style.top = '';
        c.style.zIndex = '';
        c.style.borderRadius = '';
        c.style.boxShadow = '';
        c.classList.remove('grande', 'pequeno');
        
        const label = c.querySelector('.video-label');
        if (label) label.style.display = 'block';
    });

    document.body.classList.remove('layout-especial');

    if (total === 0) return;

    if (total === 1 || (videoGrandeId && videoContainers.has(videoGrandeId))) {
        const grande = videoGrandeId ? videoContainers.get(videoGrandeId) : containers[0];
        if (grande && grande.parentNode) {
            containers.forEach(c => {
                if (c !== grande) {
                    c.classList.add('pequeno');
                    c.style.borderRadius = '8px';
                    c.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
                    const label = c.querySelector('.video-label');
                    if (label) label.style.display = 'none';
                } else {
                    c.classList.add('grande');
                }
            });
            return;
        }
    }

    if (total === 2) {
        document.body.classList.add('layout-especial');
        containers.forEach((c, i) => {
            c.style.position = 'absolute';
            c.style.top = '0';
            c.style.height = '100%';
            c.style.width = '50%';
            c.style.borderRadius = '0';
            c.style.zIndex = '1';
            if (i === 0) {
                c.style.left = '0';
            } else {
                c.style.left = '50%';
            }
        });
        return;
    }

    if (total === 3) {
        document.body.classList.add('layout-especial');
        containers.forEach((c, i) => {
            c.style.position = 'absolute';
            c.style.borderRadius = '0';
            c.style.zIndex = '1';
            if (i === 0) {
                c.style.top = '0';
                c.style.left = '0';
                c.style.width = '50%';
                c.style.height = '100%';
            } else {
                c.style.left = '50%';
                c.style.width = '50%';
                c.style.height = '50%';
                if (i === 1) {
                    c.style.top = '0';
                } else {
                    c.style.top = '50%';
                }
            }
        });
        return;
    }

    if (total >= 4) {
        document.body.classList.add('layout-especial');
        containers.forEach((c, i) => {
            c.style.position = 'absolute';
            c.style.width = '50%';
            c.style.height = '50%';
            c.style.borderRadius = '0';
            c.style.zIndex = '1';
            const col = (i % 2);
            const row = Math.floor(i / 2);
            c.style.left = `${col * 50}%`;
            c.style.top = `${row * 50}%`;
        });
        return;
    }
}

function toggleVideoGrande(id) {
    if (videoGrandeId === id) {
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
        if (peerConnections.has(id)) {
            try {
                const pc = peerConnections.get(id);
                pc.close();
            } catch (e) {}
            peerConnections.delete(id);
        }
        peersStreams.delete(id);
        audioController.destroyAudioForPeer(id);
        actualizarLayout();
        actualizarInfoPeer();
        console.log(`🗑️ Contenedor eliminado para ${id}`);
    }
}

function asignarVideo(id, stream, esLocal = false) {
    const container = videoContainers.get(id);
    if (!container) return false;
    
    const video = container.querySelector('video');
    if (!video) return false;
    
    video.srcObject = stream;
    video.style.display = 'block';
    
    const offIndicator = container.querySelector('.video-off-indicator');
    if (offIndicator) offIndicator.style.display = 'none';
    
    container.classList.add('activo');
    
    if (!esLocal && stream.getAudioTracks().length > 0) {
        audioController.createAudioForPeer(stream, id);
    }
    
    const audioIndicator = container.querySelector('.audio-indicator');
    if (audioIndicator) {
        if (!esLocal && stream.getAudioTracks().length > 0) {
            audioIndicator.classList.add('activo');
        } else {
            audioIndicator.classList.remove('activo');
        }
    }
    
    if (!esLocal) {
        video.play().catch(() => {
            console.log('⏳ Esperando interacción para reproducir video');
        });
    } else {
        video.muted = true;
        video.play().catch(() => {});
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
// 🔥 CREAR PEER CONNECTION
// ============================================
function crearPeerConnection(peerId) {
    if (peerConnections.has(peerId)) {
        try {
            const oldPc = peerConnections.get(peerId);
            oldPc.close();
        } catch (e) {}
        peerConnections.delete(peerId);
    }
    
    console.log(`🔗 Creando conexión con: ${peerId}`);
    
    try {
        const pc = new RTCPeerConnection({
            iceServers: turnServers,
            iceCandidatePoolSize: 10,
            bundlePolicy: "max-bundle",
            rtcpMuxPolicy: "require"
        });
        
        peerConnections.set(peerId, pc);
        
        if (streamLocal) {
            asegurarAudioLocal();
            streamLocal.getTracks().forEach(track => {
                try {
                    pc.addTrack(track, streamLocal);
                    console.log(`✅ Track agregado: ${track.kind} para ${peerId}`);
                } catch (error) {
                    console.error(`❌ Error agregando track ${track.kind}:`, error);
                }
            });
        }
        
        pc.ontrack = (event) => {
            console.log(`📥 Track recibido: ${event.track.kind} de ${peerId}`);
            if (event.streams && event.streams[0]) {
                const stream = event.streams[0];
                if (stream === streamLocal) return;
                
                stream.getAudioTracks().forEach(t => t.enabled = true);
                peersStreams.set(peerId, stream);
                
                if (!videoContainers.has(peerId)) {
                    crearContenedorVideo(peerId, false);
                }
                
                asignarVideo(peerId, stream, false);
                
                const peers = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
                actualizarEstado(`🟢 Conectado a ${peers.length} dispositivo(s)`, 'conectado');
                actualizarInfoPeer();
            }
        };
        
        pc.onicecandidate = (event) => {
            if (event.candidate && peerId) {
                socket.emit("ice-candidate", { 
                    target: peerId, 
                    candidate: event.candidate 
                });
            }
        };
        
        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            console.log(`🔗 ICE: ${state} para ${peerId}`);
            if (state === "failed" || state === "disconnected") {
                handlePeerDisconnect(peerId);
            }
        };
        
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log(`🔗 Estado: ${state} para ${peerId}`);
            if (state === "connected") {
                console.log(`✅ CONEXIÓN ESTABLECIDA con ${peerId}!`);
                conectado = true;
                isConnecting = false;
                actualizarEstado(`🟢 Conectado a ${videoContainers.size - 1} dispositivo(s)`, 'conectado');
                actualizarInfoPeer();
            } else if (state === "failed" || state === "disconnected") {
                handlePeerDisconnect(peerId);
            }
        };
        
        pc._pendingCandidates = [];
        return pc;
    } catch (error) {
        console.error('❌ Error creando RTCPeerConnection:', error);
        return null;
    }
}

// ============================================
// 🔄 MANEJAR DESCONEXIÓN DE PEER
// ============================================
function handlePeerDisconnect(peerId) {
    console.log(`❌ Desconectado de ${peerId}`);
    if (peerId) {
        eliminarContenedorVideo(peerId);
    }
    isConnecting = false;
    conectado = false;
    
    const peers = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
    if (peers.length === 0) {
        actualizarEstado('🟢 Esperando otro equipo', 'conectado');
        actualizarInfoPeer();
    } else {
        actualizarEstado(`🟢 Conectado a ${peers.length} dispositivo(s)`, 'conectado');
        actualizarInfoPeer();
    }
}

// ============================================
// 📤 INICIAR OFERTA
// ============================================
async function iniciarOferta(peerId) {
    const pc = peerConnections.get(peerId);
    if (!pc) {
        console.warn('⚠️ No hay peer connection para', peerId);
        return;
    }
    
    if (pc.signalingState !== 'stable') {
        console.log(`⏳ Signaling state: ${pc.signalingState}, esperando...`);
        setTimeout(() => {
            if (peerConnections.has(peerId)) {
                iniciarOferta(peerId);
            }
        }, 500);
        return;
    }
    
    try {
        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        socket.emit("offer", { target: peerId, offer: pc.localDescription });
        console.log(`✅ Oferta enviada a ${peerId}`);
        actualizarEstado(`🔄 Conectando con ${peerId.substring(0, 6)}...`, 'inicializando');
    } catch (error) {
        console.error('❌ Error creando oferta:', error);
        handlePeerDisconnect(peerId);
    }
}

// ============================================
// 🔗 CONECTAR CON PEERS (SOLO ORQUESTADOR)
// ============================================
function conectarConPeers(clientes) {
    const conectadosActuales = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
    const disponibles = clientes.filter(id => 
        id !== socket.id && 
        !conectadosActuales.includes(id) &&
        videoContainers.size < MAX_DEVICES
    );
    
    if (disponibles.length === 0) return;

    // 🔥 SOLO EL ORQUESTADOR INICIA LAS CONEXIONES (Corregido con ID del servidor)
    if (socket.id !== orquestadorId) {
        console.log(`⏳ No soy el orquestador (${orquestadorId}). Esperando oferta...`);
        return; // Los demás solo esperan
    }

    console.log(`👑 Soy el ORQUESTADOR. Conectando con ${disponibles.length} dispositivo(s)...`);

    for (const peerId of disponibles) {
        if (videoContainers.size >= MAX_DEVICES) break;
        if (peerConnections.has(peerId)) continue;
        
        console.log(`🎯 Conectando con: ${peerId}`);
        const pc = crearPeerConnection(peerId);
        if (!pc) continue;
        
        setTimeout(() => iniciarOferta(peerId), 500);
    }
}

// ============================================
// 📡 EVENTOS SOCKET
// ============================================

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    isConnecting = false;
    conectado = false;
    actualizarEstado("🟢 Conectado al servidor", "conectado");
    actualizarInfoPeer();
    
    if (!videoContainers.has(socket.id)) {
        crearContenedorVideo(socket.id, true);
    }
    
    await obtenerTurnServers();
    await audioController.init();
    await iniciarCamara();
});

// 🔥 NUEVO EVENTO PARA SABER QUIÉN ES EL ORQUESTADOR
socket.on("actualizar-orquestador", (data) => {
    orquestadorId = data.orquestadorId;
    console.log(`👑 Orquestador actual: ${orquestadorId}`);
    
    // Si me acabo de convertir en orquestador, debo intentar conectar con todos
    if (socket.id === orquestadorId) {
        socket.emit("clientes-conectados"); // Fuerza a reconectar con todos
    }
});

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA DE: ${from}`);
    
    if (videoContainers.size >= MAX_DEVICES) {
        console.warn(`⚠️ Máximo de ${MAX_DEVICES} dispositivos alcanzado, ignorando oferta`);
        return;
    }
    
    if (peerConnections.has(from)) {
        console.log('ℹ️ Ya conectado a este peer');
        return;
    }
    
    try {
        console.log('📥 RESPONDIENDO COMO ANSWER...');
        const pc = crearPeerConnection(from);
        if (!pc) {
            console.error('❌ No se pudo crear PeerConnection');
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log('✅ Descripción remota establecida');
        
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
        console.log('✅ Respuesta enviada');
        isConnecting = false;
        actualizarInfoPeer();
    } catch (error) {
        console.error('❌ Error:', error);
        handlePeerDisconnect(from);
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA DE: ${from}`);
    
    const pc = peerConnections.get(from);
    if (!pc) {
        console.log('⚠️ No hay peer para esta respuesta');
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
        actualizarInfoPeer();
    } catch (error) {
        console.error('❌ Error:', error);
        handlePeerDisconnect(from);
    }
});

socket.on("ice-candidate", async (data) => {
    const { from, candidate } = data;
    const pc = peerConnections.get(from);
    if (!pc) return;
    
    try {
        if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log('✅ ICE Candidate agregado para', from);
        } else {
            if (!pc._pendingCandidates) pc._pendingCandidates = [];
            pc._pendingCandidates.push(candidate);
            console.log('⏳ ICE Candidate guardado para', from);
        }
    } catch (error) {
        console.warn('⚠️ Error ICE:', error.message);
    }
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Clientes:", lista);
    
    const conectadosActuales = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
    for (const id of conectadosActuales) {
        if (!lista.includes(id)) {
            eliminarContenedorVideo(id);
        }
    }
    
    if (videoContainers.size < MAX_DEVICES) {
        setTimeout(() => conectarConPeers(lista), 500);
    }
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente:", data.id);
    if (videoContainers.size < MAX_DEVICES) {
        setTimeout(() => socket.emit("clientes-conectados"), 1000);
    }
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    if (data.id) {
        eliminarContenedorVideo(data.id);
    }
    actualizarEstado('🟢 Esperando otro equipo', 'conectado');
    actualizarInfoPeer();
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    const ids = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
    for (const id of ids) {
        eliminarContenedorVideo(id);
    }
    for (const [id, pc] of peerConnections) {
        try { pc.close(); } catch (e) {}
    }
    peerConnections.clear();
    isConnecting = false;
    conectado = false;
    actualizarEstado("🔴 Reconectando...", "desconectado");
});

socket.on("reconnect", () => {
    console.log("🔄 Reconectado al servidor");
    actualizarEstado("🟢 Reconectado", "conectado");
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
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
        
        actualizarEstado("🟢 Cámara lista", "conectado");
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
function configurarControles() {
    const controlVolumen = document.getElementById('volumen');
    const labelVolumen = document.getElementById('volumen-label');
    const btnSilenciar = document.getElementById('btn-silenciar');
    const btnReconectar = document.getElementById('btn-reconectar');
    const btnToggleCamara = document.getElementById('btn-camara');
    const btnToggleMicrofono = document.getElementById('btn-microfono');
    const btnFullscreen = document.getElementById('btn-fullscreen');
    const btnDiagnostico = document.getElementById('btn-diagnostico');
    
    if (controlVolumen) {
        controlVolumen.value = currentVolume;
        controlVolumen.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            currentVolume = vol;
            audioController.setVolume(vol);
            if (labelVolumen) labelVolumen.textContent = `${Math.round(vol * 100)}%`;
        });
    }
    
    if (btnSilenciar) {
        btnSilenciar.addEventListener('click', () => {
            const muted = audioController.toggleMute();
            btnSilenciar.textContent = muted ? '🔊 Activar' : '🔇 Silenciar';
            btnSilenciar.classList.toggle('silenciado', muted);
            isAudioMuted = muted;
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
            if (videoGrandeId && videoContainers.has(videoGrandeId)) {
                const container = videoContainers.get(videoGrandeId);
                const video = container.querySelector('video');
                if (video) {
                    if (video.requestFullscreen) {
                        video.requestFullscreen().catch(() => {});
                    } else if (video.webkitRequestFullscreen) {
                        video.webkitRequestFullscreen();
                    } else if (video.mozRequestFullScreen) {
                        video.mozRequestFullScreen();
                    } else if (video.msRequestFullscreen) {
                        video.msRequestFullscreen();
                    }
                }
            } else {
                if (gridVideos.requestFullscreen) {
                    gridVideos.requestFullscreen().catch(() => {});
                } else if (gridVideos.webkitRequestFullscreen) {
                    gridVideos.webkitRequestFullscreen();
                } else if (gridVideos.mozRequestFullScreen) {
                    gridVideos.mozRequestFullScreen();
                } else if (gridVideos.msRequestFullscreen) {
                    gridVideos.msRequestFullscreen();
                }
            }
        });
    }
    
    if (btnReconectar) {
        btnReconectar.addEventListener('click', () => {
            console.log("🔄 Forzando reconexión...");
            const ids = Array.from(videoContainers.keys()).filter(id => id !== socket.id);
            for (const id of ids) {
                eliminarContenedorVideo(id);
            }
            for (const [id, pc] of peerConnections) {
                try { pc.close(); } catch (e) {}
            }
            peerConnections.clear();
            isConnecting = false;
            conectado = false;
            videoGrandeId = null;
            
            socket.disconnect();
            setTimeout(() => {
                socket.connect();
                actualizarEstado("🔄 Reconectando...", "inicializando");
            }, 500);
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
    
    if (isiOS) {
        document.addEventListener('touchstart', () => {
            audioController.resumeContext();
        });
    }
}

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
    const audioContextState = audioController.getContextState();
    
    let connectionStates = '';
    for (const [id, pc] of peerConnections) {
        const state = pc.connectionState || 'N/A';
        const iceState = pc.iceConnectionState || 'N/A';
        connectionStates += `<div class="info-line"><span class="label">🔗 ${id.substring(0, 6)}:</span><span class="value">${state} (ICE: ${iceState})</span></div>`;
    }
    
    badge.innerHTML = `
        <div class="diagnostico-header">📊 DIAGNÓSTICO</div>
        <div class="info-line"><span class="label">🔗 Socket ID:</span><span class="value">${socket.id ? socket.id.substring(0, 8) : 'N/A'}</span></div>
        <div class="info-line"><span class="label">📹 Videos totales:</span><span class="value">${videoContainersCount}</span></div>
        <div class="info-line"><span class="label">👥 Peers conectados:</span><span class="value">${peersConnected}/${MAX_DEVICES - 1}</span></div>
        <div class="info-line"><span class="label">🎤 Micrófono LOCAL:</span><span class="value ${!tieneAudioLocal ? 'error' : ''}">${tieneAudioLocal ? '✅ Activo' : '❌ Sin audio'}</span></div>
        <div class="info-line"><span class="label">🎚️ AudioContext:</span><span class="value ${audioContextState === 'suspended' ? 'warning' : ''}">${audioContextState}</span></div>
        <div class="info-line" style="border-bottom: none;"><span class="label">🔇 Audio silenciado:</span><span class="value">${isAudioMuted ? '✅ Sí' : '❌ No'}</span></div>
        ${connectionStates}
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

if (socket.id) {
    crearContenedorVideo(socket.id, true);
}

configurarControles();
actualizarEstado('🟢 Inicializando...', 'inicializando');

document.addEventListener('DOMContentLoaded', function() {
    if (!videoContainers.has(socket.id) && socket.id) {
        crearContenedorVideo(socket.id, true);
    }
});

console.log('🚀 Aplicación iniciada correctamente');

} // FIN DE iniciarApp()

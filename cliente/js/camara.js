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
let isAudioInitialized = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ============================================
// 🔊 CONTROL DE AUDIO - SIN RETROALIMENTACIÓN
// ============================================
class AudioController {
    constructor() {
        this.audioContexts = new Map();
        this.gainNodes = new Map();
        this.isInitialized = false;
        this.isIOS = isiOS;
        this.isSafari = isSafari;
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

    // Crear audio SOLO para el stream remoto (NO para el local)
    createAudioForPeer(peerId, stream) {
        try {
            if (!stream) return false;
            
            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) {
                console.log(`ℹ️ No hay audio en stream para ${peerId}`);
                return false;
            }

            // Verificar que NO sea el stream local
            if (stream === streamLocal) {
                console.log(`⚠️ Intentando crear audio con stream local - ignorado`);
                return false;
            }

            // Verificar y habilitar tracks de audio remotos
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

            // Crear fuente de audio a partir del stream remoto
            const source = this.globalContext.createMediaStreamSource(stream);
            const gainNode = this.globalContext.createGain();
            gainNode.gain.value = 0.3; // Volumen inicial
            
            // Filtro para mejorar calidad de voz
            const filter = this.globalContext.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = isMobile ? 6000 : 8000;
            
            // Conectar: fuente remota -> filtro -> ganancia -> destino (altavoces)
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

// EL VIDEO LOCAL DEBE ESTAR MUTEADO SIEMPRE
video.muted = true;
video.volume = 0;

// EL VIDEO REMOTO NO DEBE ESTAR MUTEADO POR DEFECTO
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

function mostrarVideoRemoto(stream, peerId) {
    console.log(`📹 ASIGNANDO VIDEO REMOTO de ${peerId}`);
    if (!stream) return;
    
    // Verificar que el stream NO sea el local
    if (stream === streamLocal) {
        console.warn('⚠️ Ignorando stream local en video remoto');
        return;
    }
    
    peerIdRemoto = peerId;
    
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`🎵 Audio remoto: ${audioTracks.length}, Video remoto: ${videoTracks.length}`);
    
    // Asegurar que los tracks de audio remotos estén habilitados
    audioTracks.forEach(track => {
        if (!track.enabled) {
            track.enabled = true;
            console.log(`🎵 Habilitando track de audio remoto: ${track.label}`);
        }
    });
    
    // Detener stream anterior si existe y no es el mismo
    if (videoRemoto.srcObject) {
        const oldStream = videoRemoto.srcObject;
        if (oldStream !== stream) {
            // No detener tracks, solo remover referencia
            videoRemoto.srcObject = null;
        }
    }
    
    // Asignar el stream remoto al video remoto
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    video.style.display = "block";
    
    if (isMobile) {
        videoRemoto.setAttribute('playsinline', 'true');
        videoRemoto.setAttribute('webkit-playsinline', 'true');
    }
    
    // El video remoto NO debe estar muteado para que se escuche
    videoRemoto.muted = false;
    videoRemoto.volume = 0.3;
    
    const playVideo = async () => {
        try {
            await videoRemoto.play();
            console.log(`✅ Video remoto de ${peerId} reproduciendo correctamente`);
            
            // Esperar un poco antes de crear el audio
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Inicializar audio y crear audio remoto
            await audioController.init();
            const audioCreated = audioController.createAudioForPeer(peerId, stream);
            
            if (audioCreated) {
                audioController.setVolume(peerId, 0.3);
                console.log(`✅ Audio remoto configurado para ${peerId}`);
            } else {
                console.warn(`⚠️ No se pudo configurar audio remoto para ${peerId}`);
            }
            
            actualizarEstado(`🟢 Conectado`, "conectado");
        } catch (error) {
            console.warn(`⚠️ Error al reproducir video remoto:`, error.message);
            if (isiOS) {
                document.addEventListener('touchstart', () => {
                    videoRemoto.play().catch(e => console.warn('⚠️ Error en play de iOS:', e));
                }, { once: true });
            } else {
                setTimeout(() => {
                    videoRemoto.play()
                        .then(() => {
                            console.log(`✅ Video remoto reproducido en reintento`);
                            audioController.createAudioForPeer(peerId, stream);
                        })
                        .catch(e => console.warn(`⚠️ Error en reintento:`, e.message));
                }, 1000);
            }
        }
    };
    
    playVideo();
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    if (videoRemoto.srcObject) {
        // No detener los tracks, solo limpiar la referencia
        videoRemoto.srcObject = null;
    }
    if (peerIdRemoto) {
        audioController.destroyAudioForPeer(peerIdRemoto);
        peerIdRemoto = null;
    }
    // Mantener el video local visible
    if (streamLocal) {
        video.style.display = "block";
    }
}

function crearPeerConnection(targetId) {
    console.log(`🔗 Creando conexión con: ${targetId}`);
    
    // Cerrar conexión existente de forma segura
    if (peers[targetId]) {
        try {
            const oldPc = peers[targetId];
            oldPc.onicecandidate = null;
            oldPc.ontrack = null;
            oldPc.onconnectionstatechange = null;
            oldPc.oniceconnectionstatechange = null;
            oldPc.onnegotiationneeded = null;
            oldPc.close();
        } catch (e) {
            console.warn('⚠️ Error cerrando conexión existente:', e);
        }
        delete peers[targetId];
        audioController.destroyAudioForPeer(targetId);
    }
    
    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: isMobile ? 5 : 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    });

    // Agregar tracks locales SOLO si existen
    if (streamLocal) {
        const audioTracks = streamLocal.getAudioTracks();
        const videoTracks = streamLocal.getVideoTracks();
        
        console.log(`📹 Tracks locales: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
        
        // Asegurar que los tracks de audio locales estén habilitados para enviar
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
            
            // Verificar que NO sea el stream local
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
                    reiniciarConexion(targetId);
                }
            }, 5000);
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado con ${targetId}: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            console.log(`✅ CONEXIÓN ESTABLECIDA con ${targetId}!`);
            actualizarEstado(`🟢 Conectado`, "conectado");
        } else if (pc.connectionState === "failed") {
            console.log(`❌ Conexión fallida con ${targetId}`);
            if (peerIdRemoto === targetId) {
                ocultarVideoRemoto();
            }
            if (peers[targetId]) {
                try {
                    peers[targetId].close();
                } catch (e) {}
                delete peers[targetId];
            }
            setTimeout(() => {
                socket.emit("clientes-conectados");
            }, 5000);
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
        }
    };

    peers[targetId] = pc;
    return pc;
}

function reiniciarConexion(targetId) {
    console.log(`🔄 Reiniciando conexión con ${targetId}`);
    if (peers[targetId]) {
        try {
            peers[targetId].close();
        } catch (e) {}
        delete peers[targetId];
    }
    if (peerIdRemoto === targetId) {
        ocultarVideoRemoto();
    }
    audioController.destroyAudioForPeer(targetId);
    
    const delay = isMobile ? 3000 : 1500;
    setTimeout(() => {
        if (peers[targetId]) {
            console.log(`⏳ Ya hay una conexión para ${targetId}, omitiendo reinicio`);
            return;
        }
        const pc = crearPeerConnection(targetId);
        setTimeout(() => {
            if (pc.signalingState === 'closed') {
                console.warn(`⚠️ PC cerrado, no se puede crear oferta para ${targetId}`);
                delete peers[targetId];
                return;
            }
            pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            })
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                socket.emit("offer", { target: targetId, offer: pc.localDescription });
                console.log(`✅ Oferta de reconexión enviada a: ${targetId}`);
            })
            .catch(error => {
                console.error(`❌ Error en reconexión para ${targetId}:`, error);
                delete peers[targetId];
            });
        }, isMobile ? 1000 : 500);
    }, delay);
}

// ============================================
// 📡 Eventos Socket.IO
// ============================================

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);
    
    try {
        if (peers[from]) {
            try {
                const oldPc = peers[from];
                oldPc.onicecandidate = null;
                oldPc.ontrack = null;
                oldPc.onconnectionstatechange = null;
                oldPc.oniceconnectionstatechange = null;
                oldPc.onnegotiationneeded = null;
                oldPc.close();
            } catch (e) {}
            delete peers[from];
            audioController.destroyAudioForPeer(from);
        }
        
        const pc = crearPeerConnection(from);
        
        if (pc.signalingState === 'closed') {
            console.warn(`⚠️ PC cerrado, no se puede procesar oferta de ${from}`);
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida (oferta) de ${from}`);

        const answer = await pc.createAnswer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(answer);

        socket.emit("answer", { target: from, answer: pc.localDescription });
        console.log(`✅ Respuesta enviada a: ${from}`);
    } catch (error) {
        console.error(`❌ Error manejando oferta de ${from}:`, error);
        if (peers[from]) {
            try {
                peers[from].close();
            } catch (e) {}
            delete peers[from];
        }
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
        delete peers[from];
        return;
    }

    if (pc.signalingState === 'stable') {
        console.log(`⚠️ Estado stable para ${from}, ignorando respuesta`);
        return;
    }

    if (pc.signalingState !== 'have-local-offer') {
        console.log(`⚠️ Estado incorrecto: ${pc.signalingState} para ${from}`);
        reiniciarConexion(from);
        return;
    }

    isProcessingAnswer[from] = true;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida de ${from}`);
    } catch (error) {
        console.error(`❌ Error procesando respuesta de ${from}:`, error);
        reiniciarConexion(from);
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

function conectarConTodos(clientes) {
    console.log("🔄 CONECTANDO CON TODOS...");
    const otros = clientes.filter(id => id !== socket.id);
    if (otros.length === 0) {
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
        return;
    }

    otros.forEach(targetId => {
        if (peers[targetId]) {
            const state = peers[targetId].connectionState;
            if (state === "connected") {
                console.log(`✅ Ya conectado con ${targetId}`);
                return;
            }
            if (state === "connecting") {
                console.log(`⏳ Conectando con ${targetId}...`);
                return;
            }
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
        }
        
        const pc = crearPeerConnection(targetId);
        setTimeout(() => {
            if (pc.signalingState === 'closed') {
                console.warn(`⚠️ PC cerrado, no se puede crear oferta para ${targetId}`);
                delete peers[targetId];
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
                console.error(`❌ Error en oferta para ${targetId}:`, error);
                if (peers[targetId]) {
                    try {
                        peers[targetId].close();
                    } catch (e) {}
                    delete peers[targetId];
                }
            });
        }, isMobile ? 1000 : 500);
    });
}

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    reconnectAttempts = 0;
    actualizarEstado("🟢 Conectado", "conectado");
    await obtenerTurnServers();
    await audioController.init();
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Lista de clientes recibida:", lista);
    const clientesActuales = new Set(lista);
    Object.keys(peers).forEach(id => {
        if (!clientesActuales.has(id) && id !== socket.id) {
            console.log(`🧹 Limpiando peer antiguo: ${id}`);
            try {
                const oldPc = peers[id];
                oldPc.onicecandidate = null;
                oldPc.ontrack = null;
                oldPc.onconnectionstatechange = null;
                oldPc.oniceconnectionstatechange = null;
                oldPc.onnegotiationneeded = null;
                oldPc.close();
            } catch (e) {}
            delete peers[id];
            audioController.destroyAudioForPeer(id);
        }
    });
    conectarConTodos(lista);
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente:", data.id);
    setTimeout(() => socket.emit("clientes-conectados"), 1500);
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    if (peers[data.id]) {
        try {
            const oldPc = peers[data.id];
            oldPc.onicecandidate = null;
            oldPc.ontrack = null;
            oldPc.onconnectionstatechange = null;
            oldPc.oniceconnectionstatechange = null;
            oldPc.onnegotiationneeded = null;
            oldPc.close();
        } catch (e) {}
        delete peers[data.id];
    }
    audioController.destroyAudioForPeer(data.id);
    
    if (peerIdRemoto === data.id) {
        ocultarVideoRemoto();
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
    }
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    reconnectAttempts++;
    actualizarEstado(`🔴 Reconectando... (${reconnectAttempts})`, "desconectado");
    ocultarVideoRemoto();
    Object.keys(peers).forEach(key => {
        try {
            const oldPc = peers[key];
            oldPc.onicecandidate = null;
            oldPc.ontrack = null;
            oldPc.onconnectionstatechange = null;
            oldPc.oniceconnectionstatechange = null;
            oldPc.onnegotiationneeded = null;
            oldPc.close();
        } catch (e) {}
        delete peers[key];
    });
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
        
        // Verificar y habilitar tracks de audio locales
        const audioTracks = stream.getAudioTracks();
        console.log(`🎤 Tracks de audio locales: ${audioTracks.length}`);
        audioTracks.forEach(track => {
            track.enabled = true;
            console.log(`🎤 Audio local habilitado para envío: ${track.label}`);
        });
        
        // Video local - SIEMPRE MUTEADO para evitar retroalimentación
        video.srcObject = stream;
        video.style.display = "block";
        video.muted = true; // CRÍTICO: el video local debe estar muteado
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
        socket.emit("clientes-conectados");
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
    
    // Volumen - controla el audio REMOTO
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
    
    // Silenciar audio REMOTO
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
    
    // Silenciar micrófono LOCAL (envío de audio)
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
    
    // Pantalla completa
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
    
    // Diagnóstico
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
    
    // Reconectar
    if (btnReconectar) {
        btnReconectar.addEventListener('click', () => {
            console.log("🔄 Forzando reconexión...");
            ocultarVideoRemoto();
            Object.keys(peers).forEach(key => {
                try {
                    const oldPc = peers[key];
                    oldPc.onicecandidate = null;
                    oldPc.ontrack = null;
                    oldPc.onconnectionstatechange = null;
                    oldPc.oniceconnectionstatechange = null;
                    oldPc.onnegotiationneeded = null;
                    oldPc.close();
                } catch (e) {}
                delete peers[key];
            });
            audioController.destroyAll();
            socket.disconnect();
            setTimeout(() => {
                socket.connect();
            }, 1000);
            actualizarEstado("🔄 Reconectando...", "inicializando");
        });
    }
    
    // iOS: interacción de usuario para audio
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
            <span class="label">📹 Cámara LOCAL:</span>
            <span class="value ${!tieneVideoLocal ? 'error' : ''}">${tieneVideoLocal ? '✅ Activa' : '❌ Apagada'}</span>
        </div>
        <div class="info-line">
            <span class="label">🎵 Audio REMOTO:</span>
            <span class="value ${!tieneAudioRemoto ? 'error' : ''}">${tieneAudioRemoto ? '✅ Reproduciendo' : '❌ Inactivo'}</span>
        </div>
        <div class="info-line" style="border-bottom: none;">
            <span class="label">📱 Dispositivo:</span>
            <span class="value">${isMobile ? 'Móvil' : 'Desktop'}</span>
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
    Object.keys(peers).forEach(key => {
        try {
            const oldPc = peers[key];
            oldPc.onicecandidate = null;
            oldPc.ontrack = null;
            oldPc.onconnectionstatechange = null;
            oldPc.oniceconnectionstatechange = null;
            oldPc.onnegotiationneeded = null;
            oldPc.close();
        } catch (e) {}
        delete peers[key];
    });
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
    audioController.destroyAll();
});

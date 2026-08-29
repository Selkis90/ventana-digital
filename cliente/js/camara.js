const video = document.getElementById("video");
const videoRemoto = document.getElementById("video-remoto");

// URL de Render
const socket = io("https://ventana-digital.onrender.com", {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 1000,
    timeout: 30000
});

const peers = {};
let streamLocal = null;
let turnServers = [];
let isProcessingAnswer = {};

// ============================================
// 🔊 CONTROL DE AUDIO POR CONEXIÓN
// ============================================
class AudioController {
    constructor() {
        this.audioContexts = new Map(); // Por peerId
        this.gainNodes = new Map();
        this.analyzers = new Map();
        this.isAudioInitialized = false;
    }

    async init() {
        if (!this.isAudioInitialized) {
            try {
                // Crear AudioContext global
                this.globalContext = new (window.AudioContext || window.webkitAudioContext)();
                // Resumir si está suspendido
                if (this.globalContext.state === 'suspended') {
                    await this.globalContext.resume();
                }
                this.isAudioInitialized = true;
                console.log('✅ AudioController inicializado');
            } catch (error) {
                console.warn('⚠️ Error inicializando AudioContext:', error);
            }
        }
    }

    createAudioForPeer(peerId, stream) {
        try {
            // Verificar si ya existe para este peer
            if (this.audioContexts.has(peerId)) {
                console.log(`🔄 Reemplazando audio para ${peerId}`);
                this.destroyAudioForPeer(peerId);
            }

            // Crear AudioContext para este peer
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Crear fuente de audio
            const source = audioContext.createMediaStreamSource(stream);
            
            // Analizador para monitorear
            const analyzer = audioContext.createAnalyser();
            analyzer.fftSize = 256;
            
            // Ganancia (volumen controlado)
            const gainNode = audioContext.createGain();
            gainNode.gain.value = 0.3; // Volumen inicial
            
            // Filtro para reducir ruido
            const filter = audioContext.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 8000; // Frecuencia para voz humana
            
            // Conectar: fuente -> filtro -> ganancia -> analizador -> destino
            source.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(analyzer);
            analyzer.connect(audioContext.destination);
            
            // Guardar referencias
            this.audioContexts.set(peerId, {
                context: audioContext,
                source: source,
                gainNode: gainNode,
                analyzer: analyzer,
                filter: filter
            });
            
            console.log(`✅ Audio creado para peer ${peerId}`);
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
                audioData.context.close();
            } catch (e) {}
            this.audioContexts.delete(peerId);
            console.log(`🗑️ Audio destruido para peer ${peerId}`);
        }
    }

    destroyAll() {
        for (const [peerId, audioData] of this.audioContexts) {
            try {
                audioData.source.disconnect();
                audioData.context.close();
            } catch (e) {}
        }
        this.audioContexts.clear();
        this.gainNodes.clear();
        this.analyzers.clear();
        if (this.globalContext) {
            try {
                this.globalContext.close();
            } catch (e) {}
        }
        this.isAudioInitialized = false;
        console.log('🗑️ Todos los audios destruidos');
    }
}

// Instancia global del controlador de audio
const audioController = new AudioController();

// ============================================
// 🖥️ UI State
// ============================================
video.style.display = "none";
videoRemoto.style.display = "none";
video.muted = true;
video.volume = 0;

let peerIdRemoto = null; // Para saber qué peer está mostrando

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
        { urls: "stun:stun.l.google.com:19302" },
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
    
    // Guardar el peerId actual
    peerIdRemoto = peerId;
    
    // Verificar tracks
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`🎵 Audio tracks: ${audioTracks.length}, Video tracks: ${videoTracks.length}`);
    
    if (audioTracks.length > 0) {
        console.log('🎵 Audio track:', audioTracks[0].label, 'enabled:', audioTracks[0].enabled);
        // Asegurar que el audio esté habilitado
        audioTracks[0].enabled = true;
    }
    
    // Detener stream anterior
    if (videoRemoto.srcObject) {
        const oldStream = videoRemoto.srcObject;
        // No detener los tracks del stream anterior si es el mismo peer
        if (oldStream !== stream) {
            oldStream.getTracks().forEach(track => track.stop());
        }
        videoRemoto.srcObject = null;
    }
    
    // Asignar nuevo stream
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    video.style.display = "block";
    
    // Configurar audio
    videoRemoto.muted = false;
    videoRemoto.volume = 0.3;
    
    // Reproducir
    const playVideo = async () => {
        try {
            await videoRemoto.play();
            console.log(`✅ Video remoto de ${peerId} reproduciendo`);
            
            // Crear AudioContext específico para este peer
            await audioController.init();
            const audioCreated = audioController.createAudioForPeer(peerId, stream);
            
            if (audioCreated) {
                console.log(`✅ Audio configurado para ${peerId}`);
                // Ajustar volumen inicial
                audioController.setVolume(peerId, 0.3);
            }
            
            actualizarEstado(`🟢 Conectado a ${peerId}`, "conectado");
        } catch (error) {
            console.warn(`⚠️ Error al reproducir video de ${peerId}:`, error.message);
            setTimeout(() => {
                videoRemoto.play()
                    .then(() => {
                        console.log(`✅ Video remoto de ${peerId} reproducido en reintento`);
                        audioController.createAudioForPeer(peerId, stream);
                    })
                    .catch(e => console.warn(`⚠️ Error en reintento:`, e.message));
            }, 500);
        }
    };
    
    playVideo();
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject.getTracks().forEach(track => track.stop());
        videoRemoto.srcObject = null;
    }
    if (peerIdRemoto) {
        audioController.destroyAudioForPeer(peerIdRemoto);
        peerIdRemoto = null;
    }
    // No destruir el AudioContext global, solo desconectar
}

function crearPeerConnection(targetId) {
    console.log(`🔗 Creando conexión con: ${targetId}`);
    
    // Limpiar conexión existente
    if (peers[targetId]) {
        try {
            peers[targetId].close();
        } catch (e) {}
        delete peers[targetId];
        // Limpiar audio de este peer
        audioController.destroyAudioForPeer(targetId);
    }
    
    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    });

    // Agregar tracks locales (Siempre habilitados)
    if (streamLocal) {
        streamLocal.getTracks().forEach(track => {
            console.log(`✅ Agregando track local: ${track.kind} (${track.label})`);
            pc.addTrack(track, streamLocal);
        });
    }

    // Evento cuando llegan tracks remotos
    pc.ontrack = (event) => {
        console.log(`📥 Track remoto recibido de ${targetId}: ${event.track.kind}`);
        console.log(`   Label: ${event.track.label}, Enabled: ${event.track.enabled}`);
        
        if (event.streams && event.streams[0]) {
            const stream = event.streams[0];
            console.log(`📦 Stream de ${targetId} tiene ${stream.getTracks().length} tracks`);
            
            // Solo mostrar si es el primer track de video o si no hay otro mostrando
            if (event.track.kind === 'video' || !videoRemoto.srcObject) {
                mostrarVideoRemoto(stream, targetId);
            }
        }
    };

    // ICE Candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`🧊 ICE candidate enviado a ${targetId}`);
            socket.emit("ice-candidate", { target: targetId, candidate: event.candidate });
        }
    };

    // Estados ICE
    pc.oniceconnectionstatechange = () => {
        console.log(`🔗 Estado ICE con ${targetId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === "failed") {
            console.log(`❌ ICE falló con ${targetId}, reiniciando...`);
            setTimeout(() => {
                if (peers[targetId]) {
                    reiniciarConexion(targetId);
                }
            }, 3000);
        }
        if (pc.iceConnectionState === "connected") {
            console.log(`✅ ICE conectado con ${targetId}`);
        }
    };

    // Estado de la conexión
    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado conexión con ${targetId}: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            console.log(`✅ ¡CONEXIÓN WEBRTC ESTABLECIDA con ${targetId}!`);
            actualizarEstado(`🟢 Conectado a ${targetId}`, "conectado");
        } else if (pc.connectionState === "failed") {
            console.log(`❌ Conexión fallida con ${targetId}`);
            if (peerIdRemoto === targetId) {
                ocultarVideoRemoto();
            }
            if (peers[targetId]) {
                peers[targetId].close();
                delete peers[targetId];
            }
            setTimeout(() => {
                socket.emit("clientes-conectados");
            }, 5000);
        } else if (pc.connectionState === "disconnected") {
            console.log(`🔴 Conexión desconectada con ${targetId}`);
        }
    };

    // Negociación necesaria
    pc.onnegotiationneeded = async () => {
        console.log(`🤝 Negociación necesaria con ${targetId}`);
        try {
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
    
    setTimeout(() => {
        const pc = crearPeerConnection(targetId);
        // Esperar a que se agreguen los tracks
        setTimeout(() => {
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
        }, 500);
    }, 1000);
}

// ============================================
// 📡 Eventos Socket.IO
// ============================================

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);
    
    try {
        // Limpiar conexión existente con este peer
        if (peers[from]) {
            try {
                peers[from].close();
            } catch (e) {}
            delete peers[from];
            audioController.destroyAudioForPeer(from);
        }
        
        const pc = crearPeerConnection(from);
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
            peers[from].close();
            delete peers[from];
        }
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA RECIBIDA DE: ${from}`);
    
    if (isProcessingAnswer[from]) {
        console.log(`⏳ Ya procesando respuesta de ${from}, ignorando...`);
        return;
    }
    
    const pc = peers[from];
    if (!pc) {
        console.log(`⚠️ No hay peer para ${from}, ignorando respuesta`);
        return;
    }

    if (pc.signalingState === 'stable') {
        console.log(`⚠️ Estado stable para ${from}, ignorando respuesta`);
        return;
    }

    if (pc.signalingState !== 'have-local-offer') {
        console.log(`⚠️ Estado incorrecto para setRemoteDescription: ${pc.signalingState}`);
        reiniciarConexion(from);
        return;
    }

    isProcessingAnswer[from] = true;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida (respuesta) de ${from}`);
    } catch (error) {
        console.error(`❌ Error procesando respuesta de ${from}:`, error);
        reiniciarConexion(from);
    } finally {
        delete isProcessingAnswer[from];
    }
});

socket.on("ice-candidate", async (data) => {
    const { from, candidate } = data;
    console.log(`🧊 ICE candidate RECIBIDO de: ${from}`);
    const pc = peers[from];
    if (!pc) return;

    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`✅ ICE Candidate agregado de: ${from}`);
    } catch (error) {
        console.warn(`⚠️ Error ICE:`, error.message);
    }
});

function conectarConTodos(clientes) {
    console.log("🔄 CONECTANDO CON TODOS...");
    const otros = clientes.filter(id => id !== socket.id);
    if (otros.length === 0) {
        console.log("⏳ No hay otros clientes");
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
        return;
    }

    otros.forEach(targetId => {
        // Si ya existe conexión y está conectada, no reconectar
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
            // Si está en otro estado, cerrar y recrear
            try {
                peers[targetId].close();
            } catch (e) {}
            delete peers[targetId];
            audioController.destroyAudioForPeer(targetId);
        }
        
        console.log(`📤 Iniciando oferta para ${targetId}`);
        const pc = crearPeerConnection(targetId);
        
        setTimeout(() => {
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
                    peers[targetId].close();
                    delete peers[targetId];
                }
            });
        }, 500);
    });
}

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    actualizarEstado("🟢 Conectado", "conectado");
    await obtenerTurnServers();
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Lista de clientes recibida:", lista);
    // Limpiar peers que ya no existen
    const clientesActuales = new Set(lista);
    Object.keys(peers).forEach(id => {
        if (!clientesActuales.has(id) && id !== socket.id) {
            console.log(`🧹 Limpiando peer antiguo: ${id}`);
            try {
                peers[id].close();
            } catch (e) {}
            delete peers[id];
            audioController.destroyAudioForPeer(id);
        }
    });
    conectarConTodos(lista);
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente detectado:", data.id);
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    if (peers[data.id]) {
        try {
            peers[data.id].close();
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
    actualizarEstado("🔴 Desconectado", "desconectado");
    ocultarVideoRemoto();
    Object.keys(peers).forEach(key => {
        try {
            peers[key].close();
        } catch (e) {}
        delete peers[key];
    });
    audioController.destroyAll();
});

// ============================================
// 🎬 Iniciar Cámara
// ============================================

async function iniciarCamara() {
    try {
        console.log("📷 Solicitando cámara...");
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                width: { ideal: 640 }, 
                height: { ideal: 480 },
                facingMode: 'user'
            },
            audio: { 
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 16000,
                sampleSize: 16
            }
        });
        
        streamLocal = stream;
        
        // Verificar tracks
        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        console.log(`🎤 Tracks locales: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
        
        if (audioTracks.length > 0) {
            audioTracks[0].enabled = true;
            console.log('🎤 Audio local habilitado');
        }
        
        if (videoTracks.length > 0) {
            videoTracks[0].enabled = true;
            console.log('📹 Video local habilitado');
        }
        
        // Mostrar video local
        video.srcObject = stream;
        video.style.display = "block";
        video.muted = true;
        try {
            await video.play();
            console.log("📹 Video local iniciado");
        } catch (e) {
            console.warn("⚠️ Error al iniciar video local:", e.message);
        }
        
        await obtenerTurnServers();
        socket.emit("clientes-conectados");
    } catch (error) {
        console.error("❌ Error:", error);
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
    
    // Control de volumen
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
    
    // Silenciar audio remoto
    if (btnSilenciar) {
        let silenciado = false;
        btnSilenciar.addEventListener('click', () => {
            silenciado = !silenciado;
            videoRemoto.muted = silenciado;
            if (peerIdRemoto) {
                audioController.muteAudio(peerIdRemoto, silenciado);
            }
            btnSilenciar.textContent = silenciado ? '🔊 Activar sonido' : '🔇 Silenciar';
        });
    }
    
    // Silenciar micrófono local
    if (btnToggleMicrofono) {
        let microfonoActivo = true;
        btnToggleMicrofono.addEventListener('click', () => {
            microfonoActivo = !microfonoActivo;
            if (streamLocal) {
                streamLocal.getAudioTracks().forEach(track => {
                    track.enabled = microfonoActivo;
                });
            }
            btnToggleMicrofono.textContent = microfonoActivo ? '🎤 Micrófono' : '🎤 Silenciado';
            btnToggleMicrofono.style.opacity = microfonoActivo ? '1' : '0.5';
        });
    }
    
    // Apagar/encender cámara local
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
            btnToggleCamara.style.opacity = camaraActiva ? '1' : '0.5';
        });
    }
    
    // Reconectar
    if (btnReconectar) {
        btnReconectar.addEventListener('click', () => {
            console.log("🔄 Forzando reconexión...");
            ocultarVideoRemoto();
            Object.keys(peers).forEach(key => {
                try {
                    peers[key].close();
                } catch (e) {}
                delete peers[key];
            });
            audioController.destroyAll();
            socket.emit("clientes-conectados");
            actualizarEstado("🔄 Reconectando...", "inicializando");
            setTimeout(() => {
                if (streamLocal) {
                    streamLocal.getAudioTracks().forEach(t => t.enabled = true);
                    streamLocal.getVideoTracks().forEach(t => t.enabled = true);
                }
            }, 500);
        });
    }
});

// ============================================
// 🚀 Inicialización
// ============================================

window.addEventListener("load", () => {
    console.log("🚀 Iniciando Ventana Digital...");
    iniciarCamara();
});

window.addEventListener("beforeunload", () => {
    Object.keys(peers).forEach(key => {
        try {
            peers[key].close();
        } catch (e) {}
        delete peers[key];
    });
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
    audioController.destroyAll();
});

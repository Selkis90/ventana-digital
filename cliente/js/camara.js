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
// 🔌 CONFIGURACIÓN DE SOCKET OPTIMIZADA
// ============================================
const socket = io("https://ventana-digital.onrender.com", {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 50,
    reconnectionDelay: isMobile ? 2000 : 1000,
    reconnectionDelayMax: 10000,
    timeout: isMobile ? 60000 : 30000,
    forceNew: true,
    autoConnect: true,
    upgrade: true,
    rememberUpgrade: true
});

const peers = {};
let streamLocal = null;
let turnServers = [];
let isProcessingAnswer = {};
let isAudioInitialized = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ============================================
// 🔊 CONTROL DE AUDIO MEJORADO PARA MÓVILES
// ============================================
class AudioController {
    constructor() {
        this.audioContexts = new Map();
        this.gainNodes = new Map();
        this.isInitialized = false;
        this.isIOS = isiOS;
        this.isSafari = isSafari;
    }

    async init() {
        if (this.isInitialized) return true;
        
        try {
            // En iOS, el AudioContext debe crearse con un gesto del usuario
            if (this.isIOS) {
                console.log('🍎 Inicializando AudioContext para iOS...');
                // Usar el contexto existente o crear uno nuevo
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
            // En iOS, reutilizar el contexto global
            if (this.isIOS && window._iosAudioContext) {
                this.globalContext = window._iosAudioContext;
            }
            
            if (!this.globalContext || this.globalContext.state === 'closed') {
                console.warn('⚠️ AudioContext no disponible');
                return false;
            }

            // Verificar si el stream tiene audio
            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) {
                console.log('ℹ️ No hay audio en este stream');
                return false;
            }

            // Si ya existe audio para este peer, destruirlo
            if (this.audioContexts.has(peerId)) {
                this.destroyAudioForPeer(peerId);
            }

            // Crear fuente de audio
            const source = this.globalContext.createMediaStreamSource(stream);
            
            // Ganancia (volumen)
            const gainNode = this.globalContext.createGain();
            gainNode.gain.value = 0.3;
            
            // Filtro para mejorar calidad de voz
            const filter = this.globalContext.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 8000;
            
            // En móviles, menos procesamiento para evitar lag
            if (isMobile) {
                filter.frequency.value = 6000; // Menos procesamiento en móviles
            }
            
            // Conectar
            source.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(this.globalContext.destination);
            
            this.audioContexts.set(peerId, {
                source: source,
                gainNode: gainNode,
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

    // Para iOS: resumir el contexto después de interacción del usuario
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

// En móviles, desactivar autoplay en video local
if (isMobile) {
    video.setAttribute('playsinline', '');
    videoRemoto.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    videoRemoto.setAttribute('autoplay', '');
}

let peerIdRemoto = null;

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
    
    peerIdRemoto = peerId;
    
    // Verificar tracks
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`🎵 Audio: ${audioTracks.length}, Video: ${videoTracks.length}`);
    
    // Detener stream anterior
    if (videoRemoto.srcObject) {
        const oldStream = videoRemoto.srcObject;
        if (oldStream !== stream) {
            oldStream.getTracks().forEach(track => track.stop());
        }
        videoRemoto.srcObject = null;
    }
    
    // Configurar video remoto para móviles
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    video.style.display = "block";
    
    // Configuración específica para móviles
    if (isMobile) {
        videoRemoto.setAttribute('playsinline', 'true');
        videoRemoto.setAttribute('webkit-playsinline', 'true');
    }
    
    videoRemoto.muted = false;
    videoRemoto.volume = 0.3;
    
    // Reproducir con manejo para móviles
    const playVideo = async () => {
        try {
            await videoRemoto.play();
            console.log(`✅ Video remoto de ${peerId} reproduciendo`);
            
            // Inicializar audio
            await audioController.init();
            const audioCreated = audioController.createAudioForPeer(peerId, stream);
            
            if (audioCreated) {
                audioController.setVolume(peerId, 0.3);
            }
            
            actualizarEstado(`🟢 Conectado`, "conectado");
        } catch (error) {
            console.warn(`⚠️ Error al reproducir video:`, error.message);
            // En iOS, esperar interacción del usuario
            if (isiOS) {
                console.log('🍎 iOS requiere interacción del usuario para reproducir');
                // Intentar de nuevo después de un toque
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
        videoRemoto.srcObject.getTracks().forEach(track => track.stop());
        videoRemoto.srcObject = null;
    }
    if (peerIdRemoto) {
        audioController.destroyAudioForPeer(peerIdRemoto);
        peerIdRemoto = null;
    }
}

function crearPeerConnection(targetId) {
    console.log(`🔗 Creando conexión con: ${targetId}`);
    
    if (peers[targetId]) {
        try {
            peers[targetId].close();
        } catch (e) {}
        delete peers[targetId];
        audioController.destroyAudioForPeer(targetId);
    }
    
    // Configuración optimizada para todos los dispositivos
    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: isMobile ? 5 : 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        // En móviles, usar menos recursos
        iceTransportPolicy: isMobile ? 'all' : 'all'
    });

    if (streamLocal) {
        streamLocal.getTracks().forEach(track => {
            console.log(`✅ Agregando track local: ${track.kind}`);
            pc.addTrack(track, streamLocal);
        });
    }

    pc.ontrack = (event) => {
        console.log(`📥 Track remoto recibido: ${event.track.kind}`);
        
        if (event.streams && event.streams[0]) {
            const stream = event.streams[0];
            // Solo mostrar video cuando llegue el track de video
            if (event.track.kind === 'video' || !videoRemoto.srcObject) {
                mostrarVideoRemoto(stream, targetId);
            }
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
        }
    };

    pc.onnegotiationneeded = async () => {
        console.log(`🤝 Negociación con ${targetId}`);
        try {
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            await pc.setLocalDescription(offer);
            socket.emit("offer", { target: targetId, offer: pc.localDescription });
        } catch (error) {
            console.error(`❌ Error en negociación:`, error);
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
        setTimeout(() => {
            pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            })
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                socket.emit("offer", { target: targetId, offer: pc.localDescription });
            })
            .catch(error => {
                console.error(`❌ Error en reconexión:`, error);
                delete peers[targetId];
            });
        }, isMobile ? 1000 : 500);
    }, isMobile ? 2000 : 1000);
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
                peers[from].close();
            } catch (e) {}
            delete peers[from];
            audioController.destroyAudioForPeer(from);
        }
        
        const pc = crearPeerConnection(from);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        const answer = await pc.createAnswer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(answer);

        socket.emit("answer", { target: from, answer: pc.localDescription });
        console.log(`✅ Respuesta enviada a: ${from}`);
    } catch (error) {
        console.error(`❌ Error manejando oferta:`, error);
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
        console.log(`⏳ Ya procesando respuesta de ${from}`);
        return;
    }
    
    const pc = peers[from];
    if (!pc) return;

    if (pc.signalingState === 'stable') {
        console.log(`⚠️ Estado stable para ${from}`);
        return;
    }

    if (pc.signalingState !== 'have-local-offer') {
        console.log(`⚠️ Estado incorrecto: ${pc.signalingState}`);
        reiniciarConexion(from);
        return;
    }

    isProcessingAnswer[from] = true;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida de ${from}`);
    } catch (error) {
        console.error(`❌ Error procesando respuesta:`, error);
        reiniciarConexion(from);
    } finally {
        delete isProcessingAnswer[from];
    }
});

socket.on("ice-candidate", async (data) => {
    const { from, candidate } = data;
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
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
        return;
    }

    otros.forEach(targetId => {
        if (peers[targetId]) {
            const state = peers[targetId].connectionState;
            if (state === "connected" || state === "connecting") {
                console.log(`⏳ Ya conectado/conectando con ${targetId}`);
                return;
            }
            try {
                peers[targetId].close();
            } catch (e) {}
            delete peers[targetId];
            audioController.destroyAudioForPeer(targetId);
        }
        
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
                console.error(`❌ Error en oferta:`, error);
                delete peers[targetId];
            });
        }, isMobile ? 1000 : 500);
    });
}

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    reconnectAttempts = 0;
    actualizarEstado("🟢 Conectado", "conectado");
    await obtenerTurnServers();
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Lista de clientes recibida:", lista);
    const clientesActuales = new Set(lista);
    Object.keys(peers).forEach(id => {
        if (!clientesActuales.has(id) && id !== socket.id) {
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
    console.log("🆕 Nuevo cliente:", data.id);
    setTimeout(() => socket.emit("clientes-conectados"), 1500);
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
    reconnectAttempts++;
    actualizarEstado(`🔴 Reconectando... (${reconnectAttempts})`, "desconectado");
    ocultarVideoRemoto();
    Object.keys(peers).forEach(key => {
        try {
            peers[key].close();
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
        
        // Configuración optimizada para cada dispositivo
        const constraints = {
            video: {
                width: { ideal: isMobile ? 480 : 640 },
                height: { ideal: isMobile ? 360 : 480 },
                facingMode: 'user'
            },
            audio: {
                echoCancellation: !isiOS, // iOS tiene problemas con echoCancellation
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: isMobile ? 16000 : 44100
            }
        };
        
        // En iOS, usar configuración más simple
        if (isiOS) {
            constraints.video = { facingMode: 'user' };
            constraints.audio = { echoCancellation: false };
        }
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamLocal = stream;
        
        // Configurar video local
        video.srcObject = stream;
        video.style.display = "block";
        video.muted = true;
        
        // En móviles, usar playsinline
        if (isMobile) {
            video.setAttribute('playsinline', 'true');
            video.setAttribute('webkit-playsinline', 'true');
        }
        
        try {
            await video.play();
            console.log("📹 Cámara iniciada");
        } catch (e) {
            console.warn("⚠️ Error al iniciar video local:", e.message);
            if (isiOS) {
                document.addEventListener('touchstart', () => {
                    video.play().catch(e => console.warn('⚠️ Error en play de iOS:', e));
                }, { once: true });
            }
        }
        
        await obtenerTurnServers();
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
    const btnPantallaCompleta = document.getElementById('btn-fullscreen');
    
    // Volumen
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
    
    // Pantalla completa (móviles y desktop)
    if (btnPantallaCompleta) {
        btnPantallaCompleta.addEventListener('click', () => {
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
            socket.disconnect();
            setTimeout(() => {
                socket.connect();
            }, 1000);
            actualizarEstado("🔄 Reconectando...", "inicializando");
        });
    }
    
    // Para iOS: interacción de usuario para audio
    if (isiOS) {
        document.addEventListener('touchstart', () => {
            audioController.resumeContext();
        }, { once: true });
    }
});

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
            peers[key].close();
        } catch (e) {}
        delete peers[key];
    });
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
    audioController.destroyAll();
});

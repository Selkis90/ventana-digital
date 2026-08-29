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
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 30000,
    forceNew: true,
    autoConnect: true
});

let streamLocal = null;
let turnServers = [];
let peerConnection = null;
let connectedPeerId = null;
let isReconnecting = false;
let reconnectTimer = null;
let isProcessingOffer = false;
let pendingCandidates = [];
let isConnecting = false;

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
    
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`🎵 Audio remoto: ${audioTracks.length}, Video remoto: ${videoTracks.length}`);
    
    audioTracks.forEach(track => {
        if (!track.enabled) {
            track.enabled = true;
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
        } catch (error) {
            console.warn(`⚠️ Error al reproducir video remoto:`, error.message);
            setTimeout(() => {
                videoRemoto.play()
                    .then(() => console.log(`✅ Video remoto reproducido en reintento`))
                    .catch(e => console.warn(`⚠️ Error en reintento:`, e.message));
            }, 1000);
        }
    };
    
    playVideo();
}

function crearPeerConnection(targetId) {
    console.log(`🔗 Creando conexión con: ${targetId}`);
    
    // 🔥 IMPORTANTE: SIEMPRE limpiar antes de crear una nueva
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
        streamLocal.getTracks().forEach(track => {
            try {
                pc.addTrack(track, streamLocal);
                console.log(`✅ Agregando track local: ${track.kind}`);
            } catch (error) {
                console.warn(`⚠️ Error agregando track ${track.kind}:`, error);
            }
        });
    }

    pc.ontrack = (event) => {
        console.log(`📥 Track remoto recibido: ${event.track.kind}`);
        
        if (event.track.kind === 'audio') {
            event.track.enabled = true;
        }
        
        if (event.streams && event.streams[0]) {
            const stream = event.streams[0];
            if (stream !== streamLocal) {
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
        if (pc.iceConnectionState === "connected") {
            console.log(`✅ ICE conectado con ${targetId}`);
            isConnecting = false;
        } else if (pc.iceConnectionState === "failed") {
            console.log(`❌ ICE falló`);
            isConnecting = false;
            if (!isReconnecting && connectedPeerId) {
                isReconnecting = true;
                setTimeout(() => {
                    limpiarConexion();
                    socket.emit("clientes-conectados");
                    isReconnecting = false;
                }, 3000);
            }
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado con ${targetId}: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            console.log(`✅ CONEXIÓN ESTABLECIDA con ${targetId}!`);
            connectedPeerId = targetId;
            isReconnecting = false;
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
            limpiarConexion();
        }
    };

    pc.onnegotiationneeded = async () => {
        console.log(`🤝 Negociación con ${targetId}`);
        try {
            if (pc.signalingState === 'closed') return;
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            await pc.setLocalDescription(offer);
            socket.emit("offer", { target: targetId, offer: pc.localDescription });
            console.log(`✅ Oferta enviada a ${targetId}`);
        } catch (error) {
            console.error(`❌ Error en negociación:`, error);
            isConnecting = false;
        }
    };

    return pc;
}

function iniciarConexion(targetId) {
    console.log(`🔄 Iniciando conexión con: ${targetId}`);
    
    // 🔥 EVITAR CONEXIONES DUPLICADAS
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
    
    // 🔥 LIMPIAR ANTES DE CONECTAR
    limpiarConexion();
    
    setTimeout(() => {
        const pc = crearPeerConnection(targetId);
        setTimeout(() => {
            if (pc.signalingState === 'closed') {
                console.warn(`⚠️ PC cerrado`);
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
                console.error(`❌ Error creando oferta:`, error);
                isConnecting = false;
            });
        }, 500);
    }, 1000);
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
        console.warn(`⚠️ IGNORANDO a otros ${otros.length - 1} clientes`);
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
    }, 1000);
}

// ============================================
// 📡 Eventos Socket.IO
// ============================================

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);
    
    // 🔥 IGNORAR SI YA ESTAMOS CONECTADOS
    if (connectedPeerId && connectedPeerId !== from) {
        console.log(`⛔ YA CONECTADO con ${connectedPeerId}, IGNORANDO`);
        return;
    }
    
    // 🔥 IGNORAR SI YA ESTAMOS EN UNA CONEXIÓN
    if (isConnecting) {
        console.log(`⏳ Conexión en progreso, ignorando oferta de ${from}`);
        return;
    }
    
    if (isProcessingOffer) {
        console.log(`⏳ Ya procesando una oferta`);
        return;
    }
    
    isProcessingOffer = true;
    isConnecting = true;
    
    try {
        limpiarConexion();
        
        const pc = crearPeerConnection(from);
        if (pc.signalingState === 'closed') {
            isProcessingOffer = false;
            isConnecting = false;
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida de ${from}`);

        if (pendingCandidates.length > 0) {
            console.log(`📦 Aplicando ${pendingCandidates.length} candidatos`);
            const candidates = [...pendingCandidates];
            pendingCandidates = [];
            for (const candidate of candidates) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {
                    console.warn('⚠️ Error:', e.message);
                }
            }
        }

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
        console.error(`❌ Error:`, error);
        limpiarConexion();
        isProcessingOffer = false;
        isConnecting = false;
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA RECIBIDA DE: ${from}`);
    
    if (!peerConnection) {
        console.log(`⚠️ No hay peer connection`);
        return;
    }

    if (peerConnection.signalingState === 'closed') {
        console.log(`⚠️ PC cerrado`);
        limpiarConexion();
        return;
    }

    if (peerConnection.signalingState === 'stable') {
        console.log(`ℹ️ Estado stable, ignorando`);
        return;
    }

    if (peerConnection.signalingState !== 'have-local-offer') {
        console.log(`⚠️ Estado incorrecto: ${peerConnection.signalingState}`);
        return;
    }

    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida de ${from}`);
    } catch (error) {
        console.error(`❌ Error procesando respuesta:`, error);
        limpiarConexion();
    }
});

socket.on("ice-candidate", async (data) => {
    const { from, candidate } = data;
    
    if (connectedPeerId && connectedPeerId !== from) {
        console.log(`⛔ Ignorando ICE de ${from}`);
        return;
    }
    
    if (!peerConnection) {
        console.log(`⚠️ No hay peer connection para ICE`);
        return;
    }

    try {
        if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            console.log(`✅ ICE Candidate agregado de: ${from}`);
        } else {
            console.log(`⏳ Guardando candidate`);
            pendingCandidates.push(candidate);
        }
    } catch (error) {
        console.warn(`⚠️ Error ICE:`, error.message);
    }
});

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    limpiarConexion();
    isConnecting = false;
    actualizarEstado("🟢 Conectado", "conectado");
    await obtenerTurnServers();
    
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
    setTimeout(() => socket.emit("clientes-conectados"), 3000);
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Lista de clientes recibida:", lista);
    conectarConTodos(lista);
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente:", data.id);
    setTimeout(() => socket.emit("clientes-conectados"), 500);
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    
    if (data.id === socket.id) {
        return;
    }
    
    if (connectedPeerId === data.id) {
        limpiarConexion();
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
    }
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    actualizarEstado("🔴 Reconectando...", "desconectado");
    limpiarConexion();
    isConnecting = false;
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
                autoGainControl: true
            }
        };
        
        if (isiOS) {
            constraints.video = { facingMode: 'user' };
            constraints.audio = { echoCancellation: false };
        }
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamLocal = stream;
        
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
            console.warn("⚠️ Error al iniciar video local:", e.message);
        }
        
        await obtenerTurnServers();
        
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
    
    if (controlVolumen) {
        controlVolumen.value = 0.3;
        controlVolumen.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            videoRemoto.volume = vol;
            if (labelVolumen) labelVolumen.textContent = `${Math.round(vol * 100)}%`;
        });
    }
    
    if (btnSilenciar) {
        let silenciado = false;
        btnSilenciar.addEventListener('click', () => {
            silenciado = !silenciado;
            videoRemoto.muted = silenciado;
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
    
    if (btnReconectar) {
        btnReconectar.addEventListener('click', () => {
            console.log("🔄 Forzando reconexión...");
            limpiarConexion();
            isProcessingOffer = false;
            isConnecting = false;
            actualizarEstado("🔄 Reconectando...", "inicializando");
            
            setTimeout(() => socket.emit("clientes-conectados"), 500);
            setTimeout(() => socket.emit("clientes-conectados"), 2000);
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
    limpiarConexion();
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
});

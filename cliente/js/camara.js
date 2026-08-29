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
let peerIdRemoto = null;
let connectedPeerId = null;
let isReconnecting = false;
let reconnectTimer = null;
let connectionAttempts = 0;
const MAX_ATTEMPTS = 5;
let isManualReconnect = false;

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
// 🔥 FUNCIÓN PARA LIMPIAR CONEXIONES ANTIGUAS
// ============================================

function limpiarTodasLasConexiones() {
    console.log("🧹 Limpiando TODAS las conexiones...");
    
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (window.peerConnection) {
        try {
            const pc = window.peerConnection;
            pc.onicecandidate = null;
            pc.ontrack = null;
            pc.onconnectionstatechange = null;
            pc.oniceconnectionstatechange = null;
            pc.onnegotiationneeded = null;
            pc.close();
        } catch (e) {
            console.warn('⚠️ Error cerrando peerConnection:', e);
        }
        window.peerConnection = null;
    }
    
    if (window.peers) {
        Object.keys(window.peers).forEach(key => {
            try {
                window.peers[key].close();
            } catch (e) {}
        });
        window.peers = {};
    }
    
    if (videoRemoto) {
        videoRemoto.srcObject = null;
        videoRemoto.style.display = "none";
    }
    
    connectedPeerId = null;
    peerIdRemoto = null;
    isReconnecting = false;
    
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
    
    peerIdRemoto = peerId;
    
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

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject = null;
    }
    if (peerIdRemoto) {
        peerIdRemoto = null;
    }
    if (streamLocal) {
        video.style.display = "block";
    }
}

function crearPeerConnection(targetId) {
    console.log(`🔗 Creando conexión con: ${targetId}`);
    
    limpiarTodasLasConexiones();
    
    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: isMobile ? 5 : 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    });

    window.peerConnection = pc;

    if (streamLocal) {
        const audioTracks = streamLocal.getAudioTracks();
        const videoTracks = streamLocal.getVideoTracks();
        
        console.log(`📹 Tracks locales: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
        
        audioTracks.forEach(track => {
            track.enabled = true;
        });
        
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
        if (pc.iceConnectionState === "failed") {
            console.log(`❌ ICE falló, reiniciando en 3s...`);
            if (!isReconnecting && connectedPeerId) {
                isReconnecting = true;
                reconnectTimer = setTimeout(() => {
                    if (connectedPeerId) {
                        iniciarConexion(connectedPeerId);
                    }
                    isReconnecting = false;
                    reconnectTimer = null;
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
            connectionAttempts = 0;
            isManualReconnect = false;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            actualizarEstado(`🟢 Conectado`, "conectado");
        } else if (pc.connectionState === "failed") {
            console.log(`❌ Conexión fallida con ${targetId}`);
            connectedPeerId = null;
            ocultarVideoRemoto();
            if (!isReconnecting && !isManualReconnect && connectionAttempts < MAX_ATTEMPTS) {
                connectionAttempts++;
                isReconnecting = true;
                reconnectTimer = setTimeout(() => {
                    socket.emit("clientes-conectados");
                    isReconnecting = false;
                    reconnectTimer = null;
                }, 5000);
            }
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
    
    limpiarTodasLasConexiones();
    
    setTimeout(() => {
        const pc = crearPeerConnection(targetId);
        setTimeout(() => {
            if (pc.signalingState === 'closed') {
                console.warn(`⚠️ PC cerrado`);
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
            });
        }, 500);
    }, 500);
}

function conectarConTodos(clientes) {
    console.log("🔄 CLIENTES CONECTADOS:", clientes);
    
    const otros = clientes.filter(id => id !== socket.id);
    
    console.log(`🔍 Otros clientes (excluyéndonos):`, otros);
    
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
    
    iniciarConexion(targetId);
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
    
    if (window._processingOffer && window._processingOffer === from) {
        console.log(`⏳ Ya procesando oferta de ${from}`);
        return;
    }
    window._processingOffer = from;
    
    try {
        limpiarTodasLasConexiones();
        
        const pc = crearPeerConnection(from);
        if (pc.signalingState === 'closed') {
            window._processingOffer = null;
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida de ${from}`);

        const answer = await pc.createAnswer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(answer);

        socket.emit("answer", { target: from, answer: pc.localDescription });
        console.log(`✅ Respuesta enviada a: ${from}`);
        window._processingOffer = null;
    } catch (error) {
        console.error(`❌ Error manejando oferta:`, error);
        limpiarTodasLasConexiones();
        window._processingOffer = null;
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA RECIBIDA DE: ${from}`);
    
    const pc = window.peerConnection;
    if (!pc) {
        console.log(`⚠️ No hay peer connection`);
        return;
    }

    if (pc.signalingState === 'closed') {
        console.log(`⚠️ PC cerrado`);
        limpiarTodasLasConexiones();
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida de ${from}`);
    } catch (error) {
        console.error(`❌ Error procesando respuesta:`, error);
        limpiarTodasLasConexiones();
        if (!isReconnecting && from) {
            isReconnecting = true;
            reconnectTimer = setTimeout(() => {
                iniciarConexion(from);
                isReconnecting = false;
                reconnectTimer = null;
            }, 2000);
        }
    }
});

socket.on("ice-candidate", async (data) => {
    const { from, candidate } = data;
    const pc = window.peerConnection;
    if (!pc) {
        console.log(`⚠️ No hay peer connection para ICE`);
        return;
    }

    try {
        if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log(`✅ ICE Candidate agregado de: ${from}`);
        } else {
            console.log(`⏳ Descripción remota no lista, guardando candidate`);
            if (!pc._pendingCandidates) pc._pendingCandidates = [];
            pc._pendingCandidates.push(candidate);
        }
    } catch (error) {
        console.warn(`⚠️ Error ICE:`, error.message);
        if (error.message && error.message.includes('Unknown ufrag')) {
            console.log(`🔄 Reiniciando por Unknown ufrag...`);
            limpiarTodasLasConexiones();
            if (!isReconnecting && from) {
                isReconnecting = true;
                reconnectTimer = setTimeout(() => {
                    iniciarConexion(from);
                    isReconnecting = false;
                    reconnectTimer = null;
                }, 2000);
            }
        }
    }
});

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    connectionAttempts = 0;
    isManualReconnect = false;
    limpiarTodasLasConexiones();
    actualizarEstado("🟢 Conectado", "conectado");
    await obtenerTurnServers();
    
    setTimeout(() => {
        socket.emit("clientes-conectados");
    }, 2000);
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
    setTimeout(() => socket.emit("clientes-conectados"), 1500);
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    
    if (data.id === socket.id) {
        console.log(`ℹ️ Ignorando nuestra propia desconexión`);
        return;
    }
    
    if (connectedPeerId === data.id) {
        limpiarTodasLasConexiones();
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
    }
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    actualizarEstado("🔴 Reconectando...", "desconectado");
    limpiarTodasLasConexiones();
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
        
        setTimeout(() => {
            socket.emit("clientes-conectados");
        }, 1000);
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
            
            // 🔥 IMPORTANTE: Marcar como reconexión manual
            isManualReconnect = true;
            isReconnecting = false;
            
            // Limpiar todo
            limpiarTodasLasConexiones();
            actualizarEstado("🔄 Reconectando...", "inicializando");
            
            // 🔥 NO desconectar el socket, solo pedir lista de clientes
            setTimeout(() => {
                socket.emit("clientes-conectados");
                // Después de 5 segundos, permitir reconexión automática si falla
                setTimeout(() => {
                    isManualReconnect = false;
                }, 5000);
            }, 1000);
        });
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
    const tieneVideoRemoto = videoRemoto.srcObject !== null;
    
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
            <span class="label">📹 Video REMOTO:</span>
            <span class="value ${!tieneVideoRemoto ? 'warning' : ''}">${tieneVideoRemoto ? '✅ Recibiendo' : '⏳ Esperando'}</span>
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
    limpiarTodasLasConexiones();
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
});

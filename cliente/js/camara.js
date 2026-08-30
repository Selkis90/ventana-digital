// ============================================
// 📱 CONFIGURACIÓN INICIAL
// ============================================
const video = document.getElementById("video");
const videoRemoto = document.getElementById("video-remoto");

// Detección de dispositivos
const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent);
const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

console.log(`📱 Dispositivo: ${isMobile ? 'Móvil' : 'Desktop'}`);

// Configurar elementos de video
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
// 🔌 CONFIGURACIÓN DE SOCKET
// ============================================
const socket = io("https://ventana-digital.onrender.com", {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 30000,
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
let connectionId = null;

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
// 📹 MOSTRAR VIDEO REMOTO - VERSIÓN SIMPLIFICADA
// ============================================
function mostrarVideoRemoto(stream, peerId) {
    console.log(`📹 ASIGNANDO VIDEO REMOTO de ${peerId}`);
    
    if (!stream || stream === streamLocal) {
        return;
    }
    
    peerIdRemoto = peerId;
    actualizarInfoPeer(peerId);
    
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`📊 Stream: Audio=${audioTracks.length}, Video=${videoTracks.length}`);
    
    // 🔥 SI EL STREAM YA ESTÁ ASIGNADO Y REPRODUCIENDO, NO HACER NADA
    if (videoRemoto.srcObject === stream && !videoRemoto.paused) {
        console.log('ℹ️ Video ya está reproduciendo');
        return;
    }
    
    // 🔥 LIMPIAR RECURSOS ANTERIORES
    try {
        if (videoRemoto.srcObject) {
            videoRemoto.pause();
            videoRemoto.srcObject = null;
        }
    } catch (e) {}
    
    // 🔥 ASIGNAR NUEVO STREAM
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    video.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = 0.3;
    
    if (isMobile) {
        videoRemoto.setAttribute('playsinline', 'true');
        videoRemoto.setAttribute('webkit-playsinline', 'true');
    }
    
    // 🔥 REPRODUCIR
    const playVideo = () => {
        videoRemoto.play()
            .then(() => {
                console.log('✅ Video remoto reproduciendo');
                actualizarEstado("🟢 Conectado", "conectado");
                isConnecting = false;
            })
            .catch(err => {
                console.warn('⚠️ Error al reproducir:', err.message);
                // Reintentar después de 1 segundo
                setTimeout(() => {
                    videoRemoto.play().catch(() => {});
                }, 1000);
            });
    };
    
    // Esperar un momento antes de reproducir
    setTimeout(playVideo, 300);
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    if (videoRemoto.srcObject) {
        try {
            videoRemoto.pause();
            videoRemoto.srcObject = null;
        } catch (e) {}
    }
    peerIdRemoto = null;
    actualizarInfoPeer(null);
    if (streamLocal) {
        video.style.display = "block";
    }
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
        console.log(`🧹 Peer limpiado: ${targetId}`);
    }
}

// ============================================
// 🔥 CREAR PEER CONNECTION - SIMPLIFICADA
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

    // ============================================
    // AGREGAR TRACKS LOCALES
    // ============================================
    if (streamLocal) {
        streamLocal.getTracks().forEach(track => {
            try {
                pc.addTrack(track, streamLocal);
                console.log(`✅ Track agregado: ${track.kind}`);
            } catch (error) {
                console.error(`❌ Error agregando track ${track.kind}:`, error);
            }
        });
        
        const senders = pc.getSenders();
        console.log(`📤 Senders: ${senders.length}`);
    }

    // ============================================
    // MANEJAR TRACKS RECIBIDOS
    // ============================================
    pc.ontrack = (event) => {
        console.log(`📥 Track recibido: ${event.track.kind}`);
        
        if (event.streams && event.streams[0]) {
            const stream = event.streams[0];
            if (stream === streamLocal) return;
            
            // Habilitar audio si existe
            stream.getAudioTracks().forEach(t => t.enabled = true);
            
            // Mostrar video
            mostrarVideoRemoto(stream, targetId);
        }
    };

    // ============================================
    // MANEJAR ICE CANDIDATES
    // ============================================
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit("ice-candidate", { 
                target: targetId, 
                candidate: event.candidate 
            });
        }
    };

    // ============================================
    // MANEJAR ESTADO DE CONEXIÓN
    // ============================================
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
            actualizarEstado(`🟢 Conectado`, "conectado");
            actualizarInfoPeer(targetId);
            isConnecting = false;
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
    if (peerIdRemoto === targetId) {
        ocultarVideoRemoto();
    }
    limpiarPeer(targetId);
    isConnecting = false;
    
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
    
    if (!pc || pc.signalingState === 'closed') {
        console.warn(`⚠️ PC cerrado`);
        limpiarPeer(targetId);
        isConnecting = false;
        return;
    }
    
    pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
    })
    .then(offer => {
        console.log(`📝 SDP: Audio=${offer.sdp.includes('m=audio') ? '✅' : '❌'}`);
        return pc.setLocalDescription(offer);
    })
    .then(() => {
        socket.emit("offer", { 
            target: targetId, 
            offer: pc.localDescription 
        });
        console.log(`✅ Oferta enviada a ${targetId}`);
    })
    .catch(error => {
        console.error(`❌ Error:`, error);
        limpiarPeer(targetId);
        isConnecting = false;
    });
}

// ============================================
// 🔗 CONECTAR CON TODOS - CON CONTROL DE DUPLICADOS
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
    
    // 🔥 SI YA ESTÁ CONECTADO, NO RECONECTAR
    if (peers[targetId]) {
        const state = peers[targetId].connectionState;
        if (state === "connected") {
            console.log(`✅ Ya conectado`);
            actualizarInfoPeer(targetId);
            return;
        }
        limpiarPeer(targetId);
    }
    
    isConnecting = true;
    const pc = crearPeerConnection(targetId);
    
    reconnectTimer = setTimeout(() => {
        if (pc && pc.signalingState !== 'closed') {
            iniciarOferta(targetId, pc);
        } else {
            isConnecting = false;
        }
        reconnectTimer = null;
    }, 500);
}

// ============================================
// 📡 EVENTOS SOCKET.IO
// ============================================

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    isConnecting = false;
    actualizarEstado("🟢 Conectado al servidor", "conectado");
    actualizarInfoPeer(null);
    
    await obtenerTurnServers();
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
});

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA DE: ${from}`);
    
    // 🔥 IGNORAR OFERTAS DUPLICADAS
    if (peers[from] && peers[from].connectionState === "connected") {
        console.log(`ℹ️ Ya conectado con ${from}`);
        return;
    }
    
    try {
        limpiarPeer(from);
        const pc = crearPeerConnection(from);
        
        if (pc.signalingState === 'closed') {
            limpiarPeer(from);
            return;
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
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

        socket.emit("answer", { 
            target: from, 
            answer: pc.localDescription 
        });
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
        console.log(`⚠️ Estado incorrecto: ${pc.signalingState}`);
        limpiarPeer(from);
        isConnecting = false;
        setTimeout(() => socket.emit("clientes-conectados"), 2000);
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida`);
        isConnecting = false;
    } catch (error) {
        console.error(`❌ Error:`, error);
        limpiarPeer(from);
        isConnecting = false;
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
    
    // Limpiar peers que ya no existen
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
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    isConnecting = false;
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
        
        // Mostrar video local
        video.srcObject = stream;
        video.style.display = "block";
        video.muted = true;
        
        try {
            await video.play();
            console.log("📹 Cámara local iniciada");
        } catch (e) {}
        
        await obtenerTurnServers();
        isConnecting = false;
        actualizarEstado("🟢 Cámara lista", "conectado");
        
        setTimeout(() => socket.emit("clientes-conectados"), 1000);
        
    } catch (error) {
        console.error("❌ Error:", error);
        alert("⚠️ No se pudo acceder a la cámara/micrófono.\n\n" + error.message);
        actualizarEstado("🔴 Error de cámara", "desconectado");
        isConnecting = false;
    }
}

// ============================================
// 🚀 INICIALIZACIÓN
// ============================================
window.addEventListener("load", () => {
    console.log("🚀 Iniciando...");
    iniciarCamara();
});

window.addEventListener("beforeunload", () => {
    Object.keys(peers).forEach(key => limpiarPeer(key));
    if (streamLocal) {
        streamLocal.getTracks().forEach(track => track.stop());
    }
    socket.disconnect();
});

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

video.style.display = "none";
videoRemoto.style.display = "none";
video.muted = true;
video.volume = 0;

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

function mostrarVideoRemoto(stream) {
    console.log("📹 ASIGNANDO VIDEO REMOTO");
    if (!stream) return;
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = 0.3;
    video.style.display = "block";
    videoRemoto.play().catch(e => console.warn("⚠️ Error:", e.message));
    actualizarEstado("🟢 Conectado", "conectado");
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject.getTracks().forEach(track => track.stop());
        videoRemoto.srcObject = null;
    }
}

function crearPeerConnection(targetId) {
    console.log(`🔗 Creando conexión con: ${targetId}`);
    
    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    });

    streamLocal.getTracks().forEach(track => {
        console.log(`✅ Agregando track: ${track.kind}`);
        pc.addTrack(track, streamLocal);
    });

    pc.ontrack = (event) => {
        console.log(`📥 Track remoto recibido: ${event.track.kind}`);
        if (event.streams && event.streams[0]) {
            mostrarVideoRemoto(event.streams[0]);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`🧊 ICE candidate enviado a ${targetId}`);
            socket.emit("ice-candidate", { target: targetId, candidate: event.candidate });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado conexión con ${targetId}: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            console.log("✅ ¡CONEXIÓN WEBRTC ESTABLECIDA!");
            actualizarEstado("🟢 Conectado", "conectado");
        } else if (pc.connectionState === "failed") {
            console.log(`❌ Conexión fallida con ${targetId}`);
            ocultarVideoRemoto();
            delete peers[targetId];
        }
    };

    peers[targetId] = pc;
    return pc;
}

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);
    
    try {
        const pc = crearPeerConnection(from);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida (oferta) de ${from}`);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("answer", { target: from, answer: pc.localDescription });
        console.log(`✅ Respuesta enviada a: ${from}`);
    } catch (error) {
        console.error(`❌ Error manejando oferta de ${from}:`, error);
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA RECIBIDA DE: ${from}`);
    const pc = peers[from];
    if (!pc) return;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida (respuesta) de ${from}`);
    } catch (error) {
        console.error(`❌ Error procesando respuesta de ${from}:`, error);
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
        if (!peers[targetId]) {
            console.log(`📤 Iniciando oferta para ${targetId}`);
            const pc = crearPeerConnection(targetId);
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    socket.emit("offer", { target: targetId, offer: pc.localDescription });
                    console.log(`✅ Oferta enviada a: ${targetId}`);
                })
                .catch(error => {
                    console.error(`❌ Error en oferta para ${targetId}:`, error);
                    delete peers[targetId];
                });
        }
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
    conectarConTodos(lista);
});

socket.on("nuevo-cliente", () => {
    console.log("🆕 Nuevo cliente detectado");
    setTimeout(() => socket.emit("clientes-conectados"), 2000);
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    if (peers[data.id]) {
        peers[data.id].close();
        delete peers[data.id];
    }
    ocultarVideoRemoto();
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    actualizarEstado("🔴 Desconectado", "desconectado");
    ocultarVideoRemoto();
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });
});

async function iniciarCamara() {
    try {
        console.log("📷 Solicitando cámara...");
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 } },
            audio: { echoCancellation: true, noiseSuppression: true }
        });
        
        streamLocal = stream;
        video.srcObject = stream;
        video.style.display = "block";
        video.muted = true;
        await video.play();
        console.log("📹 Cámara iniciada");
        
        await obtenerTurnServers();
        socket.emit("clientes-conectados");
    } catch (error) {
        console.error("❌ Error:", error);
        alert("⚠️ No se pudo acceder a la cámara/micrófono.");
        actualizarEstado("🔴 Error", "desconectado");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const controlVolumen = document.getElementById('volumen');
    const labelVolumen = document.getElementById('volumen-label');
    const btnSilenciar = document.getElementById('btn-silenciar');
    const btnReconectar = document.getElementById('btn-reconectar');
    
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
        });
    }
    
    if (btnReconectar) {
        btnReconectar.addEventListener('click', () => {
            console.log("🔄 Forzando reconexión...");
            ocultarVideoRemoto();
            Object.keys(peers).forEach(key => {
                peers[key].close();
                delete peers[key];
            });
            socket.emit("clientes-conectados");
        });
    }
});

window.addEventListener("load", () => {
    console.log("🚀 Iniciando Ventana Digital...");
    iniciarCamara();
});

window.addEventListener("beforeunload", () => {
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });
    if (streamLocal) streamLocal.getTracks().forEach(track => track.stop());
});

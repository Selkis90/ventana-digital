const video = document.getElementById("video");
const videoRemoto = document.getElementById("video-remoto");

// Usar la URL de Render
const socket = io("https://ventana-digital.onrender.com", {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 1000,
    timeout: 30000
});

const peers = {};
let streamLocal = null;
let webRTCIniciado = false;
const conexionesEnProceso = new Set();
const iceCandidatesQueue = {};
let turnServers = [];
let audioContext = null;

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

function mostrarVideoRemoto(stream, fromId) {
    console.log(`📹 ASIGNANDO VIDEO REMOTO DE: ${fromId}`);
    
    if (!stream) {
        console.error("❌ Stream vacío");
        return;
    }

    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = 0.3;
    video.style.display = "block";

    videoRemoto.play()
        .then(() => {
            console.log("✅ Audio y Video remoto reproduciéndose");
            actualizarEstado("🟢 Conectado - Audio y Video en vivo", "conectado");
        })
        .catch(e => {
            console.warn("⚠️ Error reproduciendo video remoto:", e.message);
        });
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    video.style.display = "block";
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject.getTracks().forEach(track => track.stop());
        videoRemoto.srcObject = null;
    }
}

async function crearPeerConnection(targetId) {
    if (peers[targetId]) {
        const pc = peers[targetId];
        if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
            console.log(`⚠️ Ya existe conexión activa con ${targetId}`);
            return pc;
        }
        pc.close();
        delete peers[targetId];
        conexionesEnProceso.delete(targetId);
        delete iceCandidatesQueue[targetId];
    }

    if (conexionesEnProceso.has(targetId)) {
        console.log(`⚠️ Conexión con ${targetId} está en proceso`);
        return null;
    }

    console.log(`🔗 Creando conexión con: ${targetId}`);
    conexionesEnProceso.add(targetId);

    if (!streamLocal) {
        console.error("❌ No hay stream local");
        conexionesEnProceso.delete(targetId);
        return null;
    }

    if (turnServers.length === 0) {
        await obtenerTurnServers();
    }

    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: 10,
        iceTransportPolicy: 'all',
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    });

    // Agregar tracks locales
    streamLocal.getTracks().forEach(track => {
        console.log(`✅ Agregando track local: ${track.kind}`);
        pc.addTrack(track, streamLocal);
    });

    pc.ontrack = (event) => {
        console.log(`📥 Track remoto recibido: ${event.track.kind}`);
        if (event.streams && event.streams[0]) {
            mostrarVideoRemoto(event.streams[0], targetId);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`🧊 ICE candidate generado para ${targetId}`);
            socket.emit("ice-candidate", {
                target: targetId,
                candidate: event.candidate
            });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado conexión con ${targetId}: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            console.log("✅ CONEXIÓN WEBRTC ESTABLECIDA!");
            actualizarEstado("🟢 Conectado", "conectado");
            conexionesEnProceso.delete(targetId);
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            console.log(`❌ Conexión perdida con ${targetId}`);
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            ocultarVideoRemoto();
        }
    };

    peers[targetId] = pc;
    return pc;
}

// Manejar ofertas recibidas
async function manejarOferta(data) {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);

    const pc = await crearPeerConnection(from);
    if (!pc) return;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida (oferta) de ${from}`);

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
    } catch (error) {
        console.error(`❌ Error manejando oferta de ${from}:`, error);
        delete peers[from];
        conexionesEnProceso.delete(from);
    }
}

// Manejar respuestas recibidas
async function manejarRespuesta(data) {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA RECIBIDA DE: ${from}`);
    const pc = peers[from];

    if (!pc) {
        console.warn(`⚠️ No hay conexión para ${from}`);
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida (respuesta) de ${from}`);
        conexionesEnProceso.delete(from);
    } catch (error) {
        console.error(`❌ Error procesando respuesta de ${from}:`, error);
        delete peers[from];
        conexionesEnProceso.delete(from);
    }
}

// Manejar candidatos ICE
async function manejarIceCandidate(data) {
    const { from, candidate } = data;
    console.log(`🧊 ICE candidate RECIBIDO de: ${from}`);
    const pc = peers[from];

    if (!pc) {
        console.warn(`⚠️ No hay conexión para ICE de ${from}`);
        return;
    }

    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`✅ ICE Candidate agregado de: ${from}`);
    } catch (error) {
        console.warn(`⚠️ Error ICE:`, error.message);
    }
}

// Iniciar oferta a un cliente
async function iniciarOferta(targetId) {
    if (peers[targetId] && peers[targetId].connectionState === "connected") {
        console.log(`ℹ️ Ya conectado con ${targetId}`);
        return;
    }
    
    if (conexionesEnProceso.has(targetId)) {
        console.log(`⏳ Conexión con ${targetId} en proceso`);
        return;
    }
    
    console.log(`📤 Iniciando oferta para ${targetId}`);
    
    try {
        const pc = await crearPeerConnection(targetId);
        if (!pc) return;

        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);

        socket.emit("offer", {
            target: targetId,
            offer: pc.localDescription
        });
        console.log(`✅ Oferta enviada a: ${targetId}`);
    } catch (error) {
        console.error(`❌ Error en oferta:`, error);
        delete peers[targetId];
        conexionesEnProceso.delete(targetId);
    }
}

// Conectar con todos los clientes
function conectarConTodos(clientes) {
    console.log("🔄 CONECTANDO CON TODOS...");
    console.log("📋 Clientes:", clientes);
    console.log("📋 Mi ID:", socket.id);

    const otros = clientes.filter(id => id !== socket.id);
    console.log("🎯 Otros:", otros);

    if (otros.length === 0) {
        console.log("⏳ No hay otros clientes");
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
        return;
    }

    // Conectar con cada cliente
    otros.forEach(targetId => {
        if (!peers[targetId] || peers[targetId].connectionState === "failed") {
            setTimeout(() => iniciarOferta(targetId), 1000);
        }
    });
}

// Eventos de Socket.IO
socket.on("offer", manejarOferta);
socket.on("answer", manejarRespuesta);
socket.on("ice-candidate", manejarIceCandidate);

socket.on("clientes-conectados", (listaClientes) => {
    console.log("📋 Lista de clientes recibida:", listaClientes);
    conectarConTodos(listaClientes);
});

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    actualizarEstado("🟢 Conectado", "conectado");
    await obtenerTurnServers();
    setTimeout(() => {
        socket.emit("clientes-conectados");
    }, 2000);
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    actualizarEstado("🔴 Desconectado", "desconectado");
    ocultarVideoRemoto();
    Object.keys(peers).forEach(key => {
        if (peers[key]) {
            peers[key].close();
            delete peers[key];
        }
    });
    conexionesEnProceso.clear();
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente:", data.id);
    if (data.id !== socket.id) {
        setTimeout(() => {
            socket.emit("clientes-conectados");
        }, 2000);
    }
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    if (peers[data.id]) {
        peers[data.id].close();
        delete peers[data.id];
    }
    conexionesEnProceso.delete(data.id);
    ocultarVideoRemoto();
});

// Iniciar cámara
async function iniciarCamara() {
    try {
        console.log("📷 Solicitando cámara...");
        
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                width: { ideal: 640 }, 
                height: { ideal: 480 },
                facingMode: "user"
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        
        streamLocal = stream;
        video.srcObject = stream;
        video.style.display = "block";
        video.muted = true;
        video.volume = 0;
        
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

// Controles de volumen
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
            if (labelVolumen) {
                labelVolumen.textContent = `${Math.round(vol * 100)}%`;
            }
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
                if (peers[key]) {
                    peers[key].close();
                    delete peers[key];
                }
            });
            conexionesEnProceso.clear();
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
        if (peers[key]) {
            peers[key].close();
            delete peers[key];
        }
    });
    if (streamLocal) {
        streamLocal.getTracks().forEach(track => track.stop());
    }
});

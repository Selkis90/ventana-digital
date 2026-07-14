// ============================================
// CONFIGURACIÓN INICIAL
// ============================================
const video = document.getElementById("video");
const socket = io("https://ventana-digital.onrender.com", {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});

// ============================================
// VARIABLES WEBRTC
// ============================================
const peers = {};
let streamLocal = null;

// Crear elemento para video remoto
const videoRemoto = document.createElement("video");
videoRemoto.id = "video-remoto";
videoRemoto.autoplay = true;
videoRemoto.playsinline = true;
videoRemoto.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 200px;
    height: 150px;
    border-radius: 10px;
    border: 2px solid #00d4ff;
    background: #000;
    z-index: 1000;
    object-fit: cover;
    display: none;
`;
document.body.appendChild(videoRemoto);

// ============================================
// FUNCIONES DE ESTADO Y VIDEO
// ============================================
function actualizarEstado(mensaje, tipo) {
    const estado = document.getElementById("estado");
    if (estado) {
        estado.textContent = mensaje;
        estado.className = tipo || "inicializando";
    }
}

function mostrarVideoRemoto(stream) {
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    console.log("📹 Video remoto mostrado");
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject.getTracks().forEach(track => track.stop());
        videoRemoto.srcObject = null;
    }
}

// ============================================
// FUNCIONES WEBRTC
// ============================================
async function crearConexion(targetId) {
    try {
        console.log("🔗 Creando conexión con:", targetId);

        if (!streamLocal) {
            console.error("❌ No hay stream local disponible");
            return null;
        }

        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" }
            ]
        });

        // Agregar tracks locales
        streamLocal.getTracks().forEach(track => {
            pc.addTrack(track, streamLocal);
        });

        // Manejar tracks remotos
        pc.ontrack = (event) => {
            console.log("📥 Track remoto recibido");
            if (event.streams && event.streams[0]) {
                mostrarVideoRemoto(event.streams[0]);
            }
        };

        // Manejar ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("ice-candidate", {
                    target: targetId,
                    candidate: event.candidate
                });
            }
        };

        // Manejar estado de la conexión
        pc.onconnectionstatechange = () => {
            console.log("🔗 Estado de conexión:", pc.connectionState);
            if (pc.connectionState === "connected") {
                console.log("✅ Conexión WebRTC establecida con:", targetId);
                actualizarEstado("🟢 Conectado - WebRTC activo", "conectado");
            } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
                console.log("❌ Conexión WebRTC perdida con:", targetId);
                ocultarVideoRemoto();
            }
        };

        // Almacenar la conexión
        peers[targetId] = pc;

        // Crear oferta
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Enviar oferta al otro equipo
        socket.emit("offer", {
            target: targetId,
            offer: pc.localDescription
        });

        console.log("✅ Oferta enviada a:", targetId);
        return pc;

    } catch (error) {
        console.error("❌ Error al crear conexión:", error);
        return null;
    }
}

async function iniciarWebRTC(targetId) {
    if (!streamLocal) {
        console.error("❌ No hay stream local para WebRTC");
        return;
    }

    // Esperar un momento para asegurar que el stream esté listo
    await new Promise(resolve => setTimeout(resolve, 1000));
    await crearConexion(targetId);
}

// ============================================
// MANEJADORES DE SOCKET.IO (WEBRTC)
// ============================================
// Manejar ofertas entrantes
socket.on("offer", async (data) => {
    console.log("📩 Oferta recibida de:", data.from);

    try {
        if (!streamLocal) {
            console.error("❌ No hay stream local disponible");
            return;
        }

        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" }
            ]
        });

        // Agregar tracks locales
        streamLocal.getTracks().forEach(track => {
            pc.addTrack(track, streamLocal);
        });

        pc.ontrack = (event) => {
            console.log("📥 Track remoto recibido (como respuesta)");
            if (event.streams && event.streams[0]) {
                mostrarVideoRemoto(event.streams[0]);
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("ice-candidate", {
                    target: data.from,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.log("🔗 Estado de conexión (respuesta):", pc.connectionState);
            if (pc.connectionState === "connected") {
                console.log("✅ Conexión WebRTC establecida con:", data.from);
                actualizarEstado("🟢 Conectado - WebRTC activo", "conectado");
            } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
                console.log("❌ Conexión WebRTC perdida con:", data.from);
                ocultarVideoRemoto();
            }
        };

        // Establecer descripción remota
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

        // Crear respuesta
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Enviar respuesta
        socket.emit("answer", {
            target: data.from,
            answer: pc.localDescription
        });

        peers[data.from] = pc;
        console.log("✅ Respuesta enviada a:", data.from);

    } catch (error) {
        console.error("❌ Error al manejar oferta:", error);
    }
});

// Manejar respuestas entrantes
socket.on("answer", async (data) => {
    console.log("📩 Respuesta recibida de:", data.from);

    try {
        const pc = peers[data.from];
        if (!pc) {
            console.error("❌ No hay conexión para:", data.from);
            return;
        }

        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        console.log("✅ Respuesta procesada de:", data.from);

    } catch (error) {
        console.error("❌ Error al procesar respuesta:", error);
    }
});

// Manejar ICE candidates entrantes
socket.on("ice-candidate", async (data) => {
    console.log("🧊 ICE Candidate recibido de:", data.from);

    try {
        const pc = peers[data.from];
        if (!pc) {
            console.error("❌ No hay conexión para agregar ICE candidate:", data.from);
            return;
        }

        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        console.log("✅ ICE Candidate agregado de:", data.from);

    } catch (error) {
        console.error("❌ Error al agregar ICE candidate:", error);
    }
});

// Manejar nuevos clientes
socket.on("nuevo-cliente", async (data) => {
    console.log("🆕 Nuevo cliente conectado. Total:", data.total);

    if (data.total === 2) {
        console.log("🎯 Dos clientes conectados. Iniciando WebRTC...");
        // El cliente que se conecta segundo inicia la comunicación
        // El primero espera la oferta
        setTimeout(() => {
            if (Object.keys(peers).length === 0) {
                // Obtener el ID del otro cliente
                socket.emit("clientes-conectados", (clientes) => {
                    const targetId = clientes.find(id => id !== socket.id);
                    if (targetId) {
                        iniciarWebRTC(targetId);
                    }
                });
            }
        }, 2000);
    }
});

// Manejar desconexión de clientes
socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado. Total:", data.total);

    // Limpiar peers del cliente desconectado
    if (peers[data.id]) {
        peers[data.id].close();
        delete peers[data.id];
    }

    // Ocultar video remoto
    ocultarVideoRemoto();
    actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");

    if (data.total <= 1) {
        console.log("⏳ Esperando otro cliente...");
    }
});

// Manejar lista de clientes conectados
socket.on("clientes-conectados", (clientes) => {
    console.log("📋 Clientes conectados:", clientes);
    if (clientes.length === 2 && Object.keys(peers).length === 0) {
        const targetId = clientes.find(id => id !== socket.id);
        if (targetId) {
            console.log("🎯 Iniciando WebRTC con:", targetId);
            setTimeout(() => iniciarWebRTC(targetId), 2000);
        }
    }
});

// ============================================
// MANEJADORES DE SOCKET.IO (CONEXIÓN)
// ============================================
socket.on("connect", () => {
    console.log("✅ Conectado al servidor:", socket.id);
    actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    actualizarEstado("🔴 Desconectado", "desconectado");
    ocultarVideoRemoto();
    // Limpiar todas las conexiones
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });
});

socket.on("mensaje", (data) => {
    console.log("📨 Servidor:", data.texto);
});

socket.on("equipo-encontrado", () => {

    console.log("🎉 Equipo encontrado");

    const estado = document.getElementById("estado");

    if (estado) {
        estado.textContent = "🟢 Equipo encontrado";
    }

});

// ============================================
// FUNCIÓN PRINCIPAL: INICIAR CÁMARA
// ============================================
async function iniciarCamara() {
    try {
        const constraints = {
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 }
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamLocal = stream;
        video.srcObject = stream;

        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                video.play();
                resolve();
            };
        });

        console.log("📹 Cámara iniciada correctamente");
        console.log("📐 Resolución:", video.videoWidth, "x", video.videoHeight);

        // Solicitar lista de clientes conectados
        socket.emit("clientes-conectados", (clientes) => {
            console.log("📋 Clientes conectados al inicio:", clientes);
            if (clientes.length === 2) {
                const targetId = clientes.find(id => id !== socket.id);
                if (targetId) {
                    console.log("🎯 Iniciando WebRTC con:", targetId);
                    setTimeout(() => iniciarWebRTC(targetId), 3000);
                }
            }
        });

    } catch (error) {
        console.error("❌ Error al acceder a la cámara:", error);
        alert("No se pudo acceder a la cámara.\nVerifica que esté conectada.");
    }
}

// ============================================
// INICIO DE LA APLICACIÓN
// ============================================
window.addEventListener("load", () => {
    console.log("🚀 Iniciando Ventana Digital...");
    iniciarCamara();
});

// Manejar cierre de página
window.addEventListener("beforeunload", () => {
    // Cerrar todas las conexiones WebRTC
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });
    // Detener tracks de la cámara
    if (streamLocal) {
        streamLocal.getTracks().forEach(track => track.stop());
    }
});

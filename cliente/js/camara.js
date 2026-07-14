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
let webRTCIniciado = false;
let reintentos = 0;
const MAX_REINTENTOS = 3;

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
    console.log("📹 ASIGNANDO VIDEO REMOTO");
    console.log("📹 Stream:", stream);
    
    if (!stream) {
        console.error("❌ Stream vacío");
        return;
    }

    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block !important";
    videoRemoto.style.visibility = "visible";
    videoRemoto.style.opacity = "1";
    videoRemoto.style.width = "320px";
    videoRemoto.style.height = "240px";
    videoRemoto.style.border = "3px solid #00ff88";
    videoRemoto.style.borderRadius = "12px";
    videoRemoto.style.position = "fixed";
    videoRemoto.style.bottom = "20px";
    videoRemoto.style.right = "20px";
    videoRemoto.style.zIndex = "9999";
    videoRemoto.style.objectFit = "cover";
    videoRemoto.style.background = "#111";

    videoRemoto.play().then(() => {
        console.log("✅ Video remoto reproduciéndose");
    }).catch(err => {
        console.warn("⚠️ Error al reproducir:", err);
    });

    console.log("✅ Video remoto asignado");
    console.log("📹 srcObject ahora:", videoRemoto.srcObject);
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
async function crearConexion(targetId, esOferente = true) {
    try {
        console.log(`🔗 Creando conexión (${esOferente ? 'Oferente' : 'Receptor'}) con:`, targetId);

        if (!streamLocal) {
            console.error("❌ No hay stream local disponible");
            return null;
        }

        // Si ya existe conexión con este target, no crear otra
        if (peers[targetId]) {
            console.log("⚠️ Ya existe conexión con:", targetId);
            return peers[targetId];
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
            console.log("📥 Streams:", event.streams);
            console.log("📥 Track:", event.track);
            
            if (event.streams && event.streams[0]) {
                const stream = event.streams[0];
                console.log("📥 Stream recibido, asignando...");
                mostrarVideoRemoto(stream);
            } else if (event.track) {
                const newStream = new MediaStream([event.track]);
                console.log("📥 Creando stream desde track:", newStream);
                mostrarVideoRemoto(newStream);
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
            console.log(`🔗 Estado con ${targetId}:`, pc.connectionState);
            if (pc.connectionState === "connected") {
                console.log("✅ Conexión WebRTC establecida con:", targetId);
                actualizarEstado("🟢 Conectado - WebRTC activo", "conectado");
                webRTCIniciado = true;
                reintentos = 0;
            } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
                console.log("❌ Conexión WebRTC perdida con:", targetId);
                ocultarVideoRemoto();
                webRTCIniciado = false;
                delete peers[targetId];
                
                // Intentar reconectar
                if (reintentos < MAX_REINTENTOS) {
                    reintentos++;
                    console.log(`🔄 Reintento ${reintentos} de ${MAX_REINTENTOS}...`);
                    setTimeout(() => {
                        socket.emit("clientes-conectados", conectarConTodos);
                    }, 3000);
                }
            }
        };

        // Almacenar la conexión
        peers[targetId] = pc;

        // SOLO EL OFERENTE CREA LA OFERTA
        if (esOferente) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            socket.emit("offer", {
                target: targetId,
                offer: pc.localDescription
            });

            console.log("✅ Oferta enviada a:", targetId);
        }

        return pc;

    } catch (error) {
        console.error("❌ Error al crear conexión:", error);
        return null;
    }
}

async function iniciarWebRTC(targetId) {
    if (webRTCIniciado && peers[targetId]) {
        console.log(`⚠️ WebRTC ya iniciado con ${targetId}, ignorando...`);
        return;
    }

    if (!streamLocal) {
        console.error("❌ No hay stream local para WebRTC");
        return;
    }

    console.log("🎯 Iniciando WebRTC con:", targetId);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await crearConexion(targetId, true);
}

// ============================================
// CONEXIÓN CON TODOS LOS DISPOSITIVOS
// ============================================
function conectarConTodos(clientes) {
    // Filtrar mi propio ID
    const otros = clientes.filter(id => id !== socket.id);
    
    console.log(`📋 Conectando con ${otros.length} dispositivos:`, otros);

    if (otros.length === 0) {
        actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");
        webRTCIniciado = false;
        return;
    }

    // Conectar con cada dispositivo
    otros.forEach(targetId => {
        if (peers[targetId]) {
            console.log(`⚠️ Ya conectado con ${targetId}`);
            return;
        }
        
        console.log(`🎯 Conectando con: ${targetId}`);
        setTimeout(() => {
            iniciarWebRTC(targetId);
        }, 1000);
    });
}

// ============================================
// MANEJADORES DE SOCKET.IO (WEBRTC)
// ============================================
socket.on("offer", async (data) => {
    console.log("📩 Oferta recibida de:", data.from);

    if (peers[data.from]) {
        console.log("⚠️ Conexión ya existe con:", data.from);
        return;
    }

    try {
        if (!streamLocal) {
            console.error("❌ No hay stream local disponible");
            return;
        }

        const pc = await crearConexion(data.from, false);
        if (!pc) return;

        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("answer", {
            target: data.from,
            answer: pc.localDescription
        });

        console.log("✅ Respuesta enviada a:", data.from);

    } catch (error) {
        console.error("❌ Error al manejar oferta:", error);
    }
});

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

// ============================================
// MANEJADORES DE SOCKET.IO (CONEXIÓN)
// ============================================
socket.on("connect", () => {
    console.log("✅ Conectado al servidor:", socket.id);
    actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");
    reintentos = 0;
    
    // Cuando me conecto, solicito la lista de clientes
    socket.emit("clientes-conectados", conectarConTodos);
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    actualizarEstado("🔴 Desconectado", "desconectado");
    ocultarVideoRemoto();
    webRTCIniciado = false;
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });
});

socket.on("mensaje", (data) => {
    console.log("📨 Servidor:", data.texto);
});

// ============================================
// MANEJADOR DE CLIENTES (MULTIPLE)
// ============================================
socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente conectado. ID:", data.id);
    // Esperar un momento y conectar con todos
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 1500);
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);

    if (peers[data.id]) {
        peers[data.id].close();
        delete peers[data.id];
    }

    ocultarVideoRemoto();
    webRTCIniciado = false;
    reintentos = 0;
    actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");

    // Reconectar con los que quedan
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 1000);
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

        // Solicitar clientes existentes
        socket.emit("clientes-conectados", conectarConTodos);

    } catch (error) {
        console.error("❌ Error al acceder a la cámara:", error);
        alert("No se pudo acceder a la cámara.\nVerifica que esté conectada.");
    }
}

// ============================================
// FUNCIÓN DE RECONEXIÓN MANUAL (DESDE CONSOLA)
// ============================================
function forzarReconexion() {
    console.log("🔄 Forzando reconexión...");
    ocultarVideoRemoto();
    webRTCIniciado = false;
    reintentos = 0;
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });
    
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 1000);
}

// Exponer función para usar desde consola
window.forzarReconexion = forzarReconexion;
console.log("💡 Para forzar reconexión, escribe: forzarReconexion()");

// ============================================
// INICIO DE LA APLICACIÓN
// ============================================
window.addEventListener("load", () => {
    console.log("🚀 Iniciando Ventana Digital...");
    iniciarCamara();
});

// Manejar cierre de página
window.addEventListener("beforeunload", () => {
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });
    if (streamLocal) {
        streamLocal.getTracks().forEach(track => track.stop());
    }
});

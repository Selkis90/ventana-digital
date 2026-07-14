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

        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" }
            ]
        });

        streamLocal.getTracks().forEach(track => {
            pc.addTrack(track, streamLocal);
        });

        pc.ontrack = (event) => {
            console.log("📥 Track remoto recibido");
            if (event.streams && event.streams[0]) {
                mostrarVideoRemoto(event.streams[0]);
            } else if (event.track) {
                const newStream = new MediaStream([event.track]);
                mostrarVideoRemoto(newStream);
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("ice-candidate", {
                    target: targetId,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.log("🔗 Estado de conexión:", pc.connectionState);
            if (pc.connectionState === "connected") {
                console.log("✅ Conexión WebRTC establecida con:", targetId);
                actualizarEstado("🟢 Conectado - WebRTC activo", "conectado");
                webRTCIniciado = true;
                reintentos = 0;
            } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
                console.log("❌ Conexión WebRTC perdida con:", targetId);
                ocultarVideoRemoto();
                webRTCIniciado = false;
                // Intentar reconectar
                if (reintentos < MAX_REINTENTOS) {
                    reintentos++;
                    console.log(`🔄 Reintento ${reintentos} de ${MAX_REINTENTOS}...`);
                    setTimeout(() => {
                        if (!webRTCIniciado) {
                            socket.emit("clientes-conectados", (clientes) => {
                                const targetId = clientes.find(id => id !== socket.id);
                                if (targetId) iniciarWebRTC(targetId);
                            });
                        }
                    }, 3000);
                }
            }
        };

        peers[targetId] = pc;

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
    if (webRTCIniciado) {
        console.log("⚠️ WebRTC ya iniciado, ignorando...");
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
// MANEJADOR DE CLIENTES (SIN GLARE Y CON RECONEXIÓN)
// ============================================
socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente conectado. Total:", data.total);

    if (data.total === 2 && !webRTCIniciado) {
        console.log("🎯 Segundo cliente. Iniciando WebRTC...");
        
        // Esperar a que el stream esté listo
        const esperarStream = async () => {
            let intentos = 0;
            while (!streamLocal && intentos < 10) {
                await new Promise(resolve => setTimeout(resolve, 500));
                intentos++;
            }
            
            if (!streamLocal) {
                console.error("❌ No hay stream local después de esperar");
                return;
            }

            socket.emit("clientes-conectados", (clientes) => {
                const targetId = clientes.find(id => id !== socket.id);
                if (targetId && !webRTCIniciado) {
                    console.log("🎯 Iniciando WebRTC con:", targetId);
                    iniciarWebRTC(targetId);
                }
            });
        };
        
        esperarStream();
    }
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado. Total:", data.total);

    if (peers[data.id]) {
        peers[data.id].close();
        delete peers[data.id];
    }

    ocultarVideoRemoto();
    webRTCIniciado = false;
    actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");
    reintentos = 0;

    if (data.total <= 1) {
        console.log("⏳ Esperando otro cliente...");
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

        // Verificar si ya hay otro equipo conectado
        socket.emit("clientes-conectados", (clientes) => {
            if (clientes.length === 2) {
                const targetId = clientes.find(id => id !== socket.id);
                if (targetId && !webRTCIniciado) {
                    console.log("🎯 Equipo ya conectado. Iniciando WebRTC...");
                    iniciarWebRTC(targetId);
                }
            }
        });

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
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });
    
    setTimeout(() => {
        socket.emit("clientes-conectados", (clientes) => {
            const targetId = clientes.find(id => id !== socket.id);
            if (targetId) {
                console.log("🎯 Reconectando con:", targetId);
                iniciarWebRTC(targetId);
            } else {
                console.log("⏳ Esperando otro equipo...");
                actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");
            }
        });
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

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

// Crear elemento para video remoto
const videoRemoto = document.createElement("video");
videoRemoto.id = "video-remoto";
videoRemoto.autoplay = true;
videoRemoto.playsinline = true;
videoRemoto.muted = false;
videoRemoto.volume = 1.0;
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
// ELEMENTO DE AUDIO SEPARADO (más confiable)
// ============================================
const audioRemoto = document.createElement("audio");
audioRemoto.id = "audio-remoto";
audioRemoto.autoplay = true;
audioRemoto.muted = false;
audioRemoto.volume = 1.0;
audioRemoto.style.display = "none";
document.body.appendChild(audioRemoto);
console.log("🎧 Elemento de audio separado creado");

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

// ============================================
// FUNCIÓN MEJORADA PARA MOSTRAR VIDEO REMOTO CON AUDIO
// ============================================
function mostrarVideoRemoto(stream) {
    console.log("📹 ASIGNANDO VIDEO REMOTO CON AUDIO");
    if (!stream) {
        console.error("❌ Stream vacío");
        return;
    }

    // Verificar tracks de audio
    const audioTracks = stream.getAudioTracks();
    console.log("🎤 Tracks de audio en el stream:", audioTracks.length);

    // 1. Asignar al video
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = 1.0;

    // 2. Asignar al audio separado (más confiable)
    audioRemoto.srcObject = stream;
    audioRemoto.muted = false;
    audioRemoto.volume = 1.0;

    // 3. Reproducir audio separado
    setTimeout(() => {
        audioRemoto.play().then(() => {
            console.log("🔊 Audio remoto reproduciéndose (separado)");
        }).catch(err => {
            console.warn("⚠️ Error en audio separado:", err.message);
            // Intentar de nuevo
            setTimeout(() => {
                audioRemoto.play().catch(e => console.warn("⚠️ Segundo intento falló:", e.message));
            }, 1000);
        });
    }, 200);

    // 4. Reproducir video
    setTimeout(() => {
        videoRemoto.play().catch(err => {
            console.warn("⚠️ Error al reproducir video:", err.message);
        });
    }, 100);

    // 5. Asegurar que los tracks de audio están habilitados
    audioTracks.forEach(track => {
        track.enabled = true;
        console.log("✅ Track de audio habilitado:", track.label);
    });

    console.log("✅ Video y audio remoto asignados");
}

// ============================================
// FUNCIÓN PARA OCULTAR VIDEO REMOTO (con limpieza de audio)
// ============================================
function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject.getTracks().forEach(track => track.stop());
        videoRemoto.srcObject = null;
    }
    // Limpiar audio separado
    if (audioRemoto) {
        audioRemoto.pause();
        audioRemoto.srcObject = null;
    }
}

// ============================================
// FUNCIONES WEBRTC
// ============================================
async function conectarConTodos(clientes) {
    console.log("🔄 CONECTANDO CON TODOS...");
    console.log("📋 Clientes totales:", clientes);
    console.log("📋 Mi ID:", socket.id);

    const otros = clientes.filter(id => id !== socket.id);
    console.log("🎯 Otros clientes:", otros);

    if (otros.length === 0) {
        console.log("⏳ No hay otros clientes. Esperando...");
        actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");
        return;
    }

    for (const targetId of otros) {
        if (peers[targetId]) {
            console.log(`⚠️ Ya conectado con ${targetId}`);
            continue;
        }

        console.log(`🔗 Creando conexión con: ${targetId}`);

        if (!streamLocal) {
            console.error("❌ No hay stream local");
            return;
        }

        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" }
            ]
        });

        // Agregar tracks locales (video y audio)
        streamLocal.getTracks().forEach(track => {
            pc.addTrack(track, streamLocal);
            console.log(`📹 Track ${track.kind} agregado`);
        });

        // Manejar tracks remotos
        pc.ontrack = (event) => {
            console.log("📥 Track remoto recibido de:", targetId);
            console.log("📥 Track kind:", event.track.kind);
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
            console.log(`🔗 Estado con ${targetId}:`, pc.connectionState);
            if (pc.connectionState === "connected") {
                console.log("✅ CONEXIÓN WEBRTC ESTABLECIDA!");
                actualizarEstado("🟢 Conectado - WebRTC activo", "conectado");
                webRTCIniciado = true;
            } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
                console.log(`❌ Conexión perdida con ${targetId}`);
                delete peers[targetId];
                webRTCIniciado = false;
            }
        };

        peers[targetId] = pc;

        console.log("📤 Creando oferta...");
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit("offer", {
            target: targetId,
            offer: pc.localDescription
        });

        console.log("✅ Oferta enviada a:", targetId);
    }
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

    if (!streamLocal) {
        console.error("❌ No hay stream local");
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

    // Manejar tracks remotos
    pc.ontrack = (event) => {
        console.log("📥 Track remoto recibido de:", data.from);
        console.log("📥 Track kind:", event.track.kind);
        if (event.streams && event.streams[0]) {
            mostrarVideoRemoto(event.streams[0]);
        }
    };

    // Manejar ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit("ice-candidate", {
                target: data.from,
                candidate: event.candidate
            });
        }
    };

    // Manejar estado de la conexión
    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado con ${data.from}:`, pc.connectionState);
        if (pc.connectionState === "connected") {
            console.log("✅ CONEXIÓN WEBRTC ESTABLECIDA!");
            actualizarEstado("🟢 Conectado - WebRTC activo", "conectado");
            webRTCIniciado = true;
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            console.log(`❌ Conexión perdida con ${data.from}`);
            delete peers[data.from];
            webRTCIniciado = false;
        }
    };

    peers[data.from] = pc;

    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("answer", {
        target: data.from,
        answer: pc.localDescription
    });

    console.log("✅ Respuesta enviada a:", data.from);
});

socket.on("answer", async (data) => {
    console.log("📩 Respuesta recibida de:", data.from);
    const pc = peers[data.from];
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    console.log("✅ Respuesta procesada de:", data.from);
});

socket.on("ice-candidate", async (data) => {
    console.log("🧊 ICE Candidate de:", data.from);
    const pc = peers[data.from];
    if (!pc) return;
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
});

// ============================================
// MANEJADORES DE SOCKET.IO (CONEXIÓN)
// ============================================
socket.on("connect", () => {
    console.log("✅ Conectado al servidor:", socket.id);
    actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 2000);
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

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente conectado:", data.id);
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 3000);
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    if (peers[data.id]) {
        peers[data.id].close();
        delete peers[data.id];
    }
    ocultarVideoRemoto();
    webRTCIniciado = false;
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 2000);
});

// ============================================
// INICIAR CÁMARA
// ============================================
async function iniciarCamara() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 } },
            audio: true
        });
        streamLocal = stream;
        video.srcObject = stream;
        await new Promise(resolve => {
            video.onloadedmetadata = () => {
                video.play();
                resolve();
            };
        });
        console.log("📹 Cámara iniciada");

        // Esperar y conectar con clientes existentes
        setTimeout(() => {
            socket.emit("clientes-conectados", conectarConTodos);
        }, 3000);

    } catch (error) {
        console.error("❌ Error cámara:", error);
        alert("No se pudo acceder a la cámara.");
    }
}

// ============================================
// FUNCIÓN DE RECONEXIÓN MANUAL
// ============================================
window.forzarReconexion = () => {
    console.log("🔄 Forzando reconexión...");
    ocultarVideoRemoto();
    webRTCIniciado = false;
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 1000);
};

console.log("💡 Para forzar reconexión: forzarReconexion()");

// ============================================
// INICIO
// ============================================
window.addEventListener("load", () => {
    console.log("🚀 Iniciando Ventana Digital...");
    iniciarCamara();
});

window.addEventListener("beforeunload", () => {
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });
    if (streamLocal) {
        streamLocal.getTracks().forEach(track => track.stop());
    }
    if (audioRemoto) {
        audioRemoto.pause();
        audioRemoto.srcObject = null;
    }
});

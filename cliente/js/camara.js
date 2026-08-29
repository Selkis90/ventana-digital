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
let isProcessingAnswer = {}; // Controlar procesamiento de respuestas

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
    
    // Detener stream anterior si existe
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject.getTracks().forEach(track => track.stop());
        videoRemoto.srcObject = null;
    }
    
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = 0.3;
    video.style.display = "block";
    
    // Manejar el play con reintentos
    const playVideo = async () => {
        try {
            await videoRemoto.play();
            actualizarEstado("🟢 Conectado", "conectado");
        } catch (error) {
            console.warn("⚠️ Error al reproducir:", error.message);
            // Reintentar después de un breve delay
            setTimeout(() => {
                videoRemoto.play().catch(e => console.warn("⚠️ Error en reintento:", e.message));
            }, 500);
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
}

function crearPeerConnection(targetId) {
    console.log(`🔗 Creando conexión con: ${targetId}`);
    
    // Si ya existe una conexión para este target, cerrarla
    if (peers[targetId]) {
        try {
            peers[targetId].close();
        } catch (e) {}
        delete peers[targetId];
    }
    
    const pc = new RTCPeerConnection({
        iceServers: turnServers,
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    });

    // Agregar tracks locales
    if (streamLocal) {
        streamLocal.getTracks().forEach(track => {
            console.log(`✅ Agregando track: ${track.kind}`);
            pc.addTrack(track, streamLocal);
        });
    }

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

    pc.oniceconnectionstatechange = () => {
        console.log(`🔗 Estado ICE con ${targetId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === "failed") {
            console.log(`❌ ICE falló con ${targetId}, reiniciando...`);
            // Intentar reconectar
            setTimeout(() => {
                if (peers[targetId]) {
                    reiniciarConexion(targetId);
                }
            }, 3000);
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
            if (peers[targetId]) {
                peers[targetId].close();
                delete peers[targetId];
            }
            // Reintentar conexión
            setTimeout(() => {
                socket.emit("clientes-conectados");
            }, 5000);
        } else if (pc.connectionState === "disconnected") {
            console.log(`🔴 Conexión desconectada con ${targetId}, intentando reconectar...`);
            setTimeout(() => {
                if (peers[targetId] && peers[targetId].connectionState === "disconnected") {
                    reiniciarConexion(targetId);
                }
            }, 3000);
        }
    };

    // Manejar negociación necesaria
    pc.onnegotiationneeded = async () => {
        console.log(`🤝 Negociación necesaria con ${targetId}`);
        try {
            await pc.setLocalDescription(await pc.createOffer());
            socket.emit("offer", { target: targetId, offer: pc.localDescription });
        } catch (error) {
            console.error("❌ Error en negociación:", error);
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
    // Esperar un momento antes de reconectar
    setTimeout(() => {
        const pc = crearPeerConnection(targetId);
        // Iniciar oferta
        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                socket.emit("offer", { target: targetId, offer: pc.localDescription });
                console.log(`✅ Oferta de reconexión enviada a: ${targetId}`);
            })
            .catch(error => {
                console.error(`❌ Error en reconexión para ${targetId}:`, error);
                delete peers[targetId];
            });
    }, 1000);
}

socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);
    
    try {
        // Si ya existe conexión, cerrarla
        if (peers[from]) {
            try {
                peers[from].close();
            } catch (e) {}
            delete peers[from];
        }
        
        const pc = crearPeerConnection(from);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida (oferta) de ${from}`);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("answer", { target: from, answer: pc.localDescription });
        console.log(`✅ Respuesta enviada a: ${from}`);
    } catch (error) {
        console.error(`❌ Error manejando oferta de ${from}:`, error);
        // Si hay error, limpiar
        if (peers[from]) {
            peers[from].close();
            delete peers[from];
        }
    }
});

socket.on("answer", async (data) => {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA RECIBIDA DE: ${from}`);
    
    // Evitar procesar la misma respuesta múltiples veces
    if (isProcessingAnswer[from]) {
        console.log(`⏳ Ya procesando respuesta de ${from}, ignorando...`);
        return;
    }
    
    const pc = peers[from];
    if (!pc) {
        console.log(`⚠️ No hay peer para ${from}, ignorando respuesta`);
        return;
    }

    // Verificar el estado antes de setRemoteDescription
    if (pc.signalingState === 'stable') {
        console.log(`⚠️ Estado stable para ${from}, ignorando respuesta (ya conectado)`);
        return;
    }

    if (pc.signalingState !== 'have-local-offer') {
        console.log(`⚠️ Estado incorrecto para setRemoteDescription: ${pc.signalingState}`);
        // Si el estado no es el esperado, intentar reiniciar
        console.log(`🔄 Reiniciando conexión con ${from} por estado incorrecto`);
        reiniciarConexion(from);
        return;
    }

    isProcessingAnswer[from] = true;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida (respuesta) de ${from}`);
    } catch (error) {
        console.error(`❌ Error procesando respuesta de ${from}:`, error);
        // Si hay error, reiniciar la conexión
        console.log(`🔄 Reiniciando conexión con ${from} por error`);
        reiniciarConexion(from);
    } finally {
        delete isProcessingAnswer[from];
    }
});

socket.on("ice-candidate", async (data) => {
    const { from, candidate } = data;
    console.log(`🧊 ICE candidate RECIBIDO de: ${from}`);
    const pc = peers[from];
    if (!pc) {
        console.log(`⚠️ No hay peer para ${from}, ignorando ICE candidate`);
        return;
    }

    try {
        // Verificar que el peer esté en un estado válido para agregar candidatos
        if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log(`✅ ICE Candidate agregado de: ${from}`);
        } else {
            console.log(`⏳ Esperando descripción remota para ${from}, guardando candidate`);
            // Guardar candidato para agregar después
            if (!pc._pendingCandidates) pc._pendingCandidates = [];
            pc._pendingCandidates.push(candidate);
        }
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
        // Si ya existe conexión y está conectada, no reconectar
        if (peers[targetId]) {
            const state = peers[targetId].connectionState;
            if (state === "connected" || state === "connecting") {
                console.log(`⏳ Ya conectando/conectado con ${targetId} (${state})`);
                return;
            }
            // Si está en otro estado, cerrar y recrear
            try {
                peers[targetId].close();
            } catch (e) {}
            delete peers[targetId];
        }
        
        console.log(`📤 Iniciando oferta para ${targetId}`);
        const pc = crearPeerConnection(targetId);
        
        // Esperar un momento para que se agreguen los tracks
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
                console.error(`❌ Error en oferta para ${targetId}:`, error);
                if (peers[targetId]) {
                    peers[targetId].close();
                    delete peers[targetId];
                }
            });
        }, 500);
    });
}

// Escuchar candidatos pendientes después de establecer descripción remota
socket.on("offer", async (data) => {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);
    
    try {
        if (peers[from]) {
            try {
                peers[from].close();
            } catch (e) {}
            delete peers[from];
        }
        
        const pc = crearPeerConnection(from);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida (oferta) de ${from}`);
        
        // Agregar candidatos pendientes
        if (pc._pendingCandidates && pc._pendingCandidates.length > 0) {
            console.log(`🔄 Agregando ${pc._pendingCandidates.length} candidatos pendientes`);
            for (const candidate of pc._pendingCandidates) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (e) {
                    console.warn("⚠️ Error agregando candidate pendiente:", e.message);
                }
            }
            pc._pendingCandidates = [];
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("answer", { target: from, answer: pc.localDescription });
        console.log(`✅ Respuesta enviada a: ${from}`);
    } catch (error) {
        console.error(`❌ Error manejando oferta de ${from}:`, error);
        if (peers[from]) {
            peers[from].close();
            delete peers[from];
        }
    }
});

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    actualizarEstado("🟢 Conectado", "conectado");
    await obtenerTurnServers();
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
});

socket.on("clientes-conectados", (lista) => {
    console.log("📋 Lista de clientes recibida:", lista);
    // Limpiar peers que ya no existen en la lista
    const clientesActuales = new Set(lista);
    Object.keys(peers).forEach(id => {
        if (!clientesActuales.has(id) && id !== socket.id) {
            console.log(`🧹 Limpiando peer antiguo: ${id}`);
            try {
                peers[id].close();
            } catch (e) {}
            delete peers[id];
        }
    });
    conectarConTodos(lista);
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente detectado:", data.id);
    setTimeout(() => socket.emit("clientes-conectados"), 1000);
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    if (peers[data.id]) {
        try {
            peers[data.id].close();
        } catch (e) {}
        delete peers[data.id];
    }
    // Si solo quedamos nosotros, ocultar video remoto
    const otros = Object.keys(peers).filter(id => id !== socket.id);
    if (otros.length === 0) {
        ocultarVideoRemoto();
        actualizarEstado("🟢 Esperando otro equipo", "conectado");
    }
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    actualizarEstado("🔴 Desconectado", "desconectado");
    ocultarVideoRemoto();
    Object.keys(peers).forEach(key => {
        try {
            peers[key].close();
        } catch (e) {}
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
        try {
            await video.play();
        } catch (e) {
            console.warn("⚠️ Error al iniciar video local:", e.message);
        }
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
                try {
                    peers[key].close();
                } catch (e) {}
                delete peers[key];
            });
            socket.emit("clientes-conectados");
            actualizarEstado("🔄 Reconectando...", "inicializando");
        });
    }
});

window.addEventListener("load", () => {
    console.log("🚀 Iniciando Ventana Digital...");
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
});

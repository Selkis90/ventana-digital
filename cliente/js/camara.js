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
const conexionesEnProceso = new Set();
const iceCandidatesQueue = {}; // Cola para ICE candidates

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
// ELEMENTO DE AUDIO SEPARADO
// ============================================
const audioRemoto = document.createElement("audio");
audioRemoto.id = "audio-remoto";
audioRemoto.autoplay = true;
audioRemoto.muted = false;
audioRemoto.volume = 1.0;
audioRemoto.style.display = "none";
document.body.appendChild(audioRemoto);
console.log("🎧 Elemento de audio separado creado");
window.audioRemoto = audioRemoto;

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
    console.log("📹 ASIGNANDO VIDEO REMOTO CON AUDIO");
    if (!stream) {
        console.error("❌ Stream vacío");
        return;
    }

    const audioTracks = stream.getAudioTracks();
    console.log("🎤 Tracks de audio en el stream:", audioTracks.length);
    
    if (audioTracks.length === 0) {
        console.warn("⚠️ El stream remoto NO tiene tracks de audio");
    } else {
        audioTracks.forEach(track => {
            track.enabled = true;
            console.log("✅ Track de audio habilitado:", track.label);
        });
    }

    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = 1.0;

    audioRemoto.srcObject = stream;
    audioRemoto.muted = false;
    audioRemoto.volume = 1.0;

    let audioActivado = false;
    
    function reproducirAudio() {
        if (audioActivado) return;
        audioActivado = true;
        
        const promesas = [
            audioRemoto.play().catch(() => {}),
            videoRemoto.play().catch(() => {})
        ];
        
        Promise.all(promesas).then(() => {
            console.log("🔊 Audio y video remoto reproduciéndose");
        }).catch(() => {
            console.warn("⚠️ Error en reproducción automática, esperando clic");
            const clickHandler = function() {
                audioRemoto.play().catch(() => {});
                videoRemoto.play().catch(() => {});
                document.removeEventListener('click', clickHandler);
                console.log("✅ Audio activado por clic");
            };
            document.addEventListener('click', clickHandler);
            console.log("💡 Haz clic en la página para activar el audio");
        });
    }

    reproducirAudio();

    audioTracks.forEach(track => {
        track.enabled = true;
        console.log("✅ Track de audio habilitado:", track.label);
    });

    console.log("✅ Video y audio remoto asignados");
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject.getTracks().forEach(track => track.stop());
        videoRemoto.srcObject = null;
    }
    if (audioRemoto) {
        audioRemoto.pause();
        audioRemoto.srcObject = null;
    }
}

// ============================================
// FUNCIÓN PARA PROBAR AUDIO LOCAL
// ============================================
function probarAudioLocal(stream) {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        source.connect(analyser);
        
        const dataArray = new Uint8Array(analyser.fftSize);
        let audioDetectado = false;
        
        function checkAudio() {
            analyser.getByteTimeDomainData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                const value = (dataArray[i] - 128) / 128;
                sum += value * value;
            }
            const rms = Math.sqrt(sum / dataArray.length);
            if (rms > 0.01 && !audioDetectado) {
                audioDetectado = true;
                console.log("🎤 ¡AUDIO DETECTADO! Nivel:", rms.toFixed(4));
                console.log("✅ El micrófono está funcionando correctamente");
            }
            requestAnimationFrame(checkAudio);
        }
        checkAudio();
        
        setTimeout(() => {
            if (!audioDetectado) {
                console.warn("⚠️ No se detecta audio del micrófono");
                console.warn("⚠️ Verifica que el micrófono esté conectado y permitido");
            }
        }, 3000);
        
    } catch (e) {
        console.log("ℹ️ No se pudo probar audio localmente:", e.message);
    }
}

// ============================================
// FUNCIÓN PARA CREAR PEER CONNECTION (MEJORADA)
// ============================================
async function crearPeerConnection(targetId) {
    // Verificar si ya existe una conexión activa
    if (peers[targetId]) {
        const pc = peers[targetId];
        if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
            console.log(`⚠️ Ya existe conexión activa con ${targetId}`);
            return pc;
        } else {
            // Limpiar conexión muerta
            console.log(`🧹 Limpiando conexión muerta con ${targetId}`);
            pc.close();
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
        }
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

    // CONFIGURACIÓN CON MÚLTIPLES STUN
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun3.l.google.com:19302" },
            { urls: "stun:stun4.l.google.com:19302" },
            { urls: "stun:stun.voipstunt.com:3478" },
            { urls: "stun:stun.ekiga.net:3478" }
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    });

    // Agregar tracks locales
    const audioTracks = streamLocal.getAudioTracks();
    const videoTracks = streamLocal.getVideoTracks();
    
    console.log("📹 Agregando tracks locales:");
    console.log("  - Audio tracks:", audioTracks.length);
    console.log("  - Video tracks:", videoTracks.length);
    
    audioTracks.forEach(track => {
        track.enabled = true;
        console.log("  ✅ Audio track habilitado:", track.label);
    });
    
    streamLocal.getTracks().forEach(track => {
        pc.addTrack(track, streamLocal);
        console.log(`📹 Track ${track.kind} agregado`);
    });

    // Manejar tracks remotos
    pc.ontrack = (event) => {
        console.log("📥 Track remoto recibido de:", targetId);
        console.log("📥 Track kind:", event.track.kind);
        
        if (event.streams && event.streams[0]) {
            const remoteStream = event.streams[0];
            const remoteAudioTracks = remoteStream.getAudioTracks();
            console.log(`🎯 Stream remoto tiene: ${remoteAudioTracks.length} tracks de audio`);
            
            remoteAudioTracks.forEach(track => {
                track.enabled = true;
                console.log("🎤 Audio track remoto habilitado:", track.label);
            });
            
            mostrarVideoRemoto(remoteStream);
        }
    };

    // Manejar ICE candidates - GUARDAR EN COLA si no hay remoteDescription
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`🧊 ICE candidate generado para ${targetId}`);
            
            // Si ya tenemos remoteDescription, enviar inmediatamente
            if (pc.remoteDescription) {
                socket.emit("ice-candidate", {
                    target: targetId,
                    candidate: event.candidate
                });
                console.log(`📤 ICE candidate enviado a ${targetId}`);
            } else {
                // Guardar en cola para enviar después
                if (!iceCandidatesQueue[targetId]) {
                    iceCandidatesQueue[targetId] = [];
                }
                iceCandidatesQueue[targetId].push(event.candidate);
                console.log(`📦 ICE candidate guardado en cola para ${targetId} (${iceCandidatesQueue[targetId].length} pendientes)`);
            }
        }
    };

    // Manejar estado de la conexión
    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado con ${targetId}:`, pc.connectionState);
        if (pc.connectionState === "connected") {
            console.log("✅ CONEXIÓN WEBRTC ESTABLECIDA!");
            actualizarEstado("🟢 Conectado - WebRTC activo", "conectado");
            webRTCIniciado = true;
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            console.log(`❌ Conexión perdida con ${targetId}`);
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
            webRTCIniciado = false;
            ocultarVideoRemoto();
            
            // RECONEXIÓN AUTOMÁTICA
            console.log("🔄 Intentando reconectar con:", targetId);
            setTimeout(() => {
                if (!peers[targetId] && !conexionesEnProceso.has(targetId)) {
                    iniciarOferta(targetId);
                }
            }, 5000);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`🧊 ICE estado con ${targetId}:`, pc.iceConnectionState);
        if (pc.iceConnectionState === "failed") {
            console.warn("⚠️ ICE failed, reiniciando conexión...");
            pc.restartIce();
        }
    };

    peers[targetId] = pc;
    return pc;
}

// ============================================
// FUNCIÓN PARA ENVIAR ICE CANDIDATES PENDIENTES
// ============================================
function enviarIceCandidatesPendientes(targetId) {
    const pc = peers[targetId];
    if (!pc || !pc.remoteDescription) return;
    
    const pendientes = iceCandidatesQueue[targetId] || [];
    if (pendientes.length === 0) return;
    
    console.log(`📤 Enviando ${pendientes.length} ICE candidates pendientes a ${targetId}`);
    pendientes.forEach(candidate => {
        socket.emit("ice-candidate", {
            target: targetId,
            candidate: candidate
        });
    });
    delete iceCandidatesQueue[targetId];
}

// ============================================
// FUNCIONES WEBRTC - OFERTA Y RESPUESTA
// ============================================
async function iniciarOferta(targetId) {
    // Verificar si ya existe conexión activa
    if (peers[targetId]) {
        const pc = peers[targetId];
        if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
            console.log(`ℹ️ Ya conectado con ${targetId}`);
            return;
        } else {
            pc.close();
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
        }
    }
    
    const pc = await crearPeerConnection(targetId);
    if (!pc) return;

    try {
        console.log("📤 Creando oferta...");
        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);

        socket.emit("offer", {
            target: targetId,
            offer: pc.localDescription
        });
        console.log("✅ Oferta enviada a:", targetId);
        
        // Después de establecer localDescription, enviar ICE candidates pendientes
        setTimeout(() => {
            enviarIceCandidatesPendientes(targetId);
        }, 500);
        
    } catch (error) {
        console.error("❌ Error al crear oferta:", error);
        delete peers[targetId];
        conexionesEnProceso.delete(targetId);
        delete iceCandidatesQueue[targetId];
    }
}

async function manejarOferta(data) {
    const { from, offer } = data;

    // Limpiar conexión existente si está muerta
    if (peers[from]) {
        const pc = peers[from];
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            pc.close();
            delete peers[from];
            conexionesEnProceso.delete(from);
            delete iceCandidatesQueue[from];
        } else {
            console.log(`⚠️ Conexión con ${from} ya existe`);
            return;
        }
    }

    if (conexionesEnProceso.has(from)) {
        console.log(`⚠️ Conexión con ${from} está en proceso`);
        return;
    }

    console.log("📩 Oferta recibida de:", from);
    const pc = await crearPeerConnection(from);
    if (!pc) return;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log("✅ Descripción remota establecida (oferta)");
        
        // Enviar ICE candidates pendientes después de establecer remoteDescription
        enviarIceCandidatesPendientes(from);

        const answer = await pc.createAnswer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(answer);

        socket.emit("answer", {
            target: from,
            answer: pc.localDescription
        });
        console.log("✅ Respuesta enviada a:", from);
        
        // Enviar ICE candidates pendientes después de localDescription
        setTimeout(() => {
            enviarIceCandidatesPendientes(from);
        }, 500);
        
    } catch (error) {
        console.error("❌ Error al manejar oferta:", error);
        delete peers[from];
        conexionesEnProceso.delete(from);
        delete iceCandidatesQueue[from];
    }
}

async function manejarRespuesta(data) {
    const { from, answer } = data;
    const pc = peers[from];

    if (!pc) {
        console.warn("⚠️ No hay conexión para:", from);
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log("✅ Descripción remota establecida (respuesta)");
        conexionesEnProceso.delete(from);
        
        // Enviar ICE candidates pendientes después de remoteDescription
        enviarIceCandidatesPendientes(from);
        
    } catch (error) {
        console.error("❌ Error al procesar respuesta:", error);
        delete peers[from];
        conexionesEnProceso.delete(from);
        delete iceCandidatesQueue[from];
    }
}

async function manejarIceCandidate(data) {
    const { from, candidate } = data;
    const pc = peers[from];

    if (!pc) {
        console.warn(`⚠️ No hay conexión para ICE candidate de: ${from}`);
        // Guardar en cola por si la conexión se establece después
        if (!iceCandidatesQueue[from]) {
            iceCandidatesQueue[from] = [];
        }
        iceCandidatesQueue[from].push(candidate);
        console.log(`📦 ICE candidate guardado en cola para ${from} (${iceCandidatesQueue[from].length} pendientes)`);
        return;
    }

    try {
        // Si no hay remoteDescription, guardar en cola
        if (!pc.remoteDescription) {
            if (!iceCandidatesQueue[from]) {
                iceCandidatesQueue[from] = [];
            }
            iceCandidatesQueue[from].push(candidate);
            console.log(`📦 ICE candidate guardado en cola para ${from} (${iceCandidatesQueue[from].length} pendientes)`);
            return;
        }
        
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log("✅ ICE Candidate agregado de:", from);
    } catch (error) {
        console.warn(`⚠️ Error al agregar ICE candidate de ${from}:`, error.message);
        // Si falla, guardar en cola para reintentar
        if (!iceCandidatesQueue[from]) {
            iceCandidatesQueue[from] = [];
        }
        iceCandidatesQueue[from].push(candidate);
    }
}

// ============================================
// CONECTAR CON TODOS LOS CLIENTES (MEJORADO)
// ============================================
function conectarConTodos(clientes) {
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

    // Limpiar conexiones a clientes que ya no existen
    Object.keys(peers).forEach(id => {
        if (!clientes.includes(id)) {
            console.log(`🧹 Limpiando conexión a cliente desaparecido: ${id}`);
            if (peers[id]) {
                peers[id].close();
                delete peers[id];
            }
            conexionesEnProceso.delete(id);
            delete iceCandidatesQueue[id];
        }
    });

    otros.forEach(targetId => {
        // Verificar si ya hay conexión activa
        if (peers[targetId]) {
            const pc = peers[targetId];
            if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
                console.log(`ℹ️ Ya conectado con ${targetId}`);
                return;
            } else {
                pc.close();
                delete peers[targetId];
                conexionesEnProceso.delete(targetId);
                delete iceCandidatesQueue[targetId];
            }
        }
        
        if (!conexionesEnProceso.has(targetId)) {
            console.log(`🔗 Iniciando conexión con ${targetId}`);
            setTimeout(() => iniciarOferta(targetId), 1000);
        } else {
            console.log(`⚠️ Ya en proceso de conexión con ${targetId}`);
        }
    });
}

// ============================================
// MANEJADORES DE SOCKET.IO
// ============================================
socket.on("offer", manejarOferta);
socket.on("answer", manejarRespuesta);
socket.on("ice-candidate", manejarIceCandidate);

socket.on("connect", () => {
    console.log("✅ Conectado al servidor:", socket.id);
    actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");
    
    // Limpiar estado anterior
    Object.keys(peers).forEach(key => {
        if (peers[key]) {
            peers[key].close();
            delete peers[key];
        }
    });
    conexionesEnProceso.clear();
    Object.keys(iceCandidatesQueue).forEach(key => delete iceCandidatesQueue[key]);
    
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
        if (peers[key]) {
            peers[key].close();
            delete peers[key];
        }
    });
    conexionesEnProceso.clear();
    Object.keys(iceCandidatesQueue).forEach(key => delete iceCandidatesQueue[key]);
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
    conexionesEnProceso.delete(data.id);
    delete iceCandidatesQueue[data.id];
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
        console.log("📷 Solicitando cámara y micrófono...");
        
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                width: { ideal: 640 }, 
                height: { ideal: 480 },
                facingMode: "user"
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
                sampleSize: 16,
                channelCount: 1
            }
        });
        
        streamLocal = stream;
        
        const audioTracks = stream.getAudioTracks();
        console.log("🎤 Tracks de audio disponibles:", audioTracks.length);
        audioTracks.forEach((track, i) => {
            track.enabled = true;
            console.log(`  Track ${i}:`, track.label, "habilitado:", track.enabled);
        });
        
        const videoTracks = stream.getVideoTracks();
        console.log("📹 Tracks de video disponibles:", videoTracks.length);
        
        video.srcObject = stream;
        await new Promise(resolve => {
            video.onloadedmetadata = () => {
                video.play();
                resolve();
            };
        });
        
        console.log("📹 Cámara iniciada correctamente");
        console.log("📐 Resolución:", video.videoWidth, "x", video.videoHeight);
        console.log("🎤 Audio capturado correctamente");
        
        probarAudioLocal(stream);

        setTimeout(() => {
            socket.emit("clientes-conectados", conectarConTodos);
        }, 3000);

    } catch (error) {
        console.error("❌ Error al acceder a cámara/micrófono:", error);
        
        try {
            console.log("🔄 Intentando con configuración básica...");
            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
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
            console.log("📹 Cámara iniciada en modo básico");
            probarAudioLocal(stream);
            
            setTimeout(() => {
                socket.emit("clientes-conectados", conectarConTodos);
            }, 3000);
            
        } catch (fallbackError) {
            console.error("❌ Error en modo básico:", fallbackError);
            alert("⚠️ No se pudo acceder a la cámara o micrófono.\n" +
                  "Verifica que estén conectados y permitidos.");
            actualizarEstado("🔴 Error de cámara", "desconectado");
        }
    }
}

// ============================================
// FUNCIÓN DE RECONEXIÓN MANUAL
// ============================================
window.forzarReconexion = () => {
    console.log("🔄 Forzando reconexión...");
    ocultarVideoRemoto();
    webRTCIniciado = false;
    conexionesEnProceso.clear();
    Object.keys(iceCandidatesQueue).forEach(key => delete iceCandidatesQueue[key]);
    Object.keys(peers).forEach(key => {
        if (peers[key]) {
            peers[key].close();
            delete peers[key];
        }
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
        if (peers[key]) {
            peers[key].close();
            delete peers[key];
        }
    });
    if (streamLocal) {
        streamLocal.getTracks().forEach(track => track.stop());
    }
    if (audioRemoto) {
        audioRemoto.pause();
        audioRemoto.srcObject = null;
    }
});

// ============================================
// PRUEBA DE PING
// ============================================
socket.on("connect", () => {
    setTimeout(() => {
        console.log("🏓 Enviando ping de prueba...");
        socket.emit("ping", { target: socket.id });
    }, 3000);
});

socket.on("pong", (data) => {
    console.log("🏓 PONG recibido del servidor:", data);
});

// ============================================
// RECONEXIÓN AUTOMÁTICA PERIÓDICA
// ============================================
setInterval(() => {
    const conexionesActivas = Object.keys(peers).filter(id => {
        const pc = peers[id];
        return pc && (pc.connectionState === "connected" || pc.connectionState === "connecting");
    });
    
    if (conexionesActivas.length === 0 && socket.connected) {
        console.log("🔄 Sin conexiones activas, verificando clientes...");
        socket.emit("clientes-conectados", conectarConTodos);
    }
}, 10000);

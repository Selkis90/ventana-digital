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
    
    // Verificar si hay tracks de audio
    if (audioTracks.length === 0) {
        console.warn("⚠️ El stream remoto NO tiene tracks de audio");
    } else {
        audioTracks.forEach(track => {
            track.enabled = true;
            console.log("✅ Track de audio habilitado:", track.label);
        });
    }

    // 1. Asignar al video
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = 1.0;

    // 2. Asignar al audio separado
    audioRemoto.srcObject = stream;
    audioRemoto.muted = false;
    audioRemoto.volume = 1.0;

    // 3. 🔥 ESPERAR CLIC DEL USUARIO Y FORZAR REPRODUCCIÓN
    let audioActivado = false;
    
    function reproducirAudio() {
        if (audioActivado) return;
        audioActivado = true;
        
        // Intentar reproducir en ambos elementos
        const promesas = [
            audioRemoto.play().catch(() => {}),
            videoRemoto.play().catch(() => {})
        ];
        
        Promise.all(promesas).then(() => {
            console.log("🔊 Audio y video remoto reproduciéndose");
        }).catch(() => {
            console.warn("⚠️ Error en reproducción automática, esperando clic");
            // Si falla, esperar clic
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

    // Intentar reproducir inmediatamente
    reproducirAudio();

    // 4. Asegurar que los tracks de audio están habilitados
    audioTracks.forEach(track => {
        track.enabled = true;
        console.log("✅ Track de audio habilitado:", track.label);
    });

    console.log("✅ Video y audio remoto asignados");
    console.log("💡 Si no se escucha, haz clic en la página");
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
        
        // Si después de 3 segundos no hay audio, mostrar advertencia
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
    if (peers[targetId] || conexionesEnProceso.has(targetId)) {
        console.log(`⚠️ Conexión con ${targetId} ya existe o está en proceso`);
        return null;
    }

    console.log(`🔗 Creando conexión con: ${targetId}`);
    conexionesEnProceso.add(targetId);

    if (!streamLocal) {
        console.error("❌ No hay stream local");
        conexionesEnProceso.delete(targetId);
        return null;
    }

    // CONFIGURACIÓN MEJORADA CON MÚLTIPLES STUN
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

    // Agregar tracks locales con verificación de audio
    const audioTracks = streamLocal.getAudioTracks();
    const videoTracks = streamLocal.getVideoTracks();
    
    console.log("📹 Agregando tracks locales:");
    console.log("  - Audio tracks:", audioTracks.length);
    console.log("  - Video tracks:", videoTracks.length);
    
    // Asegurar que los tracks de audio estén habilitados
    audioTracks.forEach(track => {
        track.enabled = true;
        console.log("  ✅ Audio track habilitado:", track.label);
    });
    
    // Agregar todos los tracks
    streamLocal.getTracks().forEach(track => {
        pc.addTrack(track, streamLocal);
        console.log(`📹 Track ${track.kind} agregado`);
    });

    // Manejar tracks remotos - MEJORADO
    pc.ontrack = (event) => {
        console.log("📥 Track remoto recibido de:", targetId);
        console.log("📥 Track kind:", event.track.kind);
        console.log("📥 Streams:", event.streams.length);
        
        if (event.streams && event.streams[0]) {
            const remoteStream = event.streams[0];
            const remoteAudioTracks = remoteStream.getAudioTracks();
            console.log(`🎯 Stream remoto tiene: ${remoteAudioTracks.length} tracks de audio`);
            
            // Habilitar tracks de audio remotos
            remoteAudioTracks.forEach(track => {
                track.enabled = true;
                console.log("🎤 Audio track remoto habilitado:", track.label);
            });
            
            mostrarVideoRemoto(remoteStream);
        }
    };

    // Manejar ICE candidates - ENVIAR INMEDIATAMENTE
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`🧊 ICE candidate enviado a ${targetId}`);
            socket.emit("ice-candidate", {
                target: targetId,
                candidate: event.candidate
            });
        }
    };

    // Manejar estado de la conexión - CON RECONEXIÓN AUTOMÁTICA
    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado con ${targetId}:`, pc.connectionState);
        if (pc.connectionState === "connected") {
            console.log("✅ CONEXIÓN WEBRTC ESTABLECIDA!");
            actualizarEstado("🟢 Conectado - WebRTC activo", "conectado");
            webRTCIniciado = true;
            conexionesEnProceso.delete(targetId);
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            console.log(`❌ Conexión perdida con ${targetId}`);
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            webRTCIniciado = false;
            ocultarVideoRemoto();
            
            // RECONEXIÓN AUTOMÁTICA
            console.log("🔄 Intentando reconectar con:", targetId);
            setTimeout(() => {
                if (!peers[targetId] && !conexionesEnProceso.has(targetId)) {
                    iniciarOferta(targetId);
                }
            }, 3000);
        }
    };

    // Manejar errores de ICE
    pc.oniceconnectionstatechange = () => {
        console.log(`🧊 ICE estado con ${targetId}:`, pc.iceConnectionState);
        if (pc.iceConnectionState === "failed") {
            console.warn("⚠️ ICE failed, reiniciando conexión...");
            // Reiniciar ICE
            pc.restartIce();
        }
    };

    peers[targetId] = pc;
    return pc;
}

// ============================================
// FUNCIONES WEBRTC - OFERTA Y RESPUESTA
// ============================================
async function iniciarOferta(targetId) {
    // Verificar si ya existe conexión
    if (peers[targetId]) {
        const pc = peers[targetId];
        if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
            console.log(`⚠️ Ya existe conexión activa con ${targetId}`);
            return;
        } else {
            // Limpiar conexión muerta
            pc.close();
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
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
    } catch (error) {
        console.error("❌ Error al crear oferta:", error);
        delete peers[targetId];
        conexionesEnProceso.delete(targetId);
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
    } catch (error) {
        console.error("❌ Error al manejar oferta:", error);
        delete peers[from];
        conexionesEnProceso.delete(from);
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
    } catch (error) {
        console.error("❌ Error al procesar respuesta:", error);
        delete peers[from];
        conexionesEnProceso.delete(from);
    }
}

async function manejarIceCandidate(data) {
    const { from, candidate } = data;
    const pc = peers[from];

    if (!pc) {
        console.warn("⚠️ No hay conexión para ICE candidate de:", from);
        return;
    }

    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log("✅ ICE Candidate agregado de:", from);
    } catch (error) {
        console.warn("⚠️ Error al agregar ICE candidate:", error.message);
    }
}

// ============================================
// CONECTAR CON TODOS LOS CLIENTES
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

    otros.forEach(targetId => {
        // Verificar si ya hay conexión activa
        if (peers[targetId]) {
            const pc = peers[targetId];
            if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
                console.log(`ℹ️ Ya conectado con ${targetId}`);
                return;
            } else {
                // Limpiar conexión muerta
                pc.close();
                delete peers[targetId];
                conexionesEnProceso.delete(targetId);
            }
        }
        
        if (!conexionesEnProceso.has(targetId)) {
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
    conexionesEnProceso.clear();
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
    ocultarVideoRemoto();
    webRTCIniciado = false;
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 2000);
});

// ============================================
// INICIAR CÁMARA (MEJORADA)
// ============================================
async function iniciarCamara() {
    try {
        console.log("📷 Solicitando cámara y micrófono...");
        
        // CONFIGURACIÓN MÁS EXPLÍCITA PARA AUDIO
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
        
        // Verificar tracks de audio
        const audioTracks = stream.getAudioTracks();
        console.log("🎤 Tracks de audio disponibles:", audioTracks.length);
        audioTracks.forEach((track, i) => {
            track.enabled = true;
            console.log(`  Track ${i}:`, track.label, "habilitado:", track.enabled);
        });
        
        // Verificar tracks de video
        const videoTracks = stream.getVideoTracks();
        console.log("📹 Tracks de video disponibles:", videoTracks.length);
        videoTracks.forEach((track, i) => {
            console.log(`  Track ${i}:`, track.label);
        });
        
        // Asignar al video local
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
        
        // Probar audio local
        probarAudioLocal(stream);

        setTimeout(() => {
            socket.emit("clientes-conectados", conectarConTodos);
        }, 3000);

    } catch (error) {
        console.error("❌ Error al acceder a cámara/micrófono:", error);
        
        // Intentar con configuración básica pero FORZANDO audio
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
            
            // Probar audio local
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

// ============================================
// PRUEBA DE PING (para verificar servidor)
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
    // Verificar si estamos solos o sin conexiones activas
    const conexionesActivas = Object.keys(peers).filter(id => {
        const pc = peers[id];
        return pc && (pc.connectionState === "connected" || pc.connectionState === "connecting");
    });
    
    if (conexionesActivas.length === 0 && socket.connected) {
        console.log("🔄 Sin conexiones activas, verificando clientes...");
        socket.emit("clientes-conectados", conectarConTodos);
    }
}, 10000);

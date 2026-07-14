// ============================================
// CONFIGURACIÓN INICIAL
// ============================================
const video = document.getElementById("video");

// ============================================
// 📡 CONEXIÓN AL SERVIDOR EN RENDER.COM
// ============================================
const socket = io("https://ventana-digital.onrender.com", {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 1000,
    timeout: 30000
});

// ============================================
// VARIABLES WEBRTC
// ============================================
const peers = {};
let streamLocal = null;
let webRTCIniciado = false;
const conexionesEnProceso = new Set();
const iceCandidatesQueue = {};
let turnServers = [];
let audioContext = null;
const ofertasEnviadas = new Set();
const ofertasRecibidas = new Set();

// ============================================
// 🚫 CONTROL DE RECONEXIÓN
// ============================================
let ultimoIntentoReconexion = 0;
const INTERVALO_MINIMO_RECONEXION = 5000;
const intentosReconexion = {};
const MAX_INTENTOS_POR_PEER = 3;
let reconexionActiva = false;

// ============================================
// 🔥 NUEVA VARIABLE PARA SABER SI HAY VIDEO REMOTO
// ============================================
let videoRemotoActivo = false;

// ============================================
// 🎬 CREAR ELEMENTO DE VIDEO REMOTO
// ============================================
const videoRemoto = document.createElement("video");
videoRemoto.id = "video-remoto";
videoRemoto.autoplay = true;
videoRemoto.playsinline = true;
videoRemoto.muted = false;
videoRemoto.volume = 1.0;
// 🔥 NUEVO ESTILO: Video remoto a la derecha (más pequeño)
videoRemoto.style.cssText = `
    position: fixed;
    top: 50%;
    right: 20px;
    transform: translateY(-50%);
    width: 30vw;
    height: 50vh;
    border-radius: 12px;
    border: 3px solid #00d4ff;
    background: #000;
    z-index: 100;
    object-fit: cover;
    box-shadow: 0 0 30px rgba(0, 212, 255, 0.3);
    display: none;
`;
document.body.appendChild(videoRemoto);

// ============================================
// 🎧 ELEMENTO DE AUDIO SEPARADO
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
// 🔥 ESTILOS PARA VIDEO LOCAL
// ============================================
// El video local ahora ocupa toda la pantalla pero con opacidad reducida
// cuando hay video remoto
video.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    object-fit: cover;
    z-index: 1;
    background: #000;
`;

// ============================================
// 🔥 OBTENER CREDENCIALES TURN DEL SERVIDOR
// ============================================
async function obtenerTurnServers() {
    try {
        const response = await fetch('/turn-credentials');
        if (response.ok) {
            const data = await response.json();
            if (data.iceServers) {
                turnServers = data.iceServers;
                console.log('✅ Servidores TURN obtenidos del servidor:', turnServers.length);
                return turnServers;
            }
        }
    } catch (error) {
        console.warn('⚠️ No se pudo obtener TURN del servidor:', error.message);
    }
    
    console.log('🔄 Usando Metered.ca TURN de respaldo');
    turnServers = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" },
        {
            urls: [
                "turn:global.turn.metered.ca:80?transport=udp",
                "turn:global.turn.metered.ca:443?transport=tcp",
                "turn:global.turn.metered.ca:3478?transport=udp"
            ],
            username: "b4a446edd2810f74fb74b06d",
            credential: "e025b9eb858a5142"
        },
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
// 🎯 FUNCIONES DE ESTADO Y VIDEO
// ============================================
function actualizarEstado(mensaje, tipo) {
    const estado = document.getElementById("estado");
    if (estado) {
        estado.textContent = mensaje;
        estado.className = tipo || "inicializando";
    }
}

// ============================================
// 🔥 FUNCIÓN MEJORADA PARA MOSTRAR VIDEO REMOTO (SIN OCULTAR EL LOCAL)
// ============================================
function mostrarVideoRemoto(stream) {
    console.log("📹 ASIGNANDO VIDEO REMOTO");
    if (!stream) {
        console.error("❌ Stream vacío");
        return;
    }

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    
    console.log("🎤 Tracks de audio en el stream:", audioTracks.length);
    console.log("📹 Tracks de video en el stream:", videoTracks.length);
    
    // 🔥 FORZAR HABILITACIÓN DE TODOS LOS TRACKS
    audioTracks.forEach(track => {
        track.enabled = true;
        console.log("✅ Track de audio habilitado:", track.label);
    });
    
    videoTracks.forEach(track => {
        track.enabled = true;
        console.log("✅ Track de video habilitado:", track.label);
    });

    // 🔥 ASIGNAR AL VIDEO REMOTO (sin tocar el local)
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = 1.0;

    // 🔥 REDUCIR OPACIDAD DEL VIDEO LOCAL PARA VER EL REMOTO
    video.style.opacity = "0.3";
    video.style.zIndex = "1";
    videoRemoto.style.zIndex = "2";
    
    // Marcar que hay video remoto activo
    videoRemotoActivo = true;

    // Asignar al audio separado
    audioRemoto.srcObject = stream;
    audioRemoto.muted = false;
    audioRemoto.volume = 1.0;

    // 🔥 REPRODUCIR CON MÚLTIPLES INTENTOS
    let intentos = 0;
    const maxIntentos = 5;
    
    function intentarReproducir() {
        intentos++;
        console.log(`🔄 Intento de reproducción ${intentos}/${maxIntentos}`);
        
        const promesas = [
            videoRemoto.play().catch(e => {
                console.warn(`⚠️ Error video remoto (${intentos}):`, e.message);
                return null;
            }),
            audioRemoto.play().catch(e => {
                console.warn(`⚠️ Error audio remoto (${intentos}):`, e.message);
                return null;
            })
        ];
        
        Promise.all(promesas).then(resultados => {
            const videoOk = resultados[0] !== null;
            const audioOk = resultados[1] !== null;
            
            if (videoOk && audioOk) {
                console.log("🔊 Audio y video remoto reproduciéndose");
                actualizarEstado("🟢 Conectado - Video en vivo", "conectado");
            } else if (intentos < maxIntentos) {
                setTimeout(intentarReproducir, 1000);
            } else {
                console.warn("⚠️ No se pudo reproducir automáticamente, esperando clic");
                document.addEventListener('click', function clickHandler() {
                    audioRemoto.play().catch(() => {});
                    videoRemoto.play().catch(() => {});
                    document.removeEventListener('click', clickHandler);
                    console.log("✅ Audio activado por clic");
                }, { once: true });
                console.log("💡 Haz clic en la página para activar el audio");
            }
        });
    }

    setTimeout(intentarReproducir, 500);

    console.log("✅ Video y audio remoto asignados correctamente");
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    video.style.opacity = "1";
    video.style.zIndex = "1";
    videoRemotoActivo = false;
    
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
// 🎤 PROBAR AUDIO LOCAL
// ============================================
function probarAudioLocal(stream) {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
// 🔗 CREAR PEER CONNECTION CON TURN MEJORADO
// ============================================
async function crearPeerConnection(targetId) {
    if (peers[targetId]) {
        const pc = peers[targetId];
        if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
            console.log(`⚠️ Ya existe conexión activa con ${targetId}`);
            return pc;
        } else {
            console.log(`🧹 Limpiando conexión muerta con ${targetId}`);
            pc.close();
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
            ofertasEnviadas.delete(targetId);
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

    if (turnServers.length === 0) {
        await obtenerTurnServers();
    }

    const pc = new RTCPeerConnection({
        iceServers: turnServers.length > 0 ? turnServers : [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" }
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        iceTransportPolicy: "all"
    });

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

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`🧊 ICE candidate generado para ${targetId}`);
            
            if (pc.remoteDescription) {
                socket.emit("ice-candidate", {
                    target: targetId,
                    candidate: event.candidate
                });
                console.log(`📤 ICE candidate enviado a ${targetId}`);
            } else {
                if (!iceCandidatesQueue[targetId]) {
                    iceCandidatesQueue[targetId] = [];
                }
                iceCandidatesQueue[targetId].push(event.candidate);
                console.log(`📦 ICE candidate guardado en cola (${iceCandidatesQueue[targetId].length} pendientes)`);
            }
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado con ${targetId}:`, pc.connectionState);
        if (pc.connectionState === "connected") {
            console.log("✅ CONEXIÓN WEBRTC ESTABLECIDA!");
            actualizarEstado("🟢 Conectado - WebRTC activo", "conectado");
            webRTCIniciado = true;
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
            ofertasEnviadas.delete(targetId);
            intentosReconexion[targetId] = 0;
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            console.log(`❌ Conexión perdida con ${targetId}`);
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
            ofertasEnviadas.delete(targetId);
            webRTCIniciado = false;
            ocultarVideoRemoto();
            
            if (!intentosReconexion[targetId]) {
                intentosReconexion[targetId] = 0;
            }
            intentosReconexion[targetId]++;
            
            if (intentosReconexion[targetId] <= MAX_INTENTOS_POR_PEER) {
                console.log(`🔄 Reintentando conexión con ${targetId} (${intentosReconexion[targetId]}/${MAX_INTENTOS_POR_PEER})`);
                setTimeout(() => {
                    if (!peers[targetId] && !conexionesEnProceso.has(targetId)) {
                        iniciarOferta(targetId);
                    }
                }, 5000 * intentosReconexion[targetId]);
            } else {
                console.log(`🚫 Máximos intentos alcanzados para ${targetId}, esperando...`);
                setTimeout(() => {
                    intentosReconexion[targetId] = 0;
                    console.log(`🔄 Reseteados intentos para ${targetId}`);
                }, 60000);
            }
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`🧊 ICE estado con ${targetId}:`, pc.iceConnectionState);
        if (pc.iceConnectionState === "failed") {
            console.warn("⚠️ ICE failed, reiniciando conexión...");
            pc.restartIce();
        }
    };

    const timeoutId = setTimeout(() => {
        if (pc.connectionState !== "connected" && pc.connectionState !== "connecting") {
            console.log(`⏰ Timeout conectando con ${targetId}`);
            pc.close();
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
            ofertasEnviadas.delete(targetId);
        }
    }, 15000);

    pc._timeoutId = timeoutId;

    peers[targetId] = pc;
    return pc;
}

// ============================================
// 📤 ENVIAR ICE CANDIDATES PENDIENTES
// ============================================
function enviarIceCandidatesPendientes(targetId) {
    const pc = peers[targetId];
    if (!pc || !pc.remoteDescription) {
        console.log(`⏳ No se pueden enviar ICE candidates: remoteDescription no disponible para ${targetId}`);
        return;
    }
    
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
// 📨 WEBRTC - OFERTA Y RESPUESTA
// ============================================
async function iniciarOferta(targetId) {
    if (ofertasEnviadas.has(targetId)) {
        console.log(`⚠️ Oferta a ${targetId} ya fue enviada, omitiendo...`);
        return;
    }
    
    if (peers[targetId]) {
        const pc = peers[targetId];
        if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
            console.log(`ℹ️ Ya conectado con ${targetId}`);
            return;
        } else {
            if (pc._timeoutId) {
                clearTimeout(pc._timeoutId);
            }
            pc.close();
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
            ofertasEnviadas.delete(targetId);
        }
    }
    
    const pc = await crearPeerConnection(targetId);
    if (!pc) return;

    try {
        console.log(`📤 Creando oferta para ${targetId}...`);
        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);

        ofertasEnviadas.add(targetId);

        socket.emit("offer", {
            target: targetId,
            offer: pc.localDescription
        });
        console.log(`✅ Oferta enviada a: ${targetId}`);
        
        setTimeout(() => {
            enviarIceCandidatesPendientes(targetId);
        }, 1000);
        
    } catch (error) {
        console.error(`❌ Error al crear oferta para ${targetId}:`, error);
        delete peers[targetId];
        conexionesEnProceso.delete(targetId);
        delete iceCandidatesQueue[targetId];
        ofertasEnviadas.delete(targetId);
    }
}

async function manejarOferta(data) {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);

    if (ofertasRecibidas.has(from)) {
        console.log(`⚠️ Oferta duplicada de ${from}, ignorando...`);
        return;
    }
    ofertasRecibidas.add(from);

    if (peers[from]) {
        const pc = peers[from];
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            if (pc._timeoutId) {
                clearTimeout(pc._timeoutId);
            }
            pc.close();
            delete peers[from];
            conexionesEnProceso.delete(from);
            delete iceCandidatesQueue[from];
            ofertasEnviadas.delete(from);
        } else {
            console.log(`⚠️ Conexión con ${from} ya existe`);
            return;
        }
    }

    if (conexionesEnProceso.has(from)) {
        console.log(`⚠️ Conexión con ${from} está en proceso`);
        return;
    }

    const pc = await crearPeerConnection(from);
    if (!pc) return;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida (oferta) de ${from}`);
        
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
        console.log(`✅ Respuesta enviada a: ${from}`);
        
        setTimeout(() => {
            enviarIceCandidatesPendientes(from);
        }, 1000);
        
    } catch (error) {
        console.error(`❌ Error al manejar oferta de ${from}:`, error);
        delete peers[from];
        conexionesEnProceso.delete(from);
        delete iceCandidatesQueue[from];
        ofertasEnviadas.delete(from);
        ofertasRecibidas.delete(from);
    }
}

async function manejarRespuesta(data) {
    const { from, answer } = data;
    console.log(`📩 RESPUESTA RECIBIDA DE: ${from}`);
    const pc = peers[from];

    if (!pc) {
        console.warn(`⚠️ No hay conexión para respuesta de: ${from}`);
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida (respuesta) de ${from}`);
        conexionesEnProceso.delete(from);
        
        enviarIceCandidatesPendientes(from);
        
    } catch (error) {
        console.error(`❌ Error al procesar respuesta de ${from}:`, error);
        delete peers[from];
        conexionesEnProceso.delete(from);
        delete iceCandidatesQueue[from];
        ofertasEnviadas.delete(from);
        ofertasRecibidas.delete(from);
    }
}

async function manejarIceCandidate(data) {
    const { from, candidate } = data;
    console.log(`🧊 ICE candidate RECIBIDO de: ${from}`);
    const pc = peers[from];

    if (!pc) {
        console.warn(`⚠️ No hay conexión para ICE candidate de: ${from}, guardando en cola`);
        if (!iceCandidatesQueue[from]) {
            iceCandidatesQueue[from] = [];
        }
        iceCandidatesQueue[from].push(candidate);
        return;
    }

    try {
        if (!pc.remoteDescription) {
            console.log(`⏳ remoteDescription no disponible para ${from}, guardando en cola`);
            if (!iceCandidatesQueue[from]) {
                iceCandidatesQueue[from] = [];
            }
            iceCandidatesQueue[from].push(candidate);
            return;
        }
        
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`✅ ICE Candidate agregado de: ${from}`);
    } catch (error) {
        console.warn(`⚠️ Error al agregar ICE candidate de ${from}:`, error.message);
        if (!iceCandidatesQueue[from]) {
            iceCandidatesQueue[from] = [];
        }
        iceCandidatesQueue[from].push(candidate);
    }
}

// ============================================
// 🔄 CONECTAR CON TODOS LOS CLIENTES
// ============================================
function conectarConTodos(clientes) {
    if (reconexionActiva) {
        console.log("⏳ Reconexión ya en progreso, omitiendo...");
        return;
    }
    
    const ahora = Date.now();
    if (ahora - ultimoIntentoReconexion < INTERVALO_MINIMO_RECONEXION) {
        console.log(`⏳ Esperando ${(INTERVALO_MINIMO_RECONEXION - (ahora - ultimoIntentoReconexion))/1000}s antes de reconectar...`);
        return;
    }
    ultimoIntentoReconexion = ahora;
    
    reconexionActiva = true;
    
    try {
        console.log("🔄 CONECTANDO CON TODOS...");
        console.log("📋 Clientes totales:", clientes);
        console.log("📋 Mi ID:", socket.id);

        const otros = clientes.filter(id => id !== socket.id);
        console.log("🎯 Otros clientes:", otros);

        if (otros.length === 0) {
            console.log("⏳ No hay otros clientes. Esperando...");
            actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");
            reconexionActiva = false;
            return;
        }

        Object.keys(peers).forEach(id => {
            if (!clientes.includes(id)) {
                console.log(`🧹 Limpiando conexión a cliente desaparecido: ${id}`);
                if (peers[id]) {
                    if (peers[id]._timeoutId) {
                        clearTimeout(peers[id]._timeoutId);
                    }
                    peers[id].close();
                    delete peers[id];
                }
                conexionesEnProceso.delete(id);
                delete iceCandidatesQueue[id];
                ofertasEnviadas.delete(id);
                ofertasRecibidas.delete(id);
                delete intentosReconexion[id];
            }
        });

        otros.forEach(targetId => {
            if (peers[targetId]) {
                const pc = peers[targetId];
                if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
                    console.log(`ℹ️ Ya conectado con ${targetId}`);
                    return;
                } else {
                    if (pc._timeoutId) {
                        clearTimeout(pc._timeoutId);
                    }
                    pc.close();
                    delete peers[targetId];
                    conexionesEnProceso.delete(targetId);
                    delete iceCandidatesQueue[targetId];
                    ofertasEnviadas.delete(targetId);
                    ofertasRecibidas.delete(targetId);
                }
            }
            
            if (!intentosReconexion[targetId]) {
                intentosReconexion[targetId] = 0;
            }
            
            if (intentosReconexion[targetId] >= MAX_INTENTOS_POR_PEER) {
                console.log(`🚫 Máximos intentos para ${targetId}, omitiendo...`);
                return;
            }
            
            if (!conexionesEnProceso.has(targetId)) {
                console.log(`🔗 Iniciando conexión con ${targetId}`);
                setTimeout(() => iniciarOferta(targetId), 2000);
            }
        });
        
    } catch (error) {
        console.error("❌ Error en conectarConTodos:", error);
    } finally {
        setTimeout(() => {
            reconexionActiva = false;
        }, 3000);
    }
}

// ============================================
// 📡 MANEJADORES DE SOCKET.IO
// ============================================
socket.on("offer", manejarOferta);
socket.on("answer", manejarRespuesta);
socket.on("ice-candidate", manejarIceCandidate);

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    actualizarEstado("🟢 Conectado - Esperando otro equipo", "conectado");
    
    await obtenerTurnServers();
    
    Object.keys(peers).forEach(key => {
        if (peers[key]) {
            if (peers[key]._timeoutId) {
                clearTimeout(peers[key]._timeoutId);
            }
            peers[key].close();
            delete peers[key];
        }
    });
    conexionesEnProceso.clear();
    Object.keys(iceCandidatesQueue).forEach(key => delete iceCandidatesQueue[key]);
    ofertasEnviadas.clear();
    ofertasRecibidas.clear();
    intentosReconexion = {};
    reconexionActiva = false;
    
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 3000);
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    actualizarEstado("🔴 Desconectado", "desconectado");
    ocultarVideoRemoto();
    webRTCIniciado = false;
    Object.keys(peers).forEach(key => {
        if (peers[key]) {
            if (peers[key]._timeoutId) {
                clearTimeout(peers[key]._timeoutId);
            }
            peers[key].close();
            delete peers[key];
        }
    });
    conexionesEnProceso.clear();
    Object.keys(iceCandidatesQueue).forEach(key => delete iceCandidatesQueue[key]);
    ofertasEnviadas.clear();
    ofertasRecibidas.clear();
    reconexionActiva = false;
});

socket.on("nuevo-cliente", (data) => {
    console.log("🆕 Nuevo cliente conectado:", data.id);
    if (data.id !== socket.id) {
        intentosReconexion[data.id] = 0;
        setTimeout(() => {
            socket.emit("clientes-conectados", conectarConTodos);
        }, 3000);
    }
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    if (peers[data.id]) {
        if (peers[data.id]._timeoutId) {
            clearTimeout(peers[data.id]._timeoutId);
        }
        peers[data.id].close();
        delete peers[data.id];
    }
    conexionesEnProceso.delete(data.id);
    delete iceCandidatesQueue[data.id];
    ofertasEnviadas.delete(data.id);
    ofertasRecibidas.delete(data.id);
    delete intentosReconexion[data.id];
    ocultarVideoRemoto();
    webRTCIniciado = false;
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 2000);
});

// ============================================
// 🎥 INICIAR CÁMARA
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
        
        // 🔥 ASIGNAR STREAM AL VIDEO LOCAL
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

        await obtenerTurnServers();

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
            
            await obtenerTurnServers();
            
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
// 🔄 FUNCIÓN DE RECONEXIÓN MANUAL
// ============================================
window.forzarReconexion = () => {
    console.log("🔄 Forzando reconexión...");
    ocultarVideoRemoto();
    webRTCIniciado = false;
    reconexionActiva = false;
    conexionesEnProceso.clear();
    Object.keys(iceCandidatesQueue).forEach(key => delete iceCandidatesQueue[key]);
    ofertasEnviadas.clear();
    ofertasRecibidas.clear();
    Object.keys(intentosReconexion).forEach(key => {
        intentosReconexion[key] = 0;
    });
    Object.keys(peers).forEach(key => {
        if (peers[key]) {
            if (peers[key]._timeoutId) {
                clearTimeout(peers[key]._timeoutId);
            }
            peers[key].close();
            delete peers[key];
        }
    });
    ultimoIntentoReconexion = 0;
    setTimeout(() => {
        socket.emit("clientes-conectados", conectarConTodos);
    }, 1000);
};

console.log("💡 Para forzar reconexión: forzarReconexion()");

// ============================================
// 📊 FUNCIÓN DE DIAGNÓSTICO
// ============================================
window.estadoConexiones = () => {
    console.log("📊 ESTADO DE CONEXIONES:");
    console.log("📊 Conexiones activas:", Object.keys(peers).length);
    Object.keys(peers).forEach(id => {
        const pc = peers[id];
        console.log(`  ${id}: ${pc.connectionState} (${pc.iceConnectionState})`);
    });
    console.log("📊 En proceso:", Array.from(conexionesEnProceso));
    console.log("📊 Intentos:", intentosReconexion);
    console.log("📊 Ofertas enviadas:", Array.from(ofertasEnviadas));
    console.log("📊 Ofertas recibidas:", Array.from(ofertasRecibidas));
    console.log("📊 Reconexión activa:", reconexionActiva);
    console.log("📊 Video remoto activo:", videoRemotoActivo);
    return {
        peers: Object.keys(peers).length,
        enProceso: Array.from(conexionesEnProceso),
        intentos: intentosReconexion,
        reconexionActiva: reconexionActiva,
        videoRemotoActivo: videoRemotoActivo
    };
};

console.log("💡 Para ver estado: estadoConexiones()");

// ============================================
// 🔥 FUNCIÓN PARA FORZAR OFERTA MANUAL
// ============================================
window.forzarOferta = (targetId) => {
    if (!targetId) {
        console.log("❌ Especifica el ID del target. Ejemplo: forzarOferta('ID_DEL_CLIENTE')");
        console.log("📋 IDs disponibles:", Object.keys(peers));
        return;
    }
    
    console.log(`🔥 Forzando oferta a: ${targetId}`);
    ofertasEnviadas.delete(targetId);
    ofertasRecibidas.delete(targetId);
    delete intentosReconexion[targetId];
    
    if (peers[targetId]) {
        if (peers[targetId]._timeoutId) {
            clearTimeout(peers[targetId]._timeoutId);
        }
        peers[targetId].close();
        delete peers[targetId];
    }
    conexionesEnProceso.delete(targetId);
    delete iceCandidatesQueue[targetId];
    
    setTimeout(() => {
        iniciarOferta(targetId);
    }, 1000);
};

console.log("💡 Para forzar oferta: forzarOferta('ID_DEL_CLIENTE')");

// ============================================
// 🚀 INICIO
// ============================================
window.addEventListener("load", () => {
    console.log("🚀 Iniciando Ventana Digital...");
    iniciarCamara();
});

window.addEventListener("beforeunload", () => {
    Object.keys(peers).forEach(key => {
        if (peers[key]) {
            if (peers[key]._timeoutId) {
                clearTimeout(peers[key]._timeoutId);
            }
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
    if (audioContext) {
        audioContext.close();
    }
});

// ============================================
// 🏓 PRUEBA DE PING
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
// ⏰ RECONEXIÓN AUTOMÁTICA PERIÓDICA
// ============================================
setInterval(() => {
    if (reconexionActiva) {
        return;
    }
    
    const conexionesActivas = Object.keys(peers).filter(id => {
        const pc = peers[id];
        return pc && (pc.connectionState === "connected" || pc.connectionState === "connecting");
    });
    
    if (conexionesActivas.length === 0 && socket.connected) {
        console.log("🔄 Sin conexiones activas, verificando clientes...");
        socket.emit("clientes-conectados", conectarConTodos);
    }
}, 15000);

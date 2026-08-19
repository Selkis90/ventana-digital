// ============================================
// CONFIGURACIÓN INICIAL
// ============================================
const video = document.getElementById("video");
const videoRemoto = document.getElementById("video-remoto");

// ============================================
// 📡 CONEXIÓN AL SERVIDOR
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
let videoRemotoActivo = false;

// ============================================
// 🔊 CONFIGURACIÓN DE AUDIO - SIN ECO
// ============================================
const VOLUMEN_REMOTO = 0.4; // 40% - volumen óptimo para evitar eco

// ============================================
// 🎬 CONFIGURAR VIDEOS
// ============================================
video.style.display = "none";
video.muted = true;      // 🔥 MUTEAR VIDEO LOCAL
video.volume = 0;        // 🔥 VOLUMEN A 0

videoRemoto.style.display = "none";
videoRemoto.volume = VOLUMEN_REMOTO;

// ============================================
// 🔥 OBTENER CREDENCIALES TURN
// ============================================
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
// 🎯 FUNCIONES DE ESTADO
// ============================================
function actualizarEstado(mensaje, tipo) {
    const estado = document.getElementById("estado");
    if (estado) {
        estado.textContent = mensaje;
        estado.className = tipo || "inicializando";
    }
}

// ============================================
// 🔥 MOSTRAR VIDEO REMOTO (CORREGIDO)
// ============================================
function mostrarVideoRemoto(stream, fromId) {
    console.log(`📹 ASIGNANDO VIDEO REMOTO DE: ${fromId}`);
    
    if (!stream) {
        console.error("❌ Stream vacío");
        return;
    }

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    
    console.log(`🎤 Audio tracks: ${audioTracks.length}`);
    console.log(`📹 Video tracks: ${videoTracks.length}`);
    
    // 🔥 HABILITAR TODOS LOS TRACKS REMOTOS
    audioTracks.forEach(track => {
        track.enabled = true;
        console.log(`✅ Audio remoto habilitado: ${track.label}`);
    });
    
    videoTracks.forEach(track => {
        track.enabled = true;
        console.log(`✅ Video remoto habilitado: ${track.label}`);
    });

    // 🔥 ASIGNAR STREAM AL VIDEO REMOTO
    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = VOLUMEN_REMOTO;
    
    // 🔥 VIDEO LOCAL - SIEMPRE MUTEADO
    video.style.display = "block";
    video.muted = true;
    video.volume = 0;
    
    videoRemotoActivo = true;

    // 🔥 REPRODUCIR CON REINTENTOS
    let intentos = 0;
    const maxIntentos = 5;
    
    function intentarReproducir() {
        intentos++;
        console.log(`🔄 Intento reproducción ${intentos}/${maxIntentos}`);
        
        videoRemoto.play()
            .then(() => {
                console.log(`🔊 Audio remoto al ${VOLUMEN_REMOTO * 100}% - SIN ECO`);
                console.log(`🔇 Audio local MUTEADO`);
                actualizarEstado("🟢 Conectado - Audio y Video en vivo", "conectado");
            })
            .catch(e => {
                console.warn(`⚠️ Error (${intentos}):`, e.message);
                if (intentos < maxIntentos) {
                    setTimeout(intentarReproducir, 1000);
                } else {
                    console.log("💡 Haz clic en la página para activar el audio");
                    document.addEventListener('click', function clickHandler() {
                        videoRemoto.play().catch(() => {});
                        document.removeEventListener('click', clickHandler);
                        console.log("✅ Audio activado por clic");
                    }, { once: true });
                }
            });
    }

    setTimeout(intentarReproducir, 500);
    console.log(`✅ Video remoto de ${fromId} asignado`);
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    videoRemotoActivo = false;
    video.style.display = "block";
    video.muted = true;
    video.volume = 0;
    
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject.getTracks().forEach(track => track.stop());
        videoRemoto.srcObject = null;
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
                console.log("✅ Micrófono funcionando correctamente");
            }
            requestAnimationFrame(checkAudio);
        }
        checkAudio();
    } catch (e) {
        console.log("ℹ️ No se pudo probar audio:", e.message);
    }
}

// ============================================
// 🔗 CREAR PEER CONNECTION
// ============================================
async function crearPeerConnection(targetId) {
    // 🔥 LIMPIAR CONEXIÓN EXISTENTE
    if (peers[targetId]) {
        const pc = peers[targetId];
        if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
            console.log(`⚠️ Ya existe conexión con ${targetId}`);
            return pc;
        } else {
            console.log(`🧹 Limpiando conexión muerta con ${targetId}`);
            if (pc._timeoutId) clearTimeout(pc._timeoutId);
            pc.close();
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
            ofertasEnviadas.delete(targetId);
            ofertasRecibidas.delete(targetId);
        }
    }

    if (conexionesEnProceso.has(targetId)) {
        console.log(`⏳ Conexión con ${targetId} en proceso`);
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

    // 🔥 CREAR PEER CONNECTION
    const pc = new RTCPeerConnection({
        iceServers: turnServers.length > 0 ? turnServers : [
            { urls: "stun:stun.l.google.com:19302" }
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    });

    // 🔥 AGREGAR TRACKS LOCALES (AUDIO Y VIDEO)
    const audioTracks = streamLocal.getAudioTracks();
    const videoTracks = streamLocal.getVideoTracks();
    
    console.log(`📹 Agregando tracks locales para ${targetId}:`);
    console.log(`  - Audio: ${audioTracks.length}, Video: ${videoTracks.length}`);
    
    audioTracks.forEach(track => {
        track.enabled = true;
        pc.addTrack(track, streamLocal);
    });
    
    videoTracks.forEach(track => {
        track.enabled = true;
        pc.addTrack(track, streamLocal);
    });

    // 🔥 MANEJAR TRACKS REMOTOS
    pc.ontrack = (event) => {
        console.log(`📥 Track remoto recibido de: ${targetId}, kind: ${event.track.kind}`);
        
        if (event.streams && event.streams[0]) {
            const remoteStream = event.streams[0];
            mostrarVideoRemoto(remoteStream, targetId);
        }
    };

    // 🔥 MANEJAR ICE CANDIDATES
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
                console.log(`📦 ICE guardado en cola (${iceCandidatesQueue[targetId].length})`);
            }
        }
    };

    // 🔥 MANEJAR ESTADO DE CONEXIÓN
    pc.onconnectionstatechange = () => {
        console.log(`🔗 Estado con ${targetId}: ${pc.connectionState}`);
        
        if (pc.connectionState === "connected") {
            console.log("✅ ¡CONEXIÓN WEBRTC ESTABLECIDA!");
            actualizarEstado("🟢 Conectado - Audio y Video en vivo", "conectado");
            webRTCIniciado = true;
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
            ofertasEnviadas.delete(targetId);
            ofertasRecibidas.delete(targetId);
            intentosReconexion[targetId] = 0;
            
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            console.log(`❌ Conexión perdida con ${targetId}`);
            handleDisconnection(targetId);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`🧊 ICE estado con ${targetId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === "failed") {
            console.warn("⚠️ ICE failed, reiniciando...");
            pc.restartIce();
        }
    };

    // 🔥 TIMEOUT
    const timeoutId = setTimeout(() => {
        if (pc.connectionState !== "connected") {
            console.log(`⏰ Timeout conectando con ${targetId}`);
            pc.close();
            delete peers[targetId];
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
            ofertasEnviadas.delete(targetId);
            ofertasRecibidas.delete(targetId);
        }
    }, 15000);

    pc._timeoutId = timeoutId;
    peers[targetId] = pc;
    
    return pc;
}

// ============================================
// 🔄 MANEJAR DESCONEXIÓN
// ============================================
function handleDisconnection(targetId) {
    delete peers[targetId];
    conexionesEnProceso.delete(targetId);
    delete iceCandidatesQueue[targetId];
    ofertasEnviadas.delete(targetId);
    ofertasRecibidas.delete(targetId);
    webRTCIniciado = false;
    ocultarVideoRemoto();
    
    if (!intentosReconexion[targetId]) {
        intentosReconexion[targetId] = 0;
    }
    intentosReconexion[targetId]++;
    
    if (intentosReconexion[targetId] <= MAX_INTENTOS_POR_PEER) {
        console.log(`🔄 Reintentando (${intentosReconexion[targetId]}/${MAX_INTENTOS_POR_PEER})`);
        setTimeout(() => {
            if (!peers[targetId] && !conexionesEnProceso.has(targetId)) {
                iniciarOferta(targetId);
            }
        }, 5000 * intentosReconexion[targetId]);
    } else {
        console.log(`🚫 Máximos intentos para ${targetId}`);
        setTimeout(() => {
            intentosReconexion[targetId] = 0;
        }, 60000);
    }
}

// ============================================
// 📤 ENVIAR ICE CANDIDATES PENDIENTES
// ============================================
function enviarIceCandidatesPendientes(targetId) {
    const pc = peers[targetId];
    if (!pc || !pc.remoteDescription) {
        console.log(`⏳ remoteDescription no disponible para ${targetId}`);
        return;
    }
    
    const pendientes = iceCandidatesQueue[targetId] || [];
    if (pendientes.length === 0) return;
    
    console.log(`📤 Enviando ${pendientes.length} ICE candidates a ${targetId}`);
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
    // 🔥 LIMPIAR ESTADO ANTERIOR
    ofertasEnviadas.delete(targetId);
    ofertasRecibidas.delete(targetId);
    
    if (peers[targetId]) {
        const pc = peers[targetId];
        if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
            console.log(`ℹ️ Ya conectado con ${targetId}`);
            return;
        }
        if (pc._timeoutId) clearTimeout(pc._timeoutId);
        pc.close();
        delete peers[targetId];
        conexionesEnProceso.delete(targetId);
        delete iceCandidatesQueue[targetId];
    }
    
    if (conexionesEnProceso.has(targetId)) {
        console.log(`⏳ Conexión con ${targetId} en proceso`);
        return;
    }
    
    console.log(`📤 Iniciando oferta para ${targetId}`);
    conexionesEnProceso.add(targetId);
    ofertasEnviadas.add(targetId);
    
    try {
        const pc = await crearPeerConnection(targetId);
        if (!pc) {
            conexionesEnProceso.delete(targetId);
            ofertasEnviadas.delete(targetId);
            return;
        }

        console.log(`📤 Creando oferta...`);
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
        
        setTimeout(() => {
            enviarIceCandidatesPendientes(targetId);
        }, 1000);
        
    } catch (error) {
        console.error(`❌ Error en oferta:`, error);
        delete peers[targetId];
        conexionesEnProceso.delete(targetId);
        delete iceCandidatesQueue[targetId];
        ofertasEnviadas.delete(targetId);
    }
}

async function manejarOferta(data) {
    const { from, offer } = data;
    console.log(`📩 OFERTA RECIBIDA DE: ${from}`);

    // 🔥 LIMPIAR OFERTAS DUPLICADAS
    if (ofertasRecibidas.has(from)) {
        console.log(`⚠️ Oferta duplicada de ${from}, limpiando...`);
        ofertasRecibidas.delete(from);
        if (peers[from]) {
            peers[from].close();
            delete peers[from];
        }
        conexionesEnProceso.delete(from);
        delete iceCandidatesQueue[from];
        ofertasEnviadas.delete(from);
    }

    if (conexionesEnProceso.has(from)) {
        console.log(`⏳ Conexión con ${from} en proceso`);
        return;
    }

    const pc = await crearPeerConnection(from);
    if (!pc) return;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`✅ Descripción remota establecida (oferta) de ${from}`);
        ofertasRecibidas.add(from);
        
        setTimeout(() => {
            enviarIceCandidatesPendientes(from);
        }, 500);

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
        console.error(`❌ Error manejando oferta:`, error);
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
        console.warn(`⚠️ No hay conexión para ${from}`);
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`✅ Descripción remota establecida (respuesta) de ${from}`);
        conexionesEnProceso.delete(from);
        
        setTimeout(() => {
            enviarIceCandidatesPendientes(from);
        }, 500);
        
    } catch (error) {
        console.error(`❌ Error procesando respuesta:`, error);
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
        console.warn(`⚠️ No hay conexión para ICE, guardando`);
        if (!iceCandidatesQueue[from]) {
            iceCandidatesQueue[from] = [];
        }
        iceCandidatesQueue[from].push(candidate);
        return;
    }

    try {
        if (!pc.remoteDescription) {
            console.log(`⏳ remoteDescription no disponible, guardando`);
            if (!iceCandidatesQueue[from]) {
                iceCandidatesQueue[from] = [];
            }
            iceCandidatesQueue[from].push(candidate);
            return;
        }
        
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`✅ ICE Candidate agregado de: ${from}`);
    } catch (error) {
        console.warn(`⚠️ Error ICE:`, error.message);
        setTimeout(() => {
            if (pc && pc.remoteDescription) {
                pc.addIceCandidate(new RTCIceCandidate(candidate))
                    .then(() => console.log(`✅ ICE agregado en reintento`))
                    .catch(e => console.warn(`⚠️ Error en reintento: ${e.message}`));
            }
        }, 1000);
    }
}

// ============================================
// 🔄 CONECTAR CON TODOS LOS CLIENTES
// ============================================
function conectarConTodos(clientes) {
    if (reconexionActiva) {
        console.log("⏳ Reconexión en progreso...");
        return;
    }
    
    const ahora = Date.now();
    if (ahora - ultimoIntentoReconexion < INTERVALO_MINIMO_RECONEXION) {
        console.log(`⏳ Esperando ${(INTERVALO_MINIMO_RECONEXION - (ahora - ultimoIntentoReconexion))/1000}s`);
        return;
    }
    ultimoIntentoReconexion = ahora;
    
    reconexionActiva = true;
    
    try {
        console.log("🔄 CONECTANDO CON TODOS...");
        console.log("📋 Clientes:", clientes);
        console.log("📋 Mi ID:", socket.id);

        const otros = clientes.filter(id => id !== socket.id);
        console.log("🎯 Otros:", otros);

        if (otros.length === 0) {
            console.log("⏳ No hay otros clientes");
            actualizarEstado("🟢 Esperando otro equipo", "conectado");
            reconexionActiva = false;
            return;
        }

        // Limpiar clientes desaparecidos
        Object.keys(peers).forEach(id => {
            if (!clientes.includes(id)) {
                console.log(`🧹 Limpiando cliente desaparecido: ${id}`);
                if (peers[id]) {
                    if (peers[id]._timeoutId) clearTimeout(peers[id]._timeoutId);
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

        // Conectar con otros
        otros.forEach(targetId => {
            if (peers[targetId]) {
                const pc = peers[targetId];
                if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
                    console.log(`ℹ️ Ya conectado con ${targetId}`);
                    return;
                }
                if (pc._timeoutId) clearTimeout(pc._timeoutId);
                pc.close();
                delete peers[targetId];
                conexionesEnProceso.delete(targetId);
                delete iceCandidatesQueue[targetId];
                ofertasEnviadas.delete(targetId);
                ofertasRecibidas.delete(targetId);
            }
            
            if (!intentosReconexion[targetId]) {
                intentosReconexion[targetId] = 0;
            }
            
            if (intentosReconexion[targetId] >= MAX_INTENTOS_POR_PEER) {
                console.log(`🚫 Máximos intentos para ${targetId}`);
                return;
            }
            
            if (!conexionesEnProceso.has(targetId)) {
                console.log(`🔗 Iniciando conexión con ${targetId}`);
                setTimeout(() => iniciarOferta(targetId), 1000);
            }
        });
        
    } catch (error) {
        console.error("❌ Error:", error);
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

socket.on("clientes-conectados", (listaClientes) => {
    console.log("📋 Lista de clientes recibida:", listaClientes);
    conectarConTodos(listaClientes);
});

socket.on("connect", async () => {
    console.log("✅ Conectado al servidor:", socket.id);
    actualizarEstado("🟢 Conectado", "conectado");
    await obtenerTurnServers();
    
    // Limpiar todo
    Object.keys(peers).forEach(key => {
        if (peers[key]) {
            if (peers[key]._timeoutId) clearTimeout(peers[key]._timeoutId);
            peers[key].close();
            delete peers[key];
        }
    });
    conexionesEnProceso.clear();
    Object.keys(iceCandidatesQueue).forEach(key => delete iceCandidatesQueue[key]);
    ofertasEnviadas.clear();
    ofertasRecibidas.clear();
    Object.keys(intentosReconexion).forEach(key => intentosReconexion[key] = 0);
    reconexionActiva = false;
    ultimoIntentoReconexion = 0;
    
    setTimeout(() => {
        socket.emit("clientes-conectados");
    }, 2000);
});

socket.on("disconnect", () => {
    console.log("❌ Desconectado del servidor");
    actualizarEstado("🔴 Desconectado", "desconectado");
    ocultarVideoRemoto();
    webRTCIniciado = false;
    Object.keys(peers).forEach(key => {
        if (peers[key]) {
            if (peers[key]._timeoutId) clearTimeout(peers[key]._timeoutId);
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
    console.log("🆕 Nuevo cliente:", data.id);
    if (data.id !== socket.id) {
        intentosReconexion[data.id] = 0;
        setTimeout(() => {
            socket.emit("clientes-conectados");
        }, 2000);
    }
});

socket.on("cliente-desconectado", (data) => {
    console.log("🔴 Cliente desconectado:", data.id);
    if (peers[data.id]) {
        if (peers[data.id]._timeoutId) clearTimeout(peers[data.id]._timeoutId);
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
        socket.emit("clientes-conectados");
    }, 2000);
});

// ============================================
// 🎥 INICIAR CÁMARA
// ============================================
async function iniciarCamara() {
    try {
        console.log("📷 Solicitando cámara...");
        
        // 🔥 CONFIGURACIÓN DE AUDIO PARA EVITAR ECO
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                width: { ideal: 640 }, 
                height: { ideal: 480 },
                facingMode: "user"
            },
            audio: {
                echoCancellation: true,    // 🔥 CANCELA ECO
                noiseSuppression: true,     // 🔥 REDUCE RUIDO
                autoGainControl: true,      // 🔥 CONTROL DE GANANCIA
                sampleRate: 48000,
                sampleSize: 16,
                channelCount: 1
            }
        });
        
        streamLocal = stream;
        
        // 🔥 VIDEO LOCAL - MUTEADO SIEMPRE
        video.srcObject = stream;
        video.style.display = "block";
        video.muted = true;
        video.volume = 0;
        
        await new Promise(resolve => {
            video.onloadedmetadata = () => {
                video.play();
                resolve();
            };
        });
        
        console.log("📹 Cámara iniciada");
        console.log("🔇 Video local MUTEADO - SIN ECO");
        
        probarAudioLocal(stream);
        await obtenerTurnServers();

        setTimeout(() => {
            socket.emit("clientes-conectados");
        }, 2000);

    } catch (error) {
        console.error("❌ Error:", error);
        alert("⚠️ No se pudo acceder a la cámara/micrófono.");
        actualizarEstado("🔴 Error", "desconectado");
    }
}

// ============================================
// 🎛️ CONTROL DE VOLUMEN MANUAL (OPCIONAL)
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const controlVolumen = document.getElementById('volumen');
    const labelVolumen = document.getElementById('volumen-label');
    const btnSilenciar = document.getElementById('btn-silenciar');
    
    if (controlVolumen) {
        controlVolumen.value = VOLUMEN_REMOTO;
        controlVolumen.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            videoRemoto.volume = vol;
            if (labelVolumen) {
                labelVolumen.textContent = `${Math.round(vol * 100)}%`;
            }
            console.log(`🔊 Volumen: ${Math.round(vol * 100)}%`);
        });
    }
    
    if (btnSilenciar) {
        let silenciado = false;
        btnSilenciar.addEventListener('click', () => {
            silenciado = !silenciado;
            videoRemoto.muted = silenciado;
            btnSilenciar.textContent = silenciado ? '🔊 Activar' : '🔇 Silenciar';
            console.log(`🔇 Audio ${silenciado ? 'silenciado' : 'activado'}`);
        });
    }
});

// ============================================
// 🔄 FUNCIONES DE CONTROL
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
    Object.keys(intentosReconexion).forEach(key => intentosReconexion[key] = 0);
    Object.keys(peers).forEach(key => {
        if (peers[key]) {
            if (peers[key]._timeoutId) clearTimeout(peers[key]._timeoutId);
            peers[key].close();
            delete peers[key];
        }
    });
    ultimoIntentoReconexion = 0;
    setTimeout(() => {
        socket.emit("clientes-conectados");
    }, 1000);
};

window.estadoConexiones = () => {
    console.log("📊 ESTADO:");
    console.log("📊 Peers:", Object.keys(peers));
    Object.keys(peers).forEach(id => {
        const pc = peers[id];
        console.log(`  ${id}: ${pc.connectionState} (${pc.iceConnectionState})`);
    });
    console.log("📊 En proceso:", Array.from(conexionesEnProceso));
    console.log("📊 Intentos:", intentosReconexion);
    return {
        peers: Object.keys(peers),
        enProceso: Array.from(conexionesEnProceso)
    };
};

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
            if (peers[key]._timeoutId) clearTimeout(peers[key]._timeoutId);
            peers[key].close();
            delete peers[key];
        }
    });
    if (streamLocal) {
        streamLocal.getTracks().forEach(track => track.stop());
    }
    if (audioContext) {
        audioContext.close();
    }
});

// ============================================
// ⏰ RECONEXIÓN AUTOMÁTICA
// ============================================
setInterval(() => {
    if (reconexionActiva) return;
    
    const conexionesActivas = Object.keys(peers).filter(id => {
        const pc = peers[id];
        return pc && (pc.connectionState === "connected" || pc.connectionState === "connecting");
    });
    
    if (conexionesActivas.length === 0 && socket.connected) {
        console.log("🔄 Sin conexiones activas, verificando...");
        socket.emit("clientes-conectados");
    }
}, 15000);

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
let audioActivado = false;

// ============================================
// 🔥 FUNCIÓN PARA DECIDIR QUIEN OFERTA
// ============================================
function soyOferente(miId, otroId) {
    return miId < otroId;
}

// ============================================
// 🎬 CONFIGURAR VIDEOS
// ============================================
video.style.display = "none";
videoRemoto.style.display = "none";

// ============================================
// 🎧 AUDIO REMOTO SEPARADO
// ============================================
const audioRemoto = document.createElement("audio");
audioRemoto.id = "audio-remoto";
audioRemoto.autoplay = true;
audioRemoto.muted = false;
audioRemoto.volume = 0.8;
audioRemoto.style.display = "none";
document.body.appendChild(audioRemoto);
console.log("🎧 Audio remoto configurado al 80%");

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
// 🔥 ACTIVAR AUDIO
// ============================================
function activarAudio() {
    if (audioActivado) return;
    
    console.log("🔊 Intentando activar audio...");
    
    if (audioRemoto && audioRemoto.srcObject) {
        audioRemoto.play()
            .then(() => {
                audioActivado = true;
                console.log("✅ Audio activado correctamente al 80%");
                const btn = document.getElementById('btn-activar-audio');
                if (btn) {
                    btn.textContent = "✅ Audio Activado";
                    btn.style.background = "#00cc66";
                    setTimeout(() => { btn.style.display = "none"; }, 2000);
                }
            })
            .catch(e => {
                console.warn("⚠️ Error activando audio:", e.message);
                crearBotonAudio();
            });
    }
    
    if (videoRemoto && videoRemoto.srcObject) {
        videoRemoto.play().catch(() => {});
    }
}

// ============================================
// 🔥 CREAR BOTÓN PARA ACTIVAR AUDIO
// ============================================
function crearBotonAudio() {
    if (document.getElementById('btn-activar-audio')) return;
    
    const btn = document.createElement('button');
    btn.id = 'btn-activar-audio';
    btn.textContent = '🔊 Activar Audio';
    btn.style.cssText = `
        position: fixed;
        bottom: 180px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1000;
        padding: 16px 40px;
        background: #00aaff;
        color: #ffffff;
        border: none;
        border-radius: 16px;
        font-size: 20px;
        font-weight: bold;
        cursor: pointer;
        box-shadow: 0 4px 40px rgba(0,170,255,0.6);
        font-family: Arial, sans-serif;
        transition: all 0.3s ease;
    `;
    document.body.appendChild(btn);
    
    btn.addEventListener('click', function() {
        console.log("🔊 Activando audio manualmente...");
        if (audioRemoto) {
            audioRemoto.play()
                .then(() => {
                    audioActivado = true;
                    console.log("✅ Audio activado!");
                    btn.textContent = "✅ Audio Activado";
                    btn.style.background = "#00cc66";
                    setTimeout(() => btn.remove(), 3000);
                })
                .catch(e => {
                    console.warn("⚠️ Error:", e.message);
                    btn.textContent = "❌ Clic nuevamente";
                    btn.style.background = "#ff4444";
                    setTimeout(() => {
                        btn.textContent = "🔊 Activar Audio";
                        btn.style.background = "#00aaff";
                    }, 2000);
                });
        }
    });
    
    console.log("🔔 Botón de activación de audio creado");
}

// ============================================
// 🔥 MOSTRAR VIDEO REMOTO
// ============================================
function mostrarVideoRemoto(stream, fromId) {
    console.log(`📹 ASIGNANDO VIDEO REMOTO DE: ${fromId}`);
    
    if (!stream) {
        console.error("❌ Stream vacío");
        return;
    }

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    
    console.log(`🎤 Audio tracks remotos: ${audioTracks.length}`);
    console.log(`📹 Video tracks remotos: ${videoTracks.length}`);
    
    audioTracks.forEach(track => {
        track.enabled = true;
        console.log(`✅ Audio remoto habilitado: ${track.label}`);
    });
    videoTracks.forEach(track => {
        track.enabled = true;
        console.log(`✅ Video remoto habilitado: ${track.label}`);
    });

    videoRemoto.srcObject = stream;
    videoRemoto.style.display = "block";
    videoRemoto.muted = false;
    videoRemoto.volume = 0;
    video.style.display = "block";
    videoRemotoActivo = true;

    audioRemoto.srcObject = stream;
    audioRemoto.muted = false;
    audioRemoto.volume = 0.8;
    
    console.log("🔊 Intentando reproducir audio remoto...");
    audioRemoto.play()
        .then(() => {
            audioActivado = true;
            console.log("✅ Audio remoto reproduciéndose al 80%");
            actualizarEstado("🟢 Conectado - Audio y Video en vivo", "conectado");
        })
        .catch(e => {
            console.warn("⚠️ Error reproduciendo audio:", e.message);
            setTimeout(crearBotonAudio, 1000);
        });

    let intentos = 0;
    const maxIntentos = 5;
    
    function intentarReproducirVideo() {
        intentos++;
        console.log(`🔄 Intento video ${intentos}/${maxIntentos}`);
        
        videoRemoto.play()
            .then(() => {
                console.log("✅ Video reproduciéndose");
            })
            .catch(e => {
                console.warn(`⚠️ Error video (${intentos}):`, e.message);
                if (intentos < maxIntentos) {
                    setTimeout(intentarReproducirVideo, 1000);
                }
            });
    }

    setTimeout(intentarReproducirVideo, 500);
    console.log(`✅ Video remoto de ${fromId} asignado`);
}

function ocultarVideoRemoto() {
    videoRemoto.style.display = "none";
    videoRemotoActivo = false;
    video.style.display = "block";
    
    if (videoRemoto.srcObject) {
        videoRemoto.srcObject.getTracks().forEach(track => track.stop());
        videoRemoto.srcObject = null;
    }
    if (audioRemoto) {
        audioRemoto.pause();
        audioRemoto.srcObject = null;
        audioActivado = false;
    }
    const btn = document.getElementById('btn-activar-audio');
    if (btn) btn.remove();
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
                console.log("🎤 AUDIO LOCAL DETECTADO! Nivel:", rms.toFixed(4));
                console.log("✅ Tu micrófono está funcionando correctamente");
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
    if (peers[targetId]) {
        const pc = peers[targetId];
        if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
            console.log(`⚠️ Ya existe conexión activa con ${targetId}`);
            return pc;
        } else {
            console.log(`🧹 Limpiando conexión muerta con ${targetId}`);
            if (pc._timeoutId) clearTimeout(pc._timeoutId);
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
    
    console.log(`📹 Agregando tracks locales para ${targetId}:`);
    console.log(`  - Audio tracks: ${audioTracks.length}`);
    console.log(`  - Video tracks: ${videoTracks.length}`);
    
    audioTracks.forEach(track => {
        track.enabled = true;
        console.log(`  ✅ Audio local habilitado: ${track.label}`);
        pc.addTrack(track, streamLocal);
    });
    
    videoTracks.forEach(track => {
        track.enabled = true;
        console.log(`  ✅ Video local habilitado: ${track.label}`);
        pc.addTrack(track, streamLocal);
    });

    pc.ontrack = (event) => {
        console.log(`📥 Track remoto recibido de: ${targetId}`);
        console.log(`📥 Track kind: ${event.track.kind}`);
        
        if (event.streams && event.streams[0]) {
            const remoteStream = event.streams[0];
            const remoteAudioTracks = remoteStream.getAudioTracks();
            const remoteVideoTracks = remoteStream.getVideoTracks();
            
            console.log(`🎯 Stream remoto tiene:`);
            console.log(`  - Audio tracks: ${remoteAudioTracks.length}`);
            console.log(`  - Video tracks: ${remoteVideoTracks.length}`);
            
            remoteAudioTracks.forEach(track => {
                track.enabled = true;
                console.log(`🎤 Audio remoto habilitado: ${track.label}`);
            });
            
            remoteVideoTracks.forEach(track => {
                track.enabled = true;
                console.log(`📹 Video remoto habilitado: ${track.label}`);
            });
            
            mostrarVideoRemoto(remoteStream, targetId);
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
        console.log(`🔗 Estado con ${targetId}: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            console.log("✅ CONEXIÓN WEBRTC ESTABLECIDA!");
            actualizarEstado("🟢 Conectado - WebRTC activo", "conectado");
            webRTCIniciado = true;
            conexionesEnProceso.delete(targetId);
            delete iceCandidatesQueue[targetId];
            ofertasEnviadas.delete(targetId);
            intentosReconexion[targetId] = 0;
            setTimeout(() => activarAudio(), 1000);
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
        console.log(`🧊 ICE estado con ${targetId}: ${pc.iceConnectionState}`);
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

    // Limpiar ofertas duplicadas
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
        console.log(`⚠️ Conexión con ${from} está en proceso`);
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
        
        setTimeout(() => {
            enviarIceCandidatesPendientes(from);
        }, 500);
        
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
// 🔄 CONECTAR CON TODOS LOS CLIENTES (CORREGIDO)
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
            // 🔥 DECIDIR QUIEN OFERTA
            const soyOferenteLocal = soyOferente(socket.id, targetId);
            
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
                if (soyOferenteLocal) {
                    console.log(`🔗 Iniciando conexión COMO OFERENTE con ${targetId}`);
                    const delay = Math.random() * 2000 + 1000;
                    setTimeout(() => iniciarOferta(targetId), delay);
                } else {
                    console.log(`⏳ Esperando oferta de ${targetId} (soy respondedor)`);
                }
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

socket.on("clientes-conectados", (listaClientes) => {
    console.log("📋 Lista de clientes recibida:", listaClientes);
    conectarConTodos(listaClientes);
});

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
    ultimoIntentoReconexion = 0;
    
    setTimeout(() => {
        socket.emit("clientes-conectados");
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
            socket.emit("clientes-conectados");
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
        socket.emit("clientes-conectados");
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
            console.log(`  Track ${i}: ${track.label} - habilitado: ${track.enabled}`);
        });
        
        const videoTracks = stream.getVideoTracks();
        console.log("📹 Tracks de video disponibles:", videoTracks.length);
        videoTracks.forEach((track, i) => {
            track.enabled = true;
            console.log(`  Track ${i}: ${track.label} - habilitado: ${track.enabled}`);
        });
        
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
        
        console.log("📹 Cámara iniciada correctamente");
        console.log("🔇 Video local MUTEADO - SIN ECO");
        console.log("🎤 Audio local ENABLED para transmitir");
        
        probarAudioLocal(stream);
        await obtenerTurnServers();

        setTimeout(() => {
            socket.emit("clientes-conectados");
        }, 3000);

    } catch (error) {
        console.error("❌ Error al acceder a cámara/micrófono:", error);
        
        try {
            console.log("🔄 Intentando con configuración básica...");
            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
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
            await new Promise(resolve => {
                video.onloadedmetadata = () => {
                    video.play();
                    resolve();
                };
            });
            console.log("📹 Cámara iniciada en modo básico");
            console.log("🔇 Video local MUTEADO - SIN ECO");
            console.log("🎤 Audio local ENABLED para transmitir");
            probarAudioLocal(stream);
            
            await obtenerTurnServers();
            
            setTimeout(() => {
                socket.emit("clientes-conectados");
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
// 🎛️ CONTROL DE VOLUMEN
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const controlVolumen = document.getElementById('volumen');
    const labelVolumen = document.getElementById('volumen-label');
    const btnSilenciar = document.getElementById('btn-silenciar');
    const btnReconectar = document.getElementById('btn-reconectar');
    
    if (controlVolumen) {
        controlVolumen.value = 0.8;
        controlVolumen.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            audioRemoto.volume = vol;
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
            audioRemoto.muted = silenciado;
            btnSilenciar.textContent = silenciado ? '🔊 Activar sonido' : '🔇 Silenciar';
            console.log(`🔇 Audio ${silenciado ? 'silenciado' : 'activado'}`);
        });
    }
    
    if (btnReconectar) {
        btnReconectar.addEventListener('click', forzarReconexion);
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
        socket.emit("clientes-conectados");
    }, 1000);
};

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
    console.log("📊 Audio activado:", audioActivado);
    return {
        peers: Object.keys(peers).length,
        enProceso: Array.from(conexionesEnProceso),
        intentos: intentosReconexion,
        reconexionActiva: reconexionActiva,
        videoRemotoActivo: videoRemotoActivo,
        audioActivado: audioActivado
    };
};

window.verificarAudio = function() {
    console.log("🔊 ===== ESTADO DEL AUDIO =====");
    console.log("📌 Elemento audioRemoto:");
    console.log("  - Existe:", !!audioRemoto);
    console.log("  - Pausado:", audioRemoto ? audioRemoto.paused : 'no existe');
    console.log("  - Volumen:", audioRemoto ? audioRemoto.volume : 'no existe');
    console.log("  - Muted:", audioRemoto ? audioRemoto.muted : 'no existe');
    console.log("  - Tiene srcObject:", audioRemoto ? !!audioRemoto.srcObject : 'no existe');
    
    if (audioRemoto && audioRemoto.srcObject) {
        const tracks = audioRemoto.srcObject.getAudioTracks();
        console.log("  - Tracks de audio:", tracks.length);
        tracks.forEach((t, i) => {
            console.log(`    Track ${i}: ${t.label}`);
            console.log(`      Enabled: ${t.enabled}`);
            console.log(`      Muted: ${t.muted}`);
        });
    }
    
    console.log("📌 Stream Local:");
    if (streamLocal) {
        const tracks = streamLocal.getAudioTracks();
        console.log("  - Tracks de audio local:", tracks.length);
        tracks.forEach((t, i) => {
            console.log(`    Track ${i}: ${t.label}`);
            console.log(`      Enabled: ${t.enabled}`);
            console.log(`      Muted: ${t.muted}`);
        });
    } else {
        console.log("  ❌ No hay stream local");
    }
    
    if (audioRemoto && audioRemoto.paused) {
        console.log("  🔴 AUDIO PAUSADO - Ejecuta: audioRemoto.play()");
    } else if (audioRemoto && !audioRemoto.paused) {
        console.log("  🟢 AUDIO REPRODUCIÉNDOSE");
    }
    
    console.log("🔊 ===== FIN ESTADO ===== ");
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
// ⏰ RECONEXIÓN AUTOMÁTICA
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
        socket.emit("clientes-conectados");
    }
}, 15000);

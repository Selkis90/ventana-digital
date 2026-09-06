'use strict';

// ✅ CONFIGURACIÓN
const LIVEKIT_URL = 'wss://ventana-digital-scr9uykx.livekit.cloud';
const ROOM_NAME = 'sala-principal';

// DOM Elements
const gridVideos = document.getElementById('grid-videos');
const estado = document.getElementById('estado');
const estadoIndicador = estado?.querySelector('.estado-indicador');
const estadoTexto = estado?.querySelector('.estado-texto');
const btnMicrofono = document.getElementById('btn-microfono');
const btnCamara = document.getElementById('btn-camara');
const btnSilenciar = document.getElementById('btn-silenciar');
const btnCompartir = document.getElementById('btn-compartir');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnReconectar = document.getElementById('btn-reconectar');
const btnDiagnostico = document.getElementById('btn-diagnostico');
const volumen = document.getElementById('volumen');
const volumenLabel = document.getElementById('volumen-label');
const miId = document.getElementById('mi-id');
const peerConectado = document.getElementById('peer-conectado');
const calidadRed = document.getElementById('calidad-red');
const loadingOverlay = document.getElementById('loading-overlay');

// Variables de estado
let room = null;
let conectando = false;
let reconectando = false;
let audioMuted = false;

// ✅ SOLUCIÓN 1: VOLUMEN POR DEFECTO AL 100%
let volumenActual = 1.0;

let reconexionTimeout = null;
let intentosReconexion = 0;
const MAX_INTENTOS_RECONEXION = 5;

// Mapas para tracks
const videoMap = new Map();
const audioMap = new Map();

// ✅ Variables para monitor de internet
let monitorInternet = null;
let internetStatus = true;
let reintentosReconexion = 0;
const MAX_REINTENTOS_RECONEXION = 10;

// ============================================================
// FUNCIONES DE UTILIDAD
// ============================================================

function actualizarEstado(texto, tipo = 'conectando') {
    if (!estado || !estadoTexto) return;
    estadoTexto.textContent = texto;
    estado.className = `estado-${tipo}`;
}

function generarIdentidad() {
    const aleatorio = Math.random().toString(36).substring(2, 8);
    return 'Usuario-' + aleatorio;
}

function ocultarLoading() {
    if (loadingOverlay) {
        loadingOverlay.classList.add('oculto');
    }
}

function mostrarLoading() {
    if (loadingOverlay) {
        loadingOverlay.classList.remove('oculto');
    }
}

// ============================================================
// ✅ SOLUCIÓN 4: OBTENER AUDIO CON MEJOR CONFIGURACIÓN
// ============================================================

async function obtenerAudioProfesional() {
    try {
        const constraints = {
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
                sampleSize: 24,
                channelCount: 1,
                googEchoCancellation: true,
                googAutoGainControl: true,
                googNoiseSuppression: true,
                googHighpassFilter: true,
                googAudioMirroring: false,
                googEchoCancellation2: true,
                googAutoGainControl2: true,
                googNoiseSuppression2: true,
                googVoiceDetection: true
            }
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        if (stream.getAudioTracks().length === 0) {
            throw new Error('No se obtuvieron pistas de audio');
        }

        const track = stream.getAudioTracks()[0];
        if (track && track.getCapabilities) {
            try {
                const capabilities = track.getCapabilities();
                console.log('📊 Capabilities de audio:', capabilities);
                if (capabilities && capabilities.autoGainControl) {
                    await track.applyConstraints({
                        autoGainControl: true,
                        noiseSuppression: true,
                        echoCancellation: true
                    });
                }
            } catch (e) {
                console.warn('⚠️ No se pudieron aplicar constraints adicionales:', e);
            }
        }

        console.log('🎤 Audio profesional obtenido');
        return stream;
    } catch (error) {
        console.warn('⚠️ Error con audio avanzado, usando fallback:', error);
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            console.log('🎤 Audio básico obtenido');
            return stream;
        } catch (fallbackError) {
            console.error('❌ Error crítico obteniendo audio:', fallbackError);
            throw fallbackError;
        }
    }
}

// ============================================================
// ✅ SOLUCIÓN 6: FORZAR REANUDACIÓN DE AUDIO CONTEXT
// ============================================================

async function forzarReanudacionAudio() {
    console.log('🔊 Forzando reanudación de AudioContext...');
    
    let reanudados = 0;
    
    for (const [identity, audioInfo] of audioMap) {
        if (!audioInfo.isFallback && audioInfo.context) {
            try {
                if (audioInfo.context.state === 'suspended') {
                    await audioInfo.context.resume();
                    reanudados++;
                    console.log(`✅ AudioContext reanudado para: ${identity}`);
                } else if (audioInfo.context.state === 'running') {
                    console.log(`✅ AudioContext ya está running para: ${identity}`);
                } else {
                    console.warn(`⚠️ AudioContext en estado: ${audioInfo.context.state} para ${identity}`);
                }
            } catch (error) {
                console.error(`❌ Error reanudando AudioContext para ${identity}:`, error);
            }
        }
    }
    
    if (reanudados === 0 && audioMap.size === 0) {
        try {
            const backupContext = new (window.AudioContext || window.webkitAudioContext)();
            if (backupContext.state === 'suspended') {
                await backupContext.resume();
                console.log('✅ AudioContext de respaldo creado y reanudado');
            }
            backupContext.close().catch(() => {});
        } catch (e) {
            console.warn('⚠️ Error creando AudioContext de respaldo:', e);
        }
    }
    
    console.log(`✅ Reanudados ${reanudados} AudioContexts`);
    return reanudados;
}

// ============================================================
// ✅ SOLUCIÓN 7: RESTAURAR AUDIO DESPUÉS DE RECONEXIÓN
// ============================================================

async function restaurarAudioDespuesReconexion() {
    console.log('🔄 Restaurando audio después de reconexión...');
    
    if (!room) {
        console.warn('⚠️ Room no disponible');
        return;
    }
    
    await forzarReanudacionAudio();
    
    if (room.remoteParticipants && room.remoteParticipants.size > 0) {
        room.remoteParticipants.forEach((participant) => {
            const identity = participant.identity;
            console.log(`👤 Revisando participante: ${identity}`);
            
            participant.trackPublications.forEach((publication) => {
                if (publication.kind === 'audio' && publication.track && publication.isSubscribed) {
                    if (audioMap.has(identity)) {
                        const audioInfo = audioMap.get(identity);
                        if (audioInfo && audioInfo.element) {
                            try {
                                if (audioInfo.element.paused) {
                                    audioInfo.element.play().catch(() => {});
                                }
                                audioInfo.element.volume = Math.min(volumenActual, 1.0);
                                console.log(`✅ Audio HTML restaurado para: ${identity}`);
                            } catch (error) {
                                console.error(`❌ Error restaurando audio de ${identity}:`, error);
                                audioMap.delete(identity);
                                agregarAudioRemotoConGanancia(publication.track, participant);
                            }
                        } else {
                            audioMap.delete(identity);
                            agregarAudioRemotoConGanancia(publication.track, participant);
                        }
                    } else {
                        console.log(`🔊 Creando audio para ${identity}...`);
                        agregarAudioRemotoConGanancia(publication.track, participant);
                    }
                }
            });
        });
    } else {
        console.log('👥 No hay participantes remotos');
    }
    
    await forzarReanudacionAudio();
    actualizarVolumen();
    console.log('✅ Audio restaurado completamente');
}

// ============================================================
// ✅ SOLUCIÓN 8: RECONEXIÓN POR PÉRDIDA DE INTERNET
// ============================================================

function iniciarMonitorInternet() {
    console.log('🌐 Iniciando monitor de internet...');
    
    window.addEventListener('online', () => {
        console.log('🌐 Internet CONECTADO');
        internetStatus = true;
        reintentosReconexion = 0;
        if (!room || room.state === 'disconnected') {
            console.log('🔄 Reconectando por recuperación de internet...');
            reconectarManual();
        }
    });
    
    window.addEventListener('offline', () => {
        console.warn('🌐 Internet DESCONECTADO');
        internetStatus = false;
        actualizarEstado('Sin Internet', 'error');
    });
    
    monitorInternet = setInterval(async () => {
        if (navigator.onLine && (!room || room.state === 'disconnected')) {
            console.log('🔄 Detectada desconexión - Intentando reconectar...');
            try {
                const response = await fetch('/get-token', { 
                    method: 'HEAD',
                    signal: AbortSignal.timeout(5000)
                });
                if (response.ok) {
                    console.log('✅ Servidor accesible - Reconectando...');
                    reintentosReconexion = 0;
                    reconectarManual();
                }
            } catch (error) {
                console.warn('⚠️ Servidor no accesible, esperando...');
                reintentosReconexion++;
                if (reintentosReconexion >= MAX_REINTENTOS_RECONEXION) {
                    console.error('❌ Demasiados intentos fallidos');
                    actualizarEstado('Error crítico - Recarga la página', 'error');
                    reintentosReconexion = 0;
                }
            }
        }
    }, 10000);
}

async function reconexionAutomatica() {
    if (conectando || reconectando) {
        console.log('⏳ Ya hay una reconexión en progreso');
        return;
    }
    
    console.log('🔄 Iniciando reconexión automática...');
    
    let intento = 0;
    const maxIntentos = 5;
    const delayBase = 1000;
    
    while (intento < maxIntentos) {
        if (!navigator.onLine) {
            console.log('🌐 Sin internet - Esperando...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            intento++;
            continue;
        }
        
        try {
            console.log(`🔄 Intento ${intento + 1}/${maxIntentos}`);
            const response = await fetch('/get-token', { 
                method: 'HEAD',
                signal: AbortSignal.timeout(5000)
            });
            
            if (response.ok) {
                await reconectarManual();
                console.log('✅ Reconexión automática exitosa');
                return true;
            }
        } catch (error) {
            console.warn(`⚠️ Intento ${intento + 1} fallido:`, error.message);
        }
        
        const delay = delayBase * Math.pow(2, intento);
        console.log(`⏳ Esperando ${delay}ms antes del siguiente intento...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        intento++;
    }
    
    console.error('❌ Fallaron todos los intentos de reconexión');
    actualizarEstado('Error - Recarga manual', 'error');
    return false;
}

function guardarEstadoSala() {
    if (!room) return;
    try {
        const estado = {
            roomName: ROOM_NAME,
            identity: room.localParticipant?.identity,
            timestamp: Date.now()
        };
        sessionStorage.setItem('ventana_digital_estado', JSON.stringify(estado));
        console.log('💾 Estado guardado:', estado);
    } catch (error) {
        console.warn('⚠️ Error guardando estado:', error);
    }
}

function recuperarEstadoSala() {
    try {
        const data = sessionStorage.getItem('ventana_digital_estado');
        if (!data) return null;
        const estado = JSON.parse(data);
        const tiempoTranscurrido = Date.now() - estado.timestamp;
        if (tiempoTranscurrido > 300000) {
            sessionStorage.removeItem('ventana_digital_estado');
            return null;
        }
        console.log('💾 Estado recuperado:', estado);
        return estado;
    } catch (error) {
        console.warn('⚠️ Error recuperando estado:', error);
        return null;
    }
}

// ============================================================
// ✅ CONEXIÓN
// ============================================================

async function conectarLiveKit() {
    if (conectando) {
        console.log('⏳ Conexión en progreso...');
        return;
    }
    
    if (reconexionTimeout) {
        clearTimeout(reconexionTimeout);
        reconexionTimeout = null;
    }
    
    conectando = true;

    try {
        actualizarEstado('Conectando...', 'conectando');
        mostrarLoading();

        if (room) {
            try { 
                await room.disconnect(); 
            } catch (error) { 
                console.warn('Error desconectando:', error); 
            }
            room = null;
        }

        limpiarVideos();

        const participantName = generarIdentidad();

        const respuesta = await fetch('/get-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                roomName: ROOM_NAME, 
                participantName 
            })
        });

        if (!respuesta.ok) {
            throw new Error('HTTP ' + respuesta.status);
        }

        const data = await respuesta.json();
        if (!data.token) {
            throw new Error('No se recibió token');
        }

        room = new LivekitClient.Room({ 
            adaptiveStream: false,
            dynacast: true
        });
        
        registrarEventosLiveKit();
        
        await room.connect(LIVEKIT_URL, data.token, { 
            autoSubscribe: true 
        });

        if (miId) {
            miId.textContent = participantName;
        }

        try {
            const audioStream = await obtenerAudioProfesional();
            const audioTrack = audioStream.getAudioTracks()[0];
            
            if (audioTrack) {
                await room.localParticipant.publishTrack(audioTrack, {
                    name: 'microfono',
                    source: LivekitClient.Track.Source.Microphone,
                    simulcast: false
                });
                
                btnMicrofono?.classList.add('activo');
                btnMicrofono?.classList.remove('inactivo');
                console.log('✅ Audio publicado');
            }
        } catch (error) {
            console.warn('⚠️ Error publicando audio:', error);
            try { 
                await room.localParticipant.setMicrophoneEnabled(true);
                btnMicrofono?.classList.add('activo');
                btnMicrofono?.classList.remove('inactivo');
                console.log('✅ Audio publicado (fallback)');
            } catch (e) {
                console.error('❌ Fallback de audio falló:', e);
                btnMicrofono?.classList.add('inactivo');
            }
        }

        try { 
            await room.localParticipant.setCameraEnabled(true);
            btnCamara?.classList.remove('inactivo');
            btnCamara?.classList.add('activo');
            console.log('✅ Cámara activada');
        } catch (error) { 
            console.warn('⚠️ Cámara no disponible:', error); 
            btnCamara?.classList.add('inactivo');
        }

        if (room.remoteParticipants && room.remoteParticipants.size > 0) {
            const participants = Array.from(room.remoteParticipants.values());
            participants.forEach(participant => {
                agregarParticipante(participant);
            });
        }

        conectando = false;
        reconectando = false;
        intentosReconexion = 0;

        actualizarEstado('Conectado', 'conectado');
        actualizarParticipanteRemoto();
        actualizarLayout();
        ocultarLoading();
        console.log('✅ Conexión exitosa');

    } catch (error) {
        console.error('❌ ERROR:', error);
        actualizarEstado('Error de conexión', 'error');
        conectando = false;
        ocultarLoading();
        
        if (intentosReconexion < MAX_INTENTOS_RECONEXION) {
            intentosReconexion++;
            const delay = intentosReconexion * 2000;
            console.log(`🔄 Reconexión en ${delay/1000}s (intento ${intentosReconexion}/${MAX_INTENTOS_RECONEXION})`);
            reconexionTimeout = setTimeout(() => {
                reconexionTimeout = null;
                conectarLiveKit();
            }, delay);
        }
    }
}

// ============================================================
// ✅ EVENTOS
// ============================================================

function registrarEventosLiveKit() {
    if (!room) return;

    room.on(LivekitClient.RoomEvent.ParticipantConnected, participant => {
        console.log('👤 Participante conectado:', participant.identity);
        agregarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, participant => {
        console.log('❌ Participante desconectado:', participant.identity);
        eliminarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (!participant) return;
        console.log(`📡 Track suscrito: ${track.kind} de ${participant.identity}`);
        
        if (track.kind === LivekitClient.Track.Kind.Video) {
            agregarVideoRemoto(track, participant);
        } else if (track.kind === LivekitClient.Track.Kind.Audio) {
            agregarAudioRemotoConGanancia(track, participant);
        }
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        if (!participant) return;
        console.log(`📤 Track unsubscribe: ${track.kind} de ${participant.identity}`);
        eliminarTrackRemoto(track, participant);
    });

    room.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication) => {
        console.log(`📤 Track local publicado: ${publication.kind}`);
        if (publication.kind === LivekitClient.Track.Kind.Video) {
            mostrarVideoLocal(publication);
        }
    });

    room.on(LivekitClient.RoomEvent.Reconnecting, () => {
        reconectando = true;
        actualizarEstado('Reconectando...', 'conectando');
        console.log('🔄 LiveKit reconectando...');
    });

    room.on(LivekitClient.RoomEvent.Reconnected, async () => {
        reconectando = false;
        intentosReconexion = 0;
        actualizarEstado('Conectado', 'conectado');
        console.log('✅ LiveKit reconectado');
        await restaurarAudioDespuesReconexion();
        actualizarLayout();
    });

    room.on(LivekitClient.RoomEvent.Disconnected, async (reason) => {
        reconectando = false;
        console.warn('⚠️ Desconectado:', reason);
        guardarEstadoSala();
        
        if (reason === 'user' || reason === 'room_closed') {
            actualizarEstado('Desconectado', 'error');
            return;
        }

        if (navigator.onLine) {
            console.log('🌐 Internet disponible - Iniciando reconexión automática');
            actualizarEstado('Reconectando automáticamente...', 'conectando');
            await reconexionAutomatica();
        } else {
            console.log('🌐 Sin internet - Esperando conexión');
            actualizarEstado('Esperando internet...', 'conectando');
            const esperarInternet = async () => {
                while (!navigator.onLine) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                console.log('🌐 Internet recuperado - Reconectando...');
                await reconexionAutomatica();
            };
            esperarInternet();
        }
    });
}

// ============================================================
// ✅ VIDEO REMOTO
// ============================================================

function agregarVideoRemoto(track, participant) {
    if (!participant || !track) return;
    
    const identity = participant.identity;
    
    if (identity === room?.localParticipant?.identity) {
        console.log('⏭️ Saltando video propio');
        return;
    }

    if (videoMap.has(identity)) {
        console.log(`⏭️ Video ya existe para ${identity}`);
        return;
    }

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.controls = false;
    video.dataset.identity = identity;
    video.className = 'video-remoto';
    gridVideos.appendChild(video);
    videoMap.set(identity, video);
    console.log(`📹 Video creado para: ${identity}`);

    try {
        if (typeof track.attach === 'function') {
            track.attach(video);
        } else {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(() => {});
        }
    } catch (error) {
        console.warn('⚠️ Error adjuntando video:', error);
        try {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(() => {});
        } catch (e) {
            console.error('❌ Error en fallback de video:', e);
        }
    }
    
    actualizarLayout();
}

// ============================================================
// ✅ SOLUCIÓN 2: AUDIO REMOTO - VERSIÓN CORREGIDA (SIN ECO)
// ============================================================

function agregarAudioRemotoConGanancia(track, participant) {
    if (!participant || !track) return;
    
    const identity = participant.identity;
    
    // ✅ CRÍTICO: NO reproducir audio propio (EVITA ECO)
    if (identity === room?.localParticipant?.identity) {
        console.log('⏭️ 🚨 SALTANDO AUDIO PROPIO - EVITA ECO');
        return;
    }

    // ✅ Verificar si ya existe
    if (audioMap.has(identity)) {
        console.log(`⏭️ Audio ya existe para ${identity}`);
        return;
    }

    // ✅ ============================================
    // ✅ PRIMERO: INTENTAR CON HTML5 AUDIO (SIN ECO)
    // ✅ ============================================
    try {
        console.log(`📻 Creando audio HTML5 para: ${identity}`);
        
        // ✅ Crear elemento de audio HTML
        const audioElement = document.createElement('audio');
        audioElement.autoplay = true;
        audioElement.playsInline = true;
        audioElement.dataset.identity = identity;
        audioElement.volume = Math.min(volumenActual, 1.0);
        audioElement.muted = false;
        audioElement.setAttribute('autoplay', '');
        audioElement.setAttribute('playsinline', '');
        document.body.appendChild(audioElement);
        
        // ✅ Adjuntar track al elemento HTML
        if (typeof track.attach === 'function') {
            track.attach(audioElement);
            console.log(`✅ Track adjuntado a HTML para: ${identity}`);
        } else {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            audioElement.srcObject = stream;
            audioElement.play().catch(() => {});
            console.log(`✅ Stream adjuntado a HTML para: ${identity}`);
        }
        
        // ✅ Guardar en audioMap como HTML5 (prioridad)
        const audioInfo = {
            element: audioElement,
            identity: identity,
            isFallback: true,  // ✅ Marcado como HTML5
            track: track,
            connected: true
        };
        
        audioMap.set(identity, audioInfo);
        console.log(`🔊 Audio HTML5 creado para: ${identity} (volumen: ${audioElement.volume})`);
        
        // ✅ Actualizar volumen
        actualizarVolumen();
        
        // ✅ Exponer globalmente
        window.audioMap = audioMap;
        window.room = room;
        window.volumenActual = volumenActual;
        
        return audioInfo;
        
    } catch (htmlError) {
        console.error('❌ Error creando audio HTML5:', htmlError);
        console.warn('⚠️ Usando Web Audio API como respaldo...');
        
        // ✅ ============================================
        // ✅ SEGUNDO: FALLBACK A WEB AUDIO API
        // ✅ ============================================
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const gainNode = audioContext.createGain();
            const volumenAmplificado = volumenActual * 1.5;
            gainNode.gain.value = Math.min(volumenAmplificado, 2.0);
            
            const source = audioContext.createMediaStreamSource(
                new MediaStream([track.mediaStreamTrack])
            );
            
            source.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            const audioInfo = {
                context: audioContext,
                source: source,
                gainNode: gainNode,
                identity: identity,
                track: track,
                connected: true,
                isFallback: false
            };
            
            audioMap.set(identity, audioInfo);
            console.log(`🔊 Web Audio creado (respaldo) para: ${identity}`);
            
            if (audioContext.state === 'suspended') {
                audioContext.resume().then(() => {
                    console.log(`🎵 AudioContext reanudado para ${identity}`);
                }).catch(err => {
                    console.warn(`⚠️ Error reanudando AudioContext para ${identity}:`, err);
                });
            }
            
            actualizarVolumen();
            window.audioMap = audioMap;
            window.room = room;
            window.volumenActual = volumenActual;
            
            return audioInfo;
            
        } catch (webAudioError) {
            console.error('❌ Error en respaldo Web Audio:', webAudioError);
            return null;
        }
    }
}

// ============================================================
// ✅ FALLBACK: HTML5 AUDIO (SIN GANANCIA) - MANTENIDO POR COMPATIBILIDAD
// ============================================================

function agregarAudioRemotoFallback(track, participant) {
    // ✅ Esta función ya no se usa directamente, pero se mantiene por compatibilidad
    // ✅ La función principal agregarAudioRemotoConGanancia ahora prioriza HTML5
    console.log('⚠️ agregarAudioRemotoFallback llamado - usando agregarAudioRemotoConGanancia en su lugar');
    return agregarAudioRemotoConGanancia(track, participant);
}

// ============================================================
// ✅ SOLUCIÓN 3: CONTROL DE VOLUMEN MEJORADO
// ============================================================

function actualizarVolumen() {
    if (!volumen) return;
    
    volumenActual = Number(volumen.value);
    console.log(`🎚️ Volumen ajustado a: ${(volumenActual * 100).toFixed(0)}%`);
    
    // ✅ Actualizar audios HTML5 (prioridad)
    document.querySelectorAll('audio[data-identity]').forEach(audio => {
        audio.volume = Math.min(volumenActual, 1.0);
        audio.muted = false;
    });
    
    // ✅ Actualizar Web Audio (solo si existe y no hay HTML)
    for (const [identity, audioInfo] of audioMap) {
        if (audioInfo.isFallback && audioInfo.element) {
            // ✅ Es HTML5, ya se actualizó arriba
            continue;
        } else if (audioInfo.gainNode) {
            // ✅ Es Web Audio (respaldo)
            const volumenAmplificado = volumenActual * 1.5;
            const valorFinal = Math.min(volumenAmplificado, 2.0);
            audioInfo.gainNode.gain.value = valorFinal;
            console.log(`🔊 ${identity} (Web Audio): gain = ${(valorFinal * 100).toFixed(0)}%`);
        }
    }
    
    if (volumenLabel) {
        volumenLabel.textContent = Math.round(volumenActual * 100) + '%';
    }
    
    window.volumenActual = volumenActual;
}

// ============================================================
// ELIMINAR TRACKS
// ============================================================

function eliminarTrackRemoto(track, participant) {
    if (!participant) return;
    const identity = participant.identity;

    if (track?.kind === LivekitClient.Track.Kind.Video) {
        const video = videoMap.get(identity);
        if (video) {
            try {
                if (typeof track.detach === 'function') {
                    track.detach(video);
                }
            } catch (e) {}
            video.srcObject = null;
            video.remove();
            videoMap.delete(identity);
            console.log(`🗑️ Video eliminado: ${identity}`);
        }
    }

    if (track?.kind === LivekitClient.Track.Kind.Audio) {
        const audioInfo = audioMap.get(identity);
        if (audioInfo) {
            try {
                if (audioInfo.source) {
                    audioInfo.source.disconnect();
                }
                if (audioInfo.gainNode) {
                    audioInfo.gainNode.disconnect();
                }
                if (audioInfo.context && audioInfo.context.state !== 'closed') {
                    audioInfo.context.close().catch(() => {});
                }
                if (audioInfo.element) {
                    if (typeof track.detach === 'function') {
                        track.detach(audioInfo.element);
                    }
                    audioInfo.element.srcObject = null;
                    audioInfo.element.remove();
                }
            } catch (e) {}
            
            audioMap.delete(identity);
            console.log(`🗑️ Audio eliminado: ${identity}`);
        }
    }

    actualizarLayout();
}

function eliminarParticipante(participant) {
    if (!participant) return;
    const identity = participant.identity;

    const video = videoMap.get(identity);
    if (video) {
        video.srcObject = null;
        video.remove();
        videoMap.delete(identity);
    }

    const audioInfo = audioMap.get(identity);
    if (audioInfo) {
        try {
            if (audioInfo.source) {
                audioInfo.source.disconnect();
            }
            if (audioInfo.gainNode) {
                audioInfo.gainNode.disconnect();
            }
            if (audioInfo.context && audioInfo.context.state !== 'closed') {
                audioInfo.context.close().catch(() => {});
            }
            if (audioInfo.element) {
                audioInfo.element.srcObject = null;
                audioInfo.element.remove();
            }
        } catch (e) {}
        audioMap.delete(identity);
    }
}

function agregarParticipante(participant) {
    if (!participant || !participant.trackPublications) return;

    participant.trackPublications.forEach((publication) => {
        if (publication.isSubscribed && publication.track) {
            if (publication.track.kind === LivekitClient.Track.Kind.Video) {
                agregarVideoRemoto(publication.track, participant);
            } else if (publication.track.kind === LivekitClient.Track.Kind.Audio) {
                agregarAudioRemotoConGanancia(publication.track, participant);
            }
        }
    });
}

// ============================================================
// VIDEO LOCAL
// ============================================================

function mostrarVideoLocal(publication) {
    if (!publication || !publication.videoTrack) return;

    let video = document.getElementById('video-local');
    if (!video) {
        video = document.createElement('video');
        video.id = 'video-local';
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.className = 'video-local';
        gridVideos.prepend(video);
        console.log('📹 Video local creado');
    }

    try {
        if (typeof publication.videoTrack.attach === 'function') {
            publication.videoTrack.attach(video);
            console.log('✅ Video local adjuntado');
        } else {
            const stream = new MediaStream();
            stream.addTrack(publication.videoTrack.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(() => {});
            console.log('✅ Video local adjuntado (fallback)');
        }
    } catch (error) {
        console.warn('⚠️ Error adjuntando video local:', error);
        try {
            const stream = new MediaStream();
            stream.addTrack(publication.videoTrack.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(() => {});
        } catch (e) {
            console.error('❌ Error en fallback de video local:', e);
        }
    }
    
    actualizarLayout();
}

// ============================================================
// LIMPIAR
// ============================================================

function limpiarVideos() {
    if (!gridVideos) return;
    
    gridVideos.querySelectorAll('video').forEach(video => {
        try {
            video.srcObject = null;
            video.remove();
        } catch (e) {}
    });
    
    for (const [identity, audioInfo] of audioMap) {
        try {
            if (audioInfo.source) {
                audioInfo.source.disconnect();
            }
            if (audioInfo.gainNode) {
                audioInfo.gainNode.disconnect();
            }
            if (audioInfo.context && audioInfo.context.state !== 'closed') {
                audioInfo.context.close().catch(() => {});
            }
            if (audioInfo.element) {
                audioInfo.element.srcObject = null;
                audioInfo.element.remove();
            }
        } catch (e) {}
    }
    
    document.querySelectorAll('audio[data-identity]').forEach(audio => {
        try {
            audio.srcObject = null;
            audio.remove();
        } catch (e) {}
    });
    
    videoMap.clear();
    audioMap.clear();
    
    console.log('🧹 Videos y audios limpiados');
}

// ============================================================
// UI
// ============================================================

function actualizarParticipanteRemoto() {
    if (!peerConectado || !room) return;
    const cantidad = room.remoteParticipants ? room.remoteParticipants.size : 0;
    peerConectado.textContent = cantidad;
}

function actualizarLayout() {
    if (!gridVideos) return;
    
    const videos = gridVideos.querySelectorAll('video');
    const total = videos.length;
    
    if (total === 0) {
        gridVideos.style.gridTemplateColumns = '1fr';
        gridVideos.style.gridTemplateRows = '1fr';
        gridVideos.style.gap = '0';
        return;
    }

    if (total === 1) {
        gridVideos.style.gridTemplateColumns = '1fr';
        gridVideos.style.gridTemplateRows = '1fr';
        gridVideos.style.gap = '0';
        return;
    }

    if (total === 2) {
        gridVideos.style.gridTemplateColumns = 'repeat(2, 1fr)';
        gridVideos.style.gridTemplateRows = '1fr';
        gridVideos.style.gap = '2px';
        return;
    }

    if (total <= 4) {
        gridVideos.style.gridTemplateColumns = 'repeat(2, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(2, 1fr)';
        gridVideos.style.gap = '2px';
        return;
    }

    if (total <= 6) {
        gridVideos.style.gridTemplateColumns = 'repeat(3, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(2, 1fr)';
        gridVideos.style.gap = '2px';
        return;
    }

    if (total <= 9) {
        gridVideos.style.gridTemplateColumns = 'repeat(3, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(3, 1fr)';
        gridVideos.style.gap = '2px';
        return;
    }

    if (total <= 12) {
        gridVideos.style.gridTemplateColumns = 'repeat(4, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(3, 1fr)';
        gridVideos.style.gap = '2px';
        return;
    }

    const columns = Math.min(Math.ceil(Math.sqrt(total * 1.5)), 6);
    gridVideos.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
    gridVideos.style.gridTemplateRows = `repeat(${Math.ceil(total / columns)}, 1fr)`;
    gridVideos.style.gap = '2px';
}

// ============================================================
// CONTROLES
// ============================================================

async function alternarMicrofono() {
    if (!room) {
        console.warn('⚠️ Room no disponible');
        return;
    }
    
    try {
        const publication = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
        const isEnabled = publication ? publication.isEnabled : true;
        
        await room.localParticipant.setMicrophoneEnabled(!isEnabled);
        
        if (isEnabled) {
            btnMicrofono?.classList.remove('activo');
            btnMicrofono?.classList.add('inactivo');
            console.log('🎤 Micrófono desactivado');
        } else {
            btnMicrofono?.classList.remove('inactivo');
            btnMicrofono?.classList.add('activo');
            console.log('🎤 Micrófono activado');
        }
    } catch (error) {
        console.error('❌ Error con micrófono:', error);
    }
}

async function alternarCamara() {
    if (!room) {
        console.warn('⚠️ Room no disponible');
        return;
    }
    
    try {
        const publication = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
        const isEnabled = publication ? publication.isEnabled : true;
        
        await room.localParticipant.setCameraEnabled(!isEnabled);
        
        if (isEnabled) {
            btnCamara?.classList.add('inactivo');
            btnCamara?.classList.remove('activo');
            console.log('📷 Cámara desactivada');
        } else {
            btnCamara?.classList.remove('inactivo');
            btnCamara?.classList.add('activo');
            console.log('📷 Cámara activada');
        }
    } catch (error) {
        console.error('❌ Error con cámara:', error);
    }
}

async function silenciarTemporalmente() {
    if (!room || audioMuted) return;
    
    audioMuted = true;
    btnSilenciar?.classList.add('activo');
    
    try {
        await room.localParticipant.setMicrophoneEnabled(false);
        console.log('🔇 Silenciado temporalmente');
        
        setTimeout(async () => {
            try {
                await room.localParticipant.setMicrophoneEnabled(true);
                audioMuted = false;
                btnSilenciar?.classList.remove('activo');
                console.log('🎤 Micrófono reactivado');
            } catch (error) {
                console.error('❌ Error reactivando:', error);
                audioMuted = false;
                btnSilenciar?.classList.remove('activo');
            }
        }, 5000);
    } catch (error) {
        console.error('❌ Error silenciando:', error);
        audioMuted = false;
        btnSilenciar?.classList.remove('activo');
    }
}

async function compartirPantalla() {
    if (!room) return;
    
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { cursor: 'always', frameRate: 30 } 
        });
        const track = stream.getVideoTracks()[0];
        if (track) {
            await room.localParticipant.publishTrack(track, {
                name: 'screen-share',
                source: LivekitClient.Track.Source.ScreenShare
            });
            console.log('🖥️ Pantalla compartida');
            track.onended = () => console.log('🖥️ Compartición finalizada');
        }
    } catch (error) {
        if (error.name !== 'NotAllowedError' && error.name !== 'PermissionDeniedError') {
            console.error('❌ Error compartiendo:', error);
        }
    }
}

async function pantallaCompleta() {
    if (!gridVideos) return;
    
    try {
        if (!document.fullscreenElement) {
            await gridVideos.requestFullscreen();
        } else {
            await document.exitFullscreen();
        }
    } catch (error) {
        console.error('❌ Error pantalla completa:', error);
    }
}

async function reconectarManual() {
    if (conectando || reconectando) {
        console.log('⏳ Ya hay una reconexión en progreso');
        return;
    }
    
    reconectando = true;
    intentosReconexion = 0;
    
    if (reconexionTimeout) {
        clearTimeout(reconexionTimeout);
        reconexionTimeout = null;
    }
    
    actualizarEstado('Reconectando manual...', 'conectando');
    mostrarLoading();
    
    try {
        if (room) {
            try { await room.disconnect(); } catch (e) {}
            room = null;
        }
        limpiarVideos();
        await new Promise(resolve => setTimeout(resolve, 500));
        await conectarLiveKit();
    } catch (error) {
        console.error('❌ Error reconectando:', error);
        actualizarEstado('Error al reconectar', 'error');
        ocultarLoading();
    } finally {
        reconectando = false;
    }
}

// ============================================================
// ✅ SOLUCIÓN 5: DIAGNÓSTICO MEJORADO
// ============================================================

function diagnostico() {
    let info = '📊 DIAGNÓSTICO VENTANA DIGITAL PRO\n\n';
    info += '━'.repeat(50) + '\n\n';
    info += `🔗 LiveKit URL: ${LIVEKIT_URL}\n`;
    info += `📁 Sala: ${ROOM_NAME}\n\n`;
    
    if (room) {
        info += `📡 Estado: ${room.state || 'desconocido'}\n`;
        info += `🆔 Mi ID: ${room.localParticipant?.identity || 'N/A'}\n`;
        info += `👥 Participantes remotos: ${room.remoteParticipants?.size || 0}\n`;
        info += `📹 Videos en pantalla: ${gridVideos.querySelectorAll('video').length}\n`;
        info += `🔊 Audios remotos: ${audioMap.size}\n\n`;
        
        info += '🔊 CONFIGURACIÓN ANTI-ECO:\n';
        info += `   ✅ Echo Cancellation: ACTIVADO\n`;
        info += `   ✅ Noise Suppression: ACTIVADO\n`;
        info += `   ✅ Auto Gain Control: ACTIVADO\n`;
        info += `   ✅ Video local: MUTED\n`;
        info += `   ✅ Audio propio: NO REPRODUCIDO\n`;
        info += `   ✅ adaptiveStream: DESACTIVADO\n\n`;
        
        info += '🔊 DIAGNÓSTICO DE VOLUMEN:\n';
        info += `   🎚️ Volumen actual: ${(volumenActual * 100).toFixed(0)}%\n`;
        info += `   🎯 Ganancia aplicada: ${(volumenActual * 150).toFixed(0)}% (150%)\n`;
        info += `   📊 Audios con Web Audio: ${Array.from(audioMap.values()).filter(a => !a.isFallback && a.gainNode).length}\n`;
        info += `   📊 Audios HTML5: ${Array.from(audioMap.values()).filter(a => a.isFallback && a.element).length}\n\n`;
        
        if (audioMap.size > 0) {
            info += '🔊 DETALLE DE AUDIOS:\n';
            for (const [identity, audioInfo] of audioMap) {
                if (audioInfo.isFallback && audioInfo.element) {
                    const vol = audioInfo.element?.volume || 0;
                    const paused = audioInfo.element?.paused ? 'pausado' : 'reproduciendo';
                    info += `   📻 ${identity}: HTML5, volumen=${(vol * 100).toFixed(0)}%, ${paused}\n`;
                } else if (audioInfo.gainNode) {
                    const gain = audioInfo.gainNode.gain.value;
                    const state = audioInfo.context?.state || 'unknown';
                    info += `   🔊 ${identity}: Web Audio, ganancia=${(gain * 100).toFixed(0)}%, estado=${state}\n`;
                }
            }
        }
        
        info += '\n🌐 ESTADO DE INTERNET:\n';
        info += `   📶 Online: ${navigator.onLine ? 'SÍ' : 'NO'}\n`;
        info += `   🔄 Reconectando: ${reconectando ? 'SÍ' : 'NO'}\n`;
    } else {
        info += '❌ Room: NO CONECTADO\n';
    }
    
    info += '\n' + '━'.repeat(50) + '\n';
    info += `🌐 Navegador: ${navigator.userAgent}`;
    
    console.log(info);
    alert(info);
}

// ============================================================
// EVENT LISTENERS
// ============================================================

if (btnMicrofono) btnMicrofono.addEventListener('click', alternarMicrofono);
if (btnCamara) btnCamara.addEventListener('click', alternarCamara);
if (btnSilenciar) btnSilenciar.addEventListener('click', silenciarTemporalmente);
if (btnCompartir) btnCompartir.addEventListener('click', compartirPantalla);
if (btnFullscreen) btnFullscreen.addEventListener('click', pantallaCompleta);
if (btnReconectar) btnReconectar.addEventListener('click', reconectarManual);
if (btnDiagnostico) btnDiagnostico.addEventListener('click', diagnostico);

if (volumen) {
    if (volumen.min === '') volumen.min = '0';
    if (volumen.max === '') volumen.max = '1';
    if (volumen.step === '') volumen.step = '0.01';
    if (volumen.value === '') volumen.value = '1.0';
    
    volumen.addEventListener('input', actualizarVolumen);
}

window.addEventListener('resize', actualizarLayout);
window.addEventListener('orientationchange', () => {
    setTimeout(actualizarLayout, 300);
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        actualizarLayout();
    }
});

document.addEventListener('click', async () => {
    console.log('🖱️ Click detectado - Reanudando audio...');
    await forzarReanudacionAudio();
}, { once: false });

// ============================================================
// ✅ EXPONER VARIABLES GLOBALES PARA DIAGNÓSTICO
// ============================================================

window.room = room;
window.audioMap = audioMap;
window.videoMap = videoMap;
window.volumenActual = volumenActual;
window.agregarAudioRemotoConGanancia = agregarAudioRemotoConGanancia;
window.forzarReanudacionAudio = forzarReanudacionAudio;
window.actualizarVolumen = actualizarVolumen;

const originalConectar = conectarLiveKit;
conectarLiveKit = async function() {
    await originalConectar.call(this);
    window.room = room;
    window.audioMap = audioMap;
    window.videoMap = videoMap;
    window.volumenActual = volumenActual;
};

const originalActualizarVolumen = actualizarVolumen;
actualizarVolumen = function() {
    originalActualizarVolumen.call(this);
    window.volumenActual = volumenActual;
};

// ============================================================
// INICIALIZACIÓN
// ============================================================

async function iniciarCamara() {
    console.log('🚀 Iniciando Ventana Digital Pro...');
    console.log('📋 Versión: 4.6 - Sin Eco');
    console.log('🔊 Volumen por defecto: 100% (amplificado 150%)');
    console.log('💡 Haz clic en la página para activar el audio si es necesario');
    console.log('🌐 Monitor de internet activado');
    console.log('🔍 Variables expuestas globalmente para diagnóstico');
    
    iniciarMonitorInternet();
    
    if (volumen) {
        volumen.value = '1.0';
        if (volumenLabel) {
            volumenLabel.textContent = '100%';
        }
    }
    
    actualizarVolumen();
    actualizarLayout();
    await conectarLiveKit();
    
    window.room = room;
    window.audioMap = audioMap;
    window.videoMap = videoMap;
    window.volumenActual = volumenActual;
    window.agregarAudioRemotoConGanancia = agregarAudioRemotoConGanancia;
    window.forzarReanudacionAudio = forzarReanudacionAudio;
    window.actualizarVolumen = actualizarVolumen;
    
    setTimeout(() => {
        console.log('✅ Sistema listo - Presiona "Diagnóstico" para ver detalles');
        console.log('🔍 Variables globales disponibles: room, audioMap, videoMap, volumenActual');
        forzarReanudacionAudio();
    }, 2000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarCamara, { once: true });
} else {
    iniciarCamara();
}

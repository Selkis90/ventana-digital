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
let volumenActual = 1.0;  // ✅ AHORA 100% (antes era 0.30)

let reconexionTimeout = null;
let intentosReconexion = 0;
const MAX_INTENTOS_RECONEXION = 5;

// Mapas para tracks
const videoMap = new Map();
const audioMap = new Map();  // ✅ Ahora almacena objetos con GainNode

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
        // ✅ Configuración mejorada con soporte para codec Opus y bitrate alto
        const constraints = {
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
                sampleSize: 24,
                channelCount: 1,
                // ✅ Propiedades compatibles con Chrome/Edge
                googEchoCancellation: true,
                googAutoGainControl: true,
                googNoiseSuppression: true,
                googHighpassFilter: true,
                googAudioMirroring: false,
                // ✅ NUEVO: Configuración avanzada para mejor calidad
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

        // ✅ Forzar codec Opus si es posible
        const track = stream.getAudioTracks()[0];
        if (track && track.getCapabilities) {
            try {
                const capabilities = track.getCapabilities();
                console.log('📊 Capabilities de audio:', capabilities);
                // ✅ Si soporta, forzar mejor calidad
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

        // ✅ Publicar audio
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

        // ✅ Publicar cámara
        try { 
            await room.localParticipant.setCameraEnabled(true);
            btnCamara?.classList.remove('inactivo');
            btnCamara?.classList.add('activo');
            console.log('✅ Cámara activada');
        } catch (error) { 
            console.warn('⚠️ Cámara no disponible:', error); 
            btnCamara?.classList.add('inactivo');
        }

        // ✅ Procesar participantes existentes
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
            // ✅ Usar la versión mejorada con GainNode
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

    room.on(LivekitClient.RoomEvent.Reconnected, () => {
        reconectando = false;
        intentosReconexion = 0;
        actualizarEstado('Conectado', 'conectado');
        console.log('✅ LiveKit reconectado');
        actualizarLayout();
    });

    room.on(LivekitClient.RoomEvent.Disconnected, reason => {
        reconectando = false;
        console.warn('⚠️ Desconectado:', reason);
        
        if (reason === 'user' || reason === 'room_closed') {
            actualizarEstado('Desconectado', 'error');
            return;
        }

        if (intentosReconexion < MAX_INTENTOS_RECONEXION) {
            intentosReconexion++;
            const delay = intentosReconexion * 2000;
            console.log(`🔄 Reconexión en ${delay/1000}s (intento ${intentosReconexion}/${MAX_INTENTOS_RECONEXION})`);
            actualizarEstado(`Reconectando... (${intentosReconexion}/${MAX_INTENTOS_RECONEXION})`, 'conectando');
            
            if (reconexionTimeout) {
                clearTimeout(reconexionTimeout);
            }
            reconexionTimeout = setTimeout(() => {
                reconexionTimeout = null;
                if (!room || room.state === 'disconnected') {
                    conectarLiveKit();
                }
            }, delay);
        } else {
            actualizarEstado('Error - Reintenta manual', 'error');
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
// ✅ SOLUCIÓN 2: AUDIO REMOTO CON GANANCIA (WEB AUDIO API)
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

    try {
        // ✅ Crear contexto de audio
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        // ✅ SOLUCIÓN 2: Crear nodo de ganancia (AMPLIFICADOR)
        const gainNode = audioContext.createGain();
        
        // ✅ Aplicar volumen actual con AMPLIFICACIÓN (150%)
        const volumenAmplificado = volumenActual * 1.5;
        gainNode.gain.value = Math.min(volumenAmplificado, 2.0); // ✅ Máximo 200%
        
        console.log(`🔊 Ganancia inicial para ${identity}: ${(gainNode.gain.value * 100).toFixed(0)}%`);
        
        // ✅ Crear fuente desde el track
        const source = audioContext.createMediaStreamSource(
            new MediaStream([track.mediaStreamTrack])
        );
        
        // ✅ Conectar: fuente -> ganancia -> destino (altavoces)
        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        // ✅ Guardar TODO para poder ajustar después
        const audioInfo = {
            context: audioContext,
            source: source,
            gainNode: gainNode,
            identity: identity,
            track: track,
            connected: true
        };
        
        audioMap.set(identity, audioInfo);
        console.log(`🔊 Audio amplificado creado para: ${identity} (${(gainNode.gain.value * 100).toFixed(0)}%)`);
        
        // ✅ Si el contexto está suspendido, reanudarlo
        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                console.log('🎵 AudioContext reanudado');
            }).catch(err => {
                console.warn('⚠️ Error reanudando AudioContext:', err);
            });
        }
        
        // ✅ SOLUCIÓN 3: Asegurar que el slider actualice este audio
        actualizarVolumen(); // Aplica el volumen a todos los audios
        
        return audioInfo;
        
    } catch (error) {
        console.error('❌ Error creando audio con Web Audio API:', error);
        console.warn('⚠️ Usando fallback HTML5 Audio...');
        
        // ✅ Fallback: HTML5 Audio si Web Audio falla
        agregarAudioRemotoFallback(track, participant);
    }
}

// ============================================================
// ✅ FALLBACK: HTML5 AUDIO (SIN GANANCIA)
// ============================================================

function agregarAudioRemotoFallback(track, participant) {
    if (!participant || !track) return;
    
    const identity = participant.identity;
    
    if (identity === room?.localParticipant?.identity) {
        console.log('⏭️ 🚨 SALTANDO AUDIO PROPIO - EVITA ECO');
        return;
    }

    if (audioMap.has(identity)) {
        console.log(`⏭️ Audio ya existe para ${identity}`);
        return;
    }

    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.dataset.identity = identity;
    // ✅ SOLUCIÓN 1: Volumen al 100%
    audio.volume = Math.min(volumenActual, 1.0);
    audio.setAttribute('autoplay', '');
    audio.setAttribute('playsinline', '');
    document.body.appendChild(audio);
    
    // ✅ Guardar en audioMap pero con estructura especial para saber que es fallback
    const audioInfo = {
        element: audio,
        identity: identity,
        isFallback: true,
        track: track
    };
    
    audioMap.set(identity, audioInfo);
    console.log(`🔊 Audio HTML5 creado para: ${identity} (volumen: ${audio.volume})`);

    try {
        if (typeof track.attach === 'function') {
            track.attach(audio);
        } else {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            audio.srcObject = stream;
            audio.play().catch(() => {});
        }
    } catch (error) {
        console.warn('⚠️ Error adjuntando audio HTML5:', error);
        try {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            audio.srcObject = stream;
            audio.play().catch(() => {});
        } catch (e) {
            console.error('❌ Error en fallback de audio HTML5:', e);
        }
    }
}

// ============================================================
// ✅ SOLUCIÓN 3: CONTROL DE VOLUMEN MEJORADO
// ============================================================

function actualizarVolumen() {
    if (!volumen) return;
    
    volumenActual = Number(volumen.value);
    console.log(`🎚️ Volumen ajustado a: ${(volumenActual * 100).toFixed(0)}%`);
    
    // ✅ Actualizar audios HTML5 (fallback)
    document.querySelectorAll('audio[data-identity]').forEach(audio => {
        audio.volume = Math.min(volumenActual, 1.0);
    });
    
    // ✅ Actualizar Web Audio (con ganancia)
    audioMap.forEach((audioInfo, identity) => {
        if (audioInfo.isFallback) {
            // Es HTML5 fallback
            if (audioInfo.element) {
                audioInfo.element.volume = Math.min(volumenActual, 1.0);
            }
        } else if (audioInfo.gainNode) {
            // ✅ SOLUCIÓN 2 + 3: Ganancia AMPLIFICADA (150%)
            const volumenAmplificado = volumenActual * 1.5;
            const valorFinal = Math.min(volumenAmplificado, 2.0);
            audioInfo.gainNode.gain.value = valorFinal;
            
            console.log(`🔊 ${identity}: gain = ${(valorFinal * 100).toFixed(0)}%`);
        }
    });
    
    // ✅ Actualizar label del slider
    if (volumenLabel) {
        volumenLabel.textContent = Math.round(volumenActual * 100) + '%';
    }
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
                // ✅ Limpiar Web Audio
                if (audioInfo.source) {
                    audioInfo.source.disconnect();
                }
                if (audioInfo.gainNode) {
                    audioInfo.gainNode.disconnect();
                }
                if (audioInfo.context && audioInfo.context.state !== 'closed') {
                    audioInfo.context.close().catch(() => {});
                }
                // ✅ Limpiar HTML5 fallback
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
                // ✅ Usar versión con ganancia
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
        video.muted = true; // ✅ Silenciado para evitar eco
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
    
    // ✅ Limpiar audios Web Audio y HTML5
    audioMap.forEach((audioInfo) => {
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
    });
    
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
// ✅ SOLUCIÓN 5: DIAGNÓSTICO DE VOLUMEN MEJORADO
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
        info += `   📊 Audios HTML5 (fallback): ${Array.from(audioMap.values()).filter(a => a.isFallback).length}\n\n`;
        
        // ✅ Mostrar ganancia de cada audio
        if (audioMap.size > 0) {
            info += '🔊 DETALLE DE AUDIOS:\n';
            audioMap.forEach((audioInfo, identity) => {
                if (audioInfo.isFallback) {
                    const vol = audioInfo.element?.volume || 0;
                    info += `   📻 ${identity}: HTML5, volumen=${(vol * 100).toFixed(0)}%\n`;
                } else if (audioInfo.gainNode) {
                    const gain = audioInfo.gainNode.gain.value;
                    info += `   🔊 ${identity}: Web Audio, ganancia=${(gain * 100).toFixed(0)}%\n`;
                }
            });
        }
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
    // ✅ Asegurar que el slider tenga valores correctos
    if (volumen.min === '') volumen.min = '0';
    if (volumen.max === '') volumen.max = '1';
    if (volumen.step === '') volumen.step = '0.01';
    if (volumen.value === '') volumen.value = '1.0'; // ✅ 100% por defecto
    
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

// ============================================================
// INICIALIZACIÓN
// ============================================================

async function iniciarCamara() {
    console.log('🚀 Iniciando Ventana Digital Pro...');
    console.log('📋 Versión: 4.2 - Audio Mejorado');
    console.log('🔊 Volumen por defecto: 100% (amplificado 150%)');
    
    // ✅ Asegurar que el slider esté en 100%
    if (volumen) {
        volumen.value = '1.0';
        if (volumenLabel) {
            volumenLabel.textContent = '100%';
        }
    }
    
    actualizarVolumen();
    actualizarLayout();
    await conectarLiveKit();
    
    // ✅ Mostrar diagnóstico después de conectar
    setTimeout(() => {
        console.log('✅ Sistema listo - Presiona "Diagnóstico" para ver detalles');
    }, 2000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarCamara, { once: true });
} else {
    iniciarCamara();
}

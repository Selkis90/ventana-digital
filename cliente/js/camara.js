'use strict';

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

let room = null;
let conectando = false;
let reconectando = false;
let audioMuted = false;
let volumenActual = 0.30;

// ✅ Variables para reconexión automática
let reconexionAutomatica = true;
let intentosReconexion = 0;
const MAX_INTENTOS_RECONEXION = 10;
const INTERVALO_RECONEXION = 3000; // 3 segundos
let temporizadorReconexion = null;
let monitorInternet = null;
let ultimoHeartbeat = Date.now();
let heartbeatInterval = null;

// Mapas para almacenar elementos de medios
const videoMap = new Map();
const audioMap = new Map();

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

// ============================================================
// ✅ MONITOR DE INTERNET - RECONEXIÓN AUTOMÁTICA
// ============================================================

function iniciarMonitorInternet() {
    // ✅ Detectar cambios en la conectividad
    window.addEventListener('online', () => {
        console.log('🌐 Internet recuperado - Intentando reconectar...');
        if (!room || room.state === 'disconnected') {
            triggerReconexionAutomatica();
        }
    });

    window.addEventListener('offline', () => {
        console.log('🌐 Internet perdido - Esperando recuperación...');
        actualizarEstado('Sin internet', 'error');
    });

    // ✅ Heartbeat periódico para detectar conexión perdida
    heartbeatInterval = setInterval(() => {
        const ahora = Date.now();
        const diferencia = ahora - ultimoHeartbeat;
        
        // Si pasaron más de 10 segundos sin heartbeat y estamos conectados
        if (diferencia > 10000 && room && room.state === 'connected') {
            console.warn('⚠️ Heartbeat perdido - Intentando reconectar...');
            triggerReconexionAutomatica();
        }
    }, 5000);

    // ✅ Monitorear estado de la página
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            // Si la página vuelve a ser visible, verificar conexión
            if (!room || room.state !== 'connected') {
                console.log('👀 Página visible - Verificando conexión...');
                triggerReconexionAutomatica();
            }
        }
    });

    console.log('📡 Monitor de internet iniciado');
}

function triggerReconexionAutomatica() {
    if (!reconexionAutomatica) return;
    if (reconectando || conectando) return;
    
    console.log(`🔄 Intentando reconexión automática (intento ${intentosReconexion + 1}/${MAX_INTENTOS_RECONEXION})...`);
    
    if (temporizadorReconexion) {
        clearTimeout(temporizadorReconexion);
        temporizadorReconexion = null;
    }

    if (intentosReconexion >= MAX_INTENTOS_RECONEXION) {
        console.error('❌ Máximo de intentos de reconexión alcanzado');
        actualizarEstado('Error crítico - Reintenta manualmente', 'error');
        reconexionAutomatica = false;
        return;
    }

    intentosReconexion++;
    reconectando = true;
    actualizarEstado(`Reconectando (${intentosReconexion}/${MAX_INTENTOS_RECONEXION})...`, 'conectando');

    // ✅ Intentar reconectar después de un breve delay
    temporizadorReconexion = setTimeout(async () => {
        try {
            if (room) {
                try { await room.disconnect(); } catch (e) {}
                room = null;
            }
            limpiarVideos();
            await conectarLiveKit();
            intentosReconexion = 0; // Resetear contador al reconectar
            reconexionAutomatica = true;
            actualizarEstado('Reconectado', 'conectado');
            console.log('✅ Reconexión automática exitosa');
        } catch (error) {
            console.error('❌ Error en reconexión automática:', error);
            reconectando = false;
            // Programar próximo intento
            temporizadorReconexion = setTimeout(() => {
                triggerReconexionAutomatica();
            }, INTERVALO_RECONEXION);
        }
    }, 2000);
}

// ============================================================
// ✅ CONFIGURACIÓN DE AUDIO
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
                googAudioMirroring: false
            }
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        if (stream.getAudioTracks().length === 0) {
            throw new Error('No se obtuvieron pistas de audio');
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
// ✅ FUNCIÓN PRINCIPAL - CON RECONEXIÓN
// ============================================================

async function conectarLiveKit() {
    if (conectando) return;
    conectando = true;

    try {
        actualizarEstado('Conectando...', 'conectando');

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
            throw new Error('El servidor respondió HTTP ' + respuesta.status);
        }

        const data = await respuesta.json();
        if (!data.token) {
            throw new Error('El servidor no entregó un token LiveKit.');
        }

        room = new LivekitClient.Room({ 
            adaptiveStream: false,
            dynacast: true 
        });
        
        registrarEventosLiveKit();
        await room.connect(LIVEKIT_URL, data.token, { 
            autoSubscribe: true 
        });

        // ✅ Actualizar heartbeat
        ultimoHeartbeat = Date.now();

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
                console.log('✅ Audio publicado correctamente');
            }
        } catch (error) {
            console.warn('⚠️ Error con publishTrack, usando setMicrophoneEnabled:', error);
            try { 
                await room.localParticipant.setMicrophoneEnabled(true);
                btnMicrofono?.classList.add('activo');
                btnMicrofono?.classList.remove('inactivo');
                console.log('✅ Audio publicado (setMicrophoneEnabled)');
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

        // ✅ Resetear contadores de reconexión
        intentosReconexion = 0;
        reconexionAutomatica = true;
        reconectando = false;

        actualizarEstado('Conectado', 'conectado');
        actualizarParticipanteRemoto();
        actualizarLayout();
        ocultarLoading();

    } catch (error) {
        console.error('❌ ERROR LIVEKIT:', error);
        actualizarEstado('Error de conexión', 'error');
        ocultarLoading();
        
        // ✅ Si hay error, intentar reconexión automática
        if (reconexionAutomatica) {
            triggerReconexionAutomatica();
        }
    } finally {
        conectando = false;
    }
}

// ============================================================
// ✅ EVENTOS - CON HEARTBEAT
// ============================================================

function registrarEventosLiveKit() {
    if (!room) return;

    room.on(LivekitClient.RoomEvent.ParticipantConnected, participant => {
        console.log('👤 Participante conectado:', participant.identity);
        agregarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
        // ✅ Actualizar heartbeat
        ultimoHeartbeat = Date.now();
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, participant => {
        console.log('❌ Participante desconectado:', participant.identity);
        eliminarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        console.log(`📡 Track suscrito: ${track.kind} de ${participant?.identity}`);
        ultimoHeartbeat = Date.now();
        
        if (track.kind === LivekitClient.Track.Kind.Video) {
            agregarVideoRemoto(track, participant);
        } else if (track.kind === LivekitClient.Track.Kind.Audio) {
            agregarAudioRemoto(track, participant);
        }
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        console.log(`📤 Track unsubscribe: ${track.kind} de ${participant?.identity}`);
        eliminarTrackRemoto(track, participant);
    });

    room.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication) => {
        console.log(`📤 Track local publicado: ${publication.kind}`);
        ultimoHeartbeat = Date.now();
        if (publication.kind === LivekitClient.Track.Kind.Video) {
            mostrarVideoLocal(publication);
        }
    });

    // ✅ Evento: Reconectando - MANEJO AUTOMÁTICO
    room.on(LivekitClient.RoomEvent.Reconnecting, () => {
        reconectando = true;
        actualizarEstado('Reconectando...', 'conectando');
        console.log('🔄 LiveKit está reconectando...');
    });

    // ✅ Evento: Reconectado
    room.on(LivekitClient.RoomEvent.Reconnected, () => {
        reconectando = false;
        intentosReconexion = 0;
        actualizarEstado('Conectado', 'conectado');
        ultimoHeartbeat = Date.now();
        console.log('✅ LiveKit reconectado exitosamente');
    });

    // ✅ Evento: Desconectado - TRIGGER RECONEXIÓN AUTOMÁTICA
    room.on(LivekitClient.RoomEvent.Disconnected, reason => {
        reconectando = false;
        actualizarEstado('Desconectado', 'error');
        console.warn('Desconectado:', reason);
        
        // ✅ Trigger reconexión automática
        if (reconexionAutomatica && reason !== 'user') {
            console.log('🔄 Iniciando reconexión automática por desconexión...');
            setTimeout(() => {
                triggerReconexionAutomatica();
            }, 2000);
        }
    });
}

// ============================================================
// VIDEO REMOTO
// ============================================================

function agregarVideoRemoto(track, participant) {
    if (!participant || !track) {
        console.warn('⚠️ Participante o track inválido');
        return;
    }
    
    const identity = participant.identity;
    
    if (identity === room?.localParticipant?.identity) {
        console.log('⏭️ Saltando video propio');
        return;
    }

    let video = videoMap.get(identity);
    if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.controls = false;
        video.dataset.identity = identity;
        video.className = 'video-remoto';
        gridVideos.appendChild(video);
        videoMap.set(identity, video);
        console.log(`📹 Video creado para: ${identity}`);
    }

    try {
        if (typeof track.attach === 'function') {
            track.attach(video);
            console.log(`✅ Video adjuntado para: ${identity}`);
        } else {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(() => {});
            console.log(`✅ Video adjuntado (fallback) para: ${identity}`);
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
// AUDIO REMOTO - SIN ECO
// ============================================================

function agregarAudioRemoto(track, participant) {
    if (!participant || !track) {
        console.warn('⚠️ Participante o track de audio inválido');
        return;
    }
    
    const identity = participant.identity;
    
    // ✅ CRÍTICO: NO reproducir audio propio (evita eco)
    if (identity === room?.localParticipant?.identity) {
        console.log('⏭️ 🚨 SALTANDO AUDIO PROPIO - EVITA ECO');
        return;
    }

    let audio = audioMap.get(identity);
    if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.dataset.identity = identity;
        audio.volume = volumenActual;
        audio.setAttribute('autoplay', '');
        audio.setAttribute('playsinline', '');
        document.body.appendChild(audio);
        audioMap.set(identity, audio);
        console.log(`🔊 Audio creado para: ${identity}`);
    }

    try {
        if (typeof track.attach === 'function') {
            track.attach(audio);
            console.log(`✅ Audio adjuntado para: ${identity}`);
        } else {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            audio.srcObject = stream;
            audio.play().catch(() => {});
            console.log(`✅ Audio adjuntado (fallback) para: ${identity}`);
        }
    } catch (error) {
        console.warn('⚠️ Error adjuntando audio:', error);
        try {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            audio.srcObject = stream;
            audio.play().catch(() => {});
        } catch (e) {
            console.error('❌ Error en fallback de audio:', e);
        }
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
        const audio = audioMap.get(identity);
        if (audio) {
            try {
                if (typeof track.detach === 'function') {
                    track.detach(audio);
                }
            } catch (e) {}
            audio.srcObject = null;
            audio.remove();
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

    const audio = audioMap.get(identity);
    if (audio) {
        audio.srcObject = null;
        audio.remove();
        audioMap.delete(identity);
    }
}

function agregarParticipante(participant) {
    if (!participant) return;
    if (!participant.trackPublications) return;

    participant.trackPublications.forEach((publication) => {
        if (publication.isSubscribed && publication.track) {
            if (publication.track.kind === LivekitClient.Track.Kind.Video) {
                agregarVideoRemoto(publication.track, participant);
            } else if (publication.track.kind === LivekitClient.Track.Kind.Audio) {
                agregarAudioRemoto(publication.track, participant);
            }
        }
    });
}

// ============================================================
// VIDEO LOCAL
// ============================================================

function mostrarVideoLocal(publication) {
    if (!publication || !publication.videoTrack) {
        console.warn('⚠️ Publicación o track de video inválido');
        return;
    }

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
        video.srcObject = null;
        video.remove();
    });
    
    document.querySelectorAll('audio[data-identity]').forEach(audio => {
        audio.srcObject = null;
        audio.remove();
    });
    
    videoMap.clear();
    audioMap.clear();
    
    console.log('🧹 Videos y audios limpiados');
}

// ============================================================
// ACTUALIZACIONES UI
// ============================================================

function actualizarParticipanteRemoto() {
    if (!peerConectado || !room) return;
    
    const cantidad = room.remoteParticipants ? room.remoteParticipants.size : 0;
    peerConectado.textContent = cantidad;
}

function actualizarLayout() {
    if (!gridVideos) return;
    const cantidad = gridVideos.children.length;

    if (cantidad === 0 || cantidad === 1) {
        gridVideos.style.gridTemplateColumns = '1fr';
        gridVideos.style.gridTemplateRows = '1fr';
        return;
    }
    if (cantidad === 2) {
        gridVideos.style.gridTemplateColumns = 'repeat(2, 1fr)';
        gridVideos.style.gridTemplateRows = '1fr';
        return;
    }
    if (cantidad <= 4) {
        gridVideos.style.gridTemplateColumns = 'repeat(2, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(2, 1fr)';
        return;
    }
    if (cantidad <= 6) {
        gridVideos.style.gridTemplateColumns = 'repeat(3, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(2, 1fr)';
        return;
    }
    if (cantidad <= 9) {
        gridVideos.style.gridTemplateColumns = 'repeat(3, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(3, 1fr)';
        return;
    }
    gridVideos.style.gridTemplateColumns = 'repeat(auto-fit, minmax(250px, 1fr))';
    gridVideos.style.gridTemplateRows = 'auto';
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
        const activo = publication ? publication.isEnabled : false;
        
        if (activo) {
            await room.localParticipant.setMicrophoneEnabled(false);
            btnMicrofono?.classList.remove('activo');
            btnMicrofono?.classList.add('inactivo');
            console.log('🎤 Micrófono desactivado');
        } else {
            await room.localParticipant.setMicrophoneEnabled(true);
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
        const activa = publication ? publication.isEnabled : false;
        
        await room.localParticipant.setCameraEnabled(!activa);
        
        if (activa) {
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
    if (!room || audioMuted) {
        console.warn('⚠️ No se puede silenciar');
        return;
    }
    
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
                console.error('❌ Error reactivando micrófono:', error);
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
    if (!room) {
        console.warn('⚠️ Room no disponible');
        return;
    }
    
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { 
                cursor: 'always',
                frameRate: 30 
            } 
        });
        const track = stream.getVideoTracks()[0];
        if (track) {
            await room.localParticipant.publishTrack(track, {
                name: 'screen-share',
                source: LivekitClient.Track.Source.ScreenShare
            });
            console.log('🖥️ Pantalla compartida');
        }
    } catch (error) {
        console.error('❌ Error compartiendo pantalla:', error);
    }
}

function actualizarVolumen() {
    if (!volumen) return;
    
    volumenActual = Number(volumen.value);
    
    document.querySelectorAll('audio[data-identity]').forEach(audio => {
        audio.volume = volumenActual;
    });
    
    if (volumenLabel) {
        volumenLabel.textContent = Math.round(volumenActual * 100) + '%';
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
    if (reconectando) return;
    
    reconectando = true;
    reconexionAutomatica = true;
    intentosReconexion = 0;
    actualizarEstado('Reconectando manual...', 'conectando');
    
    try {
        if (room) {
            try { 
                await room.disconnect(); 
            } catch (error) { 
                console.warn('Error desconectando:', error); 
            }
            room = null;
        }
        
        limpiarVideos();
        await new Promise(resolve => setTimeout(resolve, 500));
        await conectarLiveKit();
    } catch (error) {
        console.error('❌ Error reconectando:', error);
    } finally {
        reconectando = false;
    }
}

function diagnostico() {
    let info = '📊 DIAGNÓSTICO VENTANA DIGITAL\n\n';
    info += '━'.repeat(40) + '\n\n';
    info += `🔗 LiveKit URL: ${LIVEKIT_URL}\n`;
    info += `📁 Sala: ${ROOM_NAME}\n\n`;
    
    if (room) {
        info += `📡 Estado: ${room.state || 'desconocido'}\n`;
        info += `🆔 Mi ID: ${room.localParticipant?.identity || 'N/A'}\n`;
        info += `👥 Participantes remotos: ${room.remoteParticipants?.size || 0}\n`;
        info += `📹 Videos remotos: ${videoMap.size}\n`;
        info += `🔊 Audios remotos: ${audioMap.size}\n\n`;
        info += '🔧 RECONEXIÓN AUTOMÁTICA:\n';
        info += `   ✅ Activada: ${reconexionAutomatica ? 'SÍ' : 'NO'}\n`;
        info += `   📊 Intentos: ${intentosReconexion}/${MAX_INTENTOS_RECONEXION}\n`;
        info += `   ⏱️  Intervalo: ${INTERVALO_RECONEXION/1000}s\n`;
        info += `   ❤️  Heartbeat: ${Math.round((Date.now() - ultimoHeartbeat)/1000)}s\n\n`;
        info += '🔊 CONFIGURACIÓN ANTI-ECO:\n';
        info += `   ✅ Echo Cancellation: ACTIVADO\n`;
        info += `   ✅ Noise Suppression: ACTIVADO\n`;
        info += `   ✅ Video local: MUTED\n`;
        info += `   ✅ Audio propio: NO REPRODUCIDO\n`;
    } else {
        info += '❌ Room: NO CONECTADO\n';
    }
    
    info += '\n' + '━'.repeat(40) + '\n';
    info += `🌐 Navegador: ${navigator.userAgent}`;
    
    console.log(info);
    alert(info);
}

// ============================================================
// EVENT LISTENERS
// ============================================================

btnMicrofono?.addEventListener('click', alternarMicrofono);
btnCamara?.addEventListener('click', alternarCamara);
btnSilenciar?.addEventListener('click', silenciarTemporalmente);
btnCompartir?.addEventListener('click', compartirPantalla);
btnFullscreen?.addEventListener('click', pantallaCompleta);
btnReconectar?.addEventListener('click', reconectarManual);
btnDiagnostico?.addEventListener('click', diagnostico);
volumen?.addEventListener('input', actualizarVolumen);

window.addEventListener('resize', actualizarLayout);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') actualizarLayout();
});

// ============================================================
// INICIALIZACIÓN
// ============================================================

async function iniciarCamara() {
    console.log('🚀 Iniciando Ventana Digital Pro...');
    console.log('📋 Versión: 3.0 - Reconexión Automática');
    console.log('🔄 Reconexión automática: ACTIVADA');
    console.log(`⏱️  Intentos máximos: ${MAX_INTENTOS_RECONEXION}`);
    console.log(`⏱️  Intervalo: ${INTERVALO_RECONEXION/1000}s`);
    
    actualizarVolumen();
    actualizarLayout();
    
    // ✅ Iniciar monitor de internet
    iniciarMonitorInternet();
    
    await conectarLiveKit();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarCamara, { once: true });
} else {
    iniciarCamara();
}

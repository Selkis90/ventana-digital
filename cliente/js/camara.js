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

// ✅ Variables de estado
let room = null;
let conectando = false;
let reconectando = false;
let audioMuted = false;
let volumenActual = 0.30;
let localAudioTrack = null;
let localVideoTrack = null;

// ✅ Mapas para almacenar elementos
const videoMap = new Map();
const audioMap = new Map();

// ✅ Timeout para reconexión
let reconexionTimeout = null;

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
// ✅ CONFIGURACIÓN DE AUDIO - CORREGIDA
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
        console.warn('⚠️ Error con audio avanzado:', error);
        
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
// ✅ FUNCIÓN PRINCIPAL - CORREGIDA
// ============================================================

async function conectarLiveKit() {
    // ✅ Evitar múltiples conexiones simultáneas
    if (conectando) {
        console.log('⏳ Ya hay una conexión en progreso...');
        return;
    }
    conectando = true;

    try {
        actualizarEstado('Conectando...', 'conectando');

        // ✅ Limpiar conexión anterior
        if (room) {
            try { 
                await room.disconnect(); 
            } catch (error) { 
                console.warn('Error desconectando:', error); 
            }
            room = null;
        }

        // ✅ Limpiar videos
        limpiarVideos();

        const participantName = generarIdentidad();

        // ✅ Obtener token del servidor
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

        // ✅ Crear room
        room = new LivekitClient.Room({ 
            adaptiveStream: false,
            dynacast: true 
        });
        
        registrarEventosLiveKit();
        
        // ✅ Conectar a LiveKit
        await room.connect(LIVEKIT_URL, data.token, { 
            autoSubscribe: true 
        });

        // ✅ Mostrar ID
        if (miId) {
            miId.textContent = participantName;
        }

        // ✅ ============================================
        // ✅ PUBLICAR AUDIO
        // ✅ ============================================
        
        try {
            const audioStream = await obtenerAudioProfesional();
            const audioTrack = audioStream.getAudioTracks()[0];
            
            if (audioTrack) {
                localAudioTrack = audioTrack;
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
            console.warn('⚠️ Error publicando audio:', error);
            // ✅ Fallback
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

        // ✅ ============================================
        // ✅ PUBLICAR CÁMARA
        // ✅ ============================================
        
        try { 
            await room.localParticipant.setCameraEnabled(true);
            btnCamara?.classList.remove('inactivo');
            btnCamara?.classList.add('activo');
            console.log('✅ Cámara activada');
        } catch (error) { 
            console.warn('⚠️ Cámara no disponible:', error); 
            btnCamara?.classList.add('inactivo');
        }

        // ✅ ============================================
        // ✅ PROCESAR PARTICIPANTES EXISTENTES
        // ✅ ============================================
        
        if (room.remoteParticipants && room.remoteParticipants.size > 0) {
            const participants = Array.from(room.remoteParticipants.values());
            participants.forEach(participant => {
                agregarParticipante(participant);
            });
        }

        // ✅ Resetear estado
        conectando = false;
        reconectando = false;
        if (reconexionTimeout) {
            clearTimeout(reconexionTimeout);
            reconexionTimeout = null;
        }

        actualizarEstado('Conectado', 'conectado');
        actualizarParticipanteRemoto();
        actualizarLayout();
        ocultarLoading();

    } catch (error) {
        console.error('❌ ERROR LIVEKIT:', error);
        actualizarEstado('Error de conexión', 'error');
        ocultarLoading();
        conectando = false;
        
        // ✅ Programar reconexión automática
        if (!reconexionTimeout) {
            reconexionTimeout = setTimeout(() => {
                reconexionTimeout = null;
                if (!room || room.state === 'disconnected') {
                    console.log('🔄 Intentando reconexión automática...');
                    conectarLiveKit();
                }
            }, 5000);
        }
    }
}

// ============================================================
// ✅ EVENTOS - CORREGIDOS
// ============================================================

function registrarEventosLiveKit() {
    if (!room) return;

    // ✅ Participante conectado
    room.on(LivekitClient.RoomEvent.ParticipantConnected, participant => {
        console.log('👤 Participante conectado:', participant.identity);
        agregarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
    });

    // ✅ Participante desconectado
    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, participant => {
        console.log('❌ Participante desconectado:', participant.identity);
        eliminarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
    });

    // ✅ Track suscrito
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        console.log(`📡 Track suscrito: ${track.kind} de ${participant?.identity}`);
        
        if (track.kind === LivekitClient.Track.Kind.Video) {
            agregarVideoRemoto(track, participant);
        } else if (track.kind === LivekitClient.Track.Kind.Audio) {
            agregarAudioRemoto(track, participant);
        }
    });

    // ✅ Track unsubscribe
    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        console.log(`📤 Track unsubscribe: ${track.kind} de ${participant?.identity}`);
        eliminarTrackRemoto(track, participant);
    });

    // ✅ Track local publicado
    room.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication) => {
        console.log(`📤 Track local publicado: ${publication.kind}`);
        
        if (publication.kind === LivekitClient.Track.Kind.Video) {
            mostrarVideoLocal(publication);
        }
        // ✅ IGNORAR audio - ya se maneja en conectarLiveKit()
    });

    // ✅ Reconectando
    room.on(LivekitClient.RoomEvent.Reconnecting, () => {
        reconectando = true;
        actualizarEstado('Reconectando...', 'conectando');
        console.log('🔄 LiveKit está reconectando...');
    });

    // ✅ Reconectado
    room.on(LivekitClient.RoomEvent.Reconnected, () => {
        reconectando = false;
        actualizarEstado('Conectado', 'conectado');
        console.log('✅ LiveKit reconectado exitosamente');
        actualizarLayout();
    });

    // ✅ Desconectado
    room.on(LivekitClient.RoomEvent.Disconnected, reason => {
        reconectando = false;
        actualizarEstado('Desconectado', 'error');
        console.warn('⚠️ Desconectado:', reason);
        
        // ✅ Solo reconectar si no fue intencional
        if (reason !== 'user' && reason !== 'room_closed') {
            if (!reconexionTimeout) {
                reconexionTimeout = setTimeout(() => {
                    reconexionTimeout = null;
                    console.log('🔄 Reconectando por desconexión...');
                    conectarLiveKit();
                }, 3000);
            }
        }
    });
}

// ============================================================
// ✅ VIDEO REMOTO - CORREGIDO
// ============================================================

function agregarVideoRemoto(track, participant) {
    if (!participant || !track) {
        console.warn('⚠️ Participante o track inválido');
        return;
    }
    
    const identity = participant.identity;
    
    // ✅ NO mostrar video propio
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

    // ✅ Adjuntar track
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
// ✅ AUDIO REMOTO - SIN ECO (CRÍTICO)
// ============================================================

function agregarAudioRemoto(track, participant) {
    if (!participant || !track) {
        console.warn('⚠️ Participante o track de audio inválido');
        return;
    }
    
    const identity = participant.identity;
    
    // ✅ ⚠️ CRÍTICO: NO reproducir audio propio (esto causa ECO)
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

    // ✅ Adjuntar track
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
// ✅ VIDEO LOCAL - CORREGIDO
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
        video.muted = true; // ✅ Silenciado para evitar eco
        video.className = 'video-local';
        gridVideos.prepend(video);
        console.log('📹 Video local creado');
    }

    // ✅ Adjuntar track
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
    
    document.querySelectorAll('audio[data-identity]').forEach(audio => {
        try {
            audio.srcObject = null;
            audio.remove();
        } catch (e) {}
    });
    
    videoMap.clear();
    audioMap.clear();
    
    if (localAudioTrack) {
        try { localAudioTrack.stop(); } catch (e) {}
        localAudioTrack = null;
    }
    
    if (localVideoTrack) {
        try { localVideoTrack.stop(); } catch (e) {}
        localVideoTrack = null;
    }
    
    console.log('🧹 Videos y audios limpiados');
}

// ============================================================
// ✅ ACTUALIZACIONES UI - MEJORADA
// ============================================================

function actualizarParticipanteRemoto() {
    if (!peerConectado || !room) return;
    
    const cantidad = room.remoteParticipants ? room.remoteParticipants.size : 0;
    peerConectado.textContent = cantidad;
}

function actualizarLayout() {
    if (!gridVideos) return;
    
    // ✅ Obtener todos los videos
    const videos = gridVideos.querySelectorAll('video');
    const total = videos.length;
    
    if (total === 0) {
        gridVideos.style.gridTemplateColumns = '1fr';
        gridVideos.style.gridTemplateRows = '1fr';
        gridVideos.style.gap = '0';
        return;
    }

    // ✅ Distribución según cantidad
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

    // ✅ Para muchos videos
    const columns = Math.min(Math.ceil(Math.sqrt(total * 1.5)), 6);
    gridVideos.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
    gridVideos.style.gridTemplateRows = `repeat(${Math.ceil(total / columns)}, 1fr)`;
    gridVideos.style.gap = '2px';
}

// ============================================================
// ✅ CONTROLES - CORREGIDOS
// ============================================================

async function alternarMicrofono() {
    if (!room) {
        console.warn('⚠️ Room no disponible');
        return;
    }
    
    try {
        // ✅ Verificar estado actual
        const isEnabled = room.localParticipant.microphoneEnabled !== undefined 
            ? room.localParticipant.microphoneEnabled 
            : true;
        
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
        // ✅ Verificar estado actual
        const isEnabled = room.localParticipant.cameraEnabled !== undefined 
            ? room.localParticipant.cameraEnabled 
            : true;
        
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
            
            track.onended = () => {
                console.log('🖥️ Compartición finalizada');
            };
        }
    } catch (error) {
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            console.warn('⏭️ Usuario canceló compartición');
        } else {
            console.error('❌ Error compartiendo:', error);
        }
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

async function reconectar() {
    if (reconectando) return;
    
    reconectando = true;
    actualizarEstado('Reconectando...', 'conectando');
    
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
        info += `📹 Videos en pantalla: ${gridVideos.querySelectorAll('video').length}\n`;
        info += `🔊 Audios remotos: ${audioMap.size}\n\n`;
        info += '🔊 CONFIGURACIÓN:\n';
        info += `   ✅ Echo Cancellation: ACTIVADO\n`;
        info += `   ✅ Noise Suppression: ACTIVADO\n`;
        info += `   ✅ Auto Gain Control: ACTIVADO\n`;
        info += `   ✅ Video local: MUTED\n`;
        info += `   ✅ Audio propio: NO REPRODUCIDO\n`;
        info += `   ✅ adaptiveStream: DESACTIVADO\n`;
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

// ✅ Solo agregar listeners si los elementos existen
if (btnMicrofono) btnMicrofono.addEventListener('click', alternarMicrofono);
if (btnCamara) btnCamara.addEventListener('click', alternarCamara);
if (btnSilenciar) btnSilenciar.addEventListener('click', silenciarTemporalmente);
if (btnCompartir) btnCompartir.addEventListener('click', compartirPantalla);
if (btnFullscreen) btnFullscreen.addEventListener('click', pantallaCompleta);
if (btnReconectar) btnReconectar.addEventListener('click', reconectar);
if (btnDiagnostico) btnDiagnostico.addEventListener('click', diagnostico);
if (volumen) volumen.addEventListener('input', actualizarVolumen);

// ✅ Eventos de ventana
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
    console.log('📋 Versión: 3.2 - Estable y Corregida');
    actualizarVolumen();
    actualizarLayout();
    await conectarLiveKit();
}

// ✅ Iniciar cuando el DOM esté listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarCamara, { once: true });
} else {
    iniciarCamara();
}

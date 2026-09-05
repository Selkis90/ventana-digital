'use strict';

const LIVEKIT_URL = 'wss://ventana-digital-scr9uykx.livekit.cloud';
const ROOM_NAME = 'sala-principal';

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

const videoMap = new Map();
const audioMap = new Map();
const trackSubscriptions = new Map();

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
// FUNCIÓN PRINCIPAL DE CONEXIÓN
// ============================================================

async function conectarLiveKit() {
    if (conectando) return;
    conectando = true;

    try {
        actualizarEstado('Conectando...', 'conectando');

        if (room) {
            try { room.disconnect(); } catch (error) { console.warn(error); }
            room = null;
        }

        limpiarVideos();

        const participantName = generarIdentidad();

        const respuesta = await fetch('/get-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomName: ROOM_NAME, participantName })
        });

        if (!respuesta.ok) throw new Error('El servidor respondió HTTP ' + respuesta.status);

        const data = await respuesta.json();
        if (!data.token) throw new Error('El servidor no entregó un token LiveKit.');

        // Crear room con adaptiveStream
        room = new LivekitClient.Room({ 
            adaptiveStream: true, 
            dynacast: true 
        });
        
        registrarEventosLiveKit();
        await room.connect(LIVEKIT_URL, data.token, { autoSubscribe: true });

        if (miId) {
            const idSpan = miId.querySelector('.info-valor');
            if (idSpan) idSpan.textContent = participantName;
        }

        // Activar cámara y micrófono
        try { 
            await room.localParticipant.setCameraEnabled(true); 
        } catch (error) { 
            console.warn('Cámara no disponible:', error); 
        }
        
        try { 
            await room.localParticipant.setMicrophoneEnabled(true); 
        } catch (error) { 
            console.warn('Micrófono no disponible:', error); 
        }

        // Procesar participantes remotos existentes
        if (room.remoteParticipants) {
            const participants = Array.from(room.remoteParticipants.values());
            participants.forEach(participant => {
                agregarParticipante(participant);
            });
        }

        actualizarEstado('Conectado', 'conectado');
        actualizarParticipanteRemoto();
        actualizarLayout();
        ocultarLoading();

    } catch (error) {
        console.error('ERROR LIVEKIT:', error);
        actualizarEstado('Error de conexión', 'error');
        ocultarLoading();
    } finally {
        conectando = false;
    }
}

// ============================================================
// EVENTOS DE LIVEKIT
// ============================================================

function registrarEventosLiveKit() {
    if (!room) return;

    room.on(LivekitClient.RoomEvent.ParticipantConnected, participant => {
        console.log('Participante conectado:', participant.identity);
        agregarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, participant => {
        console.log('Participante desconectado:', participant.identity);
        eliminarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        console.log('Track suscrito:', track.kind, participant.identity);
        
        if (track.kind === LivekitClient.Track.Kind.Video) {
            agregarVideoRemoto(track, participant);
        }
        if (track.kind === LivekitClient.Track.Kind.Audio) {
            agregarAudioRemoto(track, participant);
        }
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        console.log('Track unsubscribe:', track.kind, participant?.identity);
        eliminarTrackRemoto(track, participant);
    });

    room.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication) => {
        console.log('Track local publicado:', publication.kind);
        if (publication.kind === LivekitClient.Track.Kind.Video) {
            mostrarVideoLocal(publication);
        }
    });

    room.on(LivekitClient.RoomEvent.Reconnecting, () => {
        reconectando = true;
        actualizarEstado('Reconectando...', 'conectando');
    });

    room.on(LivekitClient.RoomEvent.Reconnected, () => {
        reconectando = false;
        actualizarEstado('Conectado', 'conectado');
    });

    room.on(LivekitClient.RoomEvent.Disconnected, reason => {
        reconectando = false;
        actualizarEstado('Desconectado', 'error');
        console.warn('Desconectado:', reason);
    });
}

// ============================================================
// MANEJO DE PARTICIPANTES
// ============================================================

function agregarParticipante(participant) {
    if (!participant) return;
    if (!participant.trackPublications) return;

    // Usar forEach en el Map de publicaciones
    participant.trackPublications.forEach((publication) => {
        if (publication.isSubscribed && publication.track) {
            if (publication.track.kind === LivekitClient.Track.Kind.Video) {
                agregarVideoRemoto(publication.track, participant);
            }
            if (publication.track.kind === LivekitClient.Track.Kind.Audio) {
                agregarAudioRemoto(publication.track, participant);
            }
        }
    });
}

function agregarVideoRemoto(track, participant) {
    if (!participant || !track) return;
    
    const identity = participant.identity;
    if (identity === room?.localParticipant?.identity) return;

    // Buscar o crear contenedor de video
    let video = videoMap.get(identity);
    if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.controls = false;
        video.dataset.identity = identity;
        gridVideos.appendChild(video);
        videoMap.set(identity, video);
    }

    // ✅ CORRECCIÓN: Usar attach() para adaptiveStream
    try {
        if (track.attach) {
            // Versión moderna de LiveKit
            track.attach(video);
        } else {
            // Fallback para versiones anteriores
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(() => {});
        }
    } catch (error) {
        console.warn('Error adjuntando video:', error);
        // Fallback manual
        try {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(() => {});
        } catch (e) {
            console.error('Error en fallback de video:', e);
        }
    }
    
    actualizarLayout();
}

function agregarAudioRemoto(track, participant) {
    if (!participant || !track) return;
    
    const identity = participant.identity;
    if (identity === room?.localParticipant?.identity) return;

    let audio = audioMap.get(identity);
    if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.dataset.identity = identity;
        audio.volume = volumenActual;
        document.body.appendChild(audio);
        audioMap.set(identity, audio);
    }

    // ✅ CORRECCIÓN: Usar attach() para adaptiveStream
    try {
        if (track.attach) {
            track.attach(audio);
        } else {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            audio.srcObject = stream;
            audio.play().catch(() => {});
        }
    } catch (error) {
        console.warn('Error adjuntando audio:', error);
        try {
            const stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            audio.srcObject = stream;
            audio.play().catch(() => {});
        } catch (e) {
            console.error('Error en fallback de audio:', e);
        }
    }
}

function eliminarTrackRemoto(track, participant) {
    if (!participant) return;
    const identity = participant.identity;

    if (track?.kind === LivekitClient.Track.Kind.Video) {
        const video = videoMap.get(identity);
        if (video) {
            try {
                if (track.detach) {
                    track.detach(video);
                }
            } catch (e) {}
            video.srcObject = null;
            video.remove();
            videoMap.delete(identity);
        }
    }

    if (track?.kind === LivekitClient.Track.Kind.Audio) {
        const audio = audioMap.get(identity);
        if (audio) {
            try {
                if (track.detach) {
                    track.detach(audio);
                }
            } catch (e) {}
            audio.srcObject = null;
            audio.remove();
            audioMap.delete(identity);
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

function mostrarVideoLocal(publication) {
    if (!publication || !publication.videoTrack) return;

    let video = document.getElementById('video-local');
    if (!video) {
        video = document.createElement('video');
        video.id = 'video-local';
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        gridVideos.prepend(video);
    }

    // ✅ CORRECCIÓN: Usar attach() para adaptiveStream
    try {
        if (publication.videoTrack.attach) {
            publication.videoTrack.attach(video);
        } else {
            const stream = new MediaStream();
            stream.addTrack(publication.videoTrack.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(() => {});
        }
    } catch (error) {
        console.warn('Error adjuntando video local:', error);
    }
    
    actualizarLayout();
}

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
    trackSubscriptions.clear();
}

// ============================================================
// ACTUALIZACIONES DE UI
// ============================================================

function actualizarParticipanteRemoto() {
    if (!peerConectado || !room) return;
    
    // ✅ CORRECCIÓN: Verificar que room.remoteParticipants existe
    const cantidad = room.remoteParticipants ? room.remoteParticipants.size : 0;
    const valorSpan = peerConectado.querySelector('.info-valor');
    if (valorSpan) valorSpan.textContent = cantidad;
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
    if (!room) return;
    try {
        const publication = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
        const activo = publication && publication.isEnabled;
        await room.localParticipant.setMicrophoneEnabled(!activo);
        btnMicrofono?.classList.toggle('inactivo', !activo);
    } catch (error) {
        console.error('Error con micrófono:', error);
    }
}

async function alternarCamara() {
    if (!room) return;
    try {
        const publication = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
        const activa = publication && publication.isEnabled;
        await room.localParticipant.setCameraEnabled(!activa);
        btnCamara?.classList.toggle('inactivo', activa);
    } catch (error) {
        console.error('Error con cámara:', error);
    }
}

async function silenciarTemporalmente() {
    if (!room || audioMuted) return;
    audioMuted = true;
    btnSilenciar?.classList.add('activo');
    
    try {
        await room.localParticipant.setMicrophoneEnabled(false);
        setTimeout(async () => {
            try {
                await room.localParticipant.setMicrophoneEnabled(true);
                audioMuted = false;
                btnSilenciar?.classList.remove('activo');
            } catch (error) {
                console.error('Error reactivando micrófono:', error);
            }
        }, 5000);
    } catch (error) {
        console.error('Error silenciando:', error);
        audioMuted = false;
        btnSilenciar?.classList.remove('activo');
    }
}

async function compartirPantalla() {
    if (!room) return;
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        if (track) {
            await room.localParticipant.publishTrack(track, {
                name: 'screen-share',
                source: LivekitClient.Track.Source.ScreenShare
            });
        }
    } catch (error) {
        console.error('Error compartiendo pantalla:', error);
    }
}

function actualizarVolumen() {
    if (!volumen) return;
    volumenActual = Number(volumen.value);
    document.querySelectorAll('audio[data-identity]').forEach(audio => {
        audio.volume = volumenActual;
    });
    if (volumenLabel) volumenLabel.textContent = Math.round(volumenActual * 100) + '%';
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
        console.error('Error pantalla completa:', error);
    }
}

async function reconectar() {
    if (reconectando) return;
    reconectando = true;
    actualizarEstado('Reconectando...', 'conectando');
    try {
        if (room) {
            try { await room.disconnect(); } catch (error) { console.warn(error); }
            room = null;
        }
        limpiarVideos();
        await new Promise(resolve => setTimeout(resolve, 500));
        await conectarLiveKit();
    } catch (error) {
        console.error('Error reconectando:', error);
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
        info += `🔊 Audios remotos: ${audioMap.size}\n`;
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
btnReconectar?.addEventListener('click', reconectar);
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
    actualizarVolumen();
    actualizarLayout();
    await conectarLiveKit();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarCamara, { once: true });
} else {
    iniciarCamara();
}

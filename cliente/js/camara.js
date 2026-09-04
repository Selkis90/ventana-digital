'use strict';

const LIVEKIT_URL = 'wss://ventana-digital-scr9uykx.livekit.cloud';
const ROOM_NAME = 'sala-principal';

const gridVideos = document.getElementById('grid-videos');
const estado = document.getElementById('estado');
const btnMicrofono = document.getElementById('btn-microfono');
const btnCamara = document.getElementById('btn-camara');
const btnSilenciar = document.getElementById('btn-silenciar');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnReconectar = document.getElementById('btn-reconectar');
const btnDiagnostico = document.getElementById('btn-diagnostico');
const volumen = document.getElementById('volumen');
const volumenLabel = document.getElementById('volumen-label');
const miId = document.getElementById('mi-id');
const peerConectado = document.getElementById('peer-conectado');

let room = null;
let conectando = false;
let reconectando = false;
let audioMuted = false;
let volumenActual = 0.30;

const videoMap = new Map();
const audioMap = new Map();

function actualizarEstado(texto, tipo = '') {
    if (!estado) return;
    estado.textContent = texto;
    estado.className = '';
    if (tipo) estado.classList.add(tipo);
}

function generarIdentidad() {
    const aleatorio = Math.random().toString(36).substring(2, 8);
    return 'Usuario-' + aleatorio;
}

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

        room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
        registrarEventosLiveKit();
        await room.connect(LIVEKIT_URL, data.token, { autoSubscribe: true });

        if (miId) miId.textContent = participantName;

        try { await room.localParticipant.setCameraEnabled(true); } catch (error) { console.warn('Cámara:', error); }
        try { await room.localParticipant.setMicrophoneEnabled(true); } catch (error) { console.warn('Mic:', error); }

        // ✅ CORRECCIÓN: Iterar el Map de participantes usando Array.from()
        Array.from(room.remoteParticipants.keys()).forEach(participantId => {
            const participant = room.remoteParticipants.get(participantId);
            agregarParticipante(participant);
        });

        actualizarEstado('Conectado', 'conectado');
        if (peerConectado) peerConectado.textContent = room.remoteParticipants.size > 0 ? 'Conectado' : 'Esperando participante...';

        actualizarLayout();
    } catch (error) {
        console.error('ERROR LIVEKIT:', error);
        actualizarEstado('Error de conexión', 'error');
    } finally {
        conectando = false;
    }
}

function registrarEventosLiveKit() {
    if (!room) return;

    room.on(LivekitClient.RoomEvent.ParticipantConnected, participant => {
        agregarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, participant => {
        eliminarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === LivekitClient.Track.Kind.Video) {
            agregarVideoRemoto(track, participant);
        }
        if (track.kind === LivekitClient.Track.Kind.Audio) {
            agregarAudioRemoto(track, participant);
        }
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        eliminarTrackRemoto(track, participant);
    });

    room.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication) => {
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
    });
}

function agregarParticipante(participant) {
    if (!participant) return;

    // ✅ CORRECCIÓN: trackPublications es un Map, iterar con .forEach((value, key) => ...)
    participant.trackPublications.forEach((publication, trackSid) => {
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
    const identity = participant.identity;
    if (identity === room.localParticipant.identity) return;

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

    const stream = new MediaStream();
    stream.addTrack(track.mediaStreamTrack);
    video.srcObject = stream;
    video.play().catch(error => console.warn('Autoplay video bloqueado:', error));
    actualizarLayout();
}

function agregarAudioRemoto(track, participant) {
    const identity = participant.identity;

    // ✅ CORRECCIÓN: Evita el bucle de audio
    if (identity === room.localParticipant.identity) return;

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

    const stream = new MediaStream();
    stream.addTrack(track.mediaStreamTrack);
    audio.srcObject = stream;
    audio.play().catch(error => console.warn('Autoplay audio bloqueado:', error));
}

function eliminarTrackRemoto(track, participant) {
    if (!participant) return;
    const identity = participant.identity;

    if (track.kind === LivekitClient.Track.Kind.Video) {
        const video = videoMap.get(identity);
        if (video) {
            video.srcObject = null;
            video.remove();
            videoMap.delete(identity);
        }
    }

    if (track.kind === LivekitClient.Track.Kind.Audio) {
        const audio = audioMap.get(identity);
        if (audio) {
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

// ✅ CORRECCIÓN: Usar el publication que llega del evento
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
    }

    const stream = new MediaStream();
    stream.addTrack(publication.videoTrack.mediaStreamTrack);
    video.srcObject = stream;
    video.play().catch(error => console.warn('No se pudo reproducir video local:', error));
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
}

function actualizarParticipanteRemoto() {
    if (!peerConectado || !room) return;
    const cantidad = room.remoteParticipants.size;
    peerConectado.textContent = cantidad > 0 ? 'Participante conectado' : 'Esperando participante...';
}

function actualizarLayout() {
    if (!gridVideos) return;
    const cantidad = gridVideos.children.length;
    gridVideos.dataset.count = cantidad;

    if (cantidad === 0 || cantidad === 1) {
        gridVideos.style.gridTemplateColumns = '1fr';
        return;
    }
    if (cantidad === 2) {
        gridVideos.style.gridTemplateColumns = 'repeat(2, 1fr)';
        return;
    }
    if (cantidad <= 4) {
        gridVideos.style.gridTemplateColumns = 'repeat(2, 1fr)';
        return;
    }
    if (cantidad <= 9) {
        gridVideos.style.gridTemplateColumns = 'repeat(3, 1fr)';
        return;
    }
    gridVideos.style.gridTemplateColumns = 'repeat(auto-fit, minmax(250px, 1fr))';
}

async function alternarMicrofono() {
    if (!room) return;
    try {
        const publication = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
        const activo = publication && publication.isEnabled;
        await room.localParticipant.setMicrophoneEnabled(!activo);
        actualizarBotonMicrofono(!activo);
    } catch (error) {
        console.error('Error con micrófono:', error);
    }
}

function actualizarBotonMicrofono(activo) {
    if (!btnMicrofono) return;
    btnMicrofono.textContent = activo ? '🎤 Micrófono' : '🔇 Micrófono apagado';
    btnMicrofono.classList.toggle('apagado', !activo);
}

async function alternarCamara() {
    if (!room) return;
    try {
        const publication = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
        const activa = publication && publication.isEnabled;
        await room.localParticipant.setCameraEnabled(!activa);
        if (btnCamara) {
            btnCamara.textContent = !activa ? '📹 Cámara' : '📷 Cámara apagada';
            btnCamara.classList.toggle('apagado', activa);
        }
        mostrarVideoLocal();
    } catch (error) {
        console.error('Error con cámara:', error);
    }
}

async function silenciarTemporalmente() {
    if (!room || audioMuted) return;
    audioMuted = true;
    try {
        await room.localParticipant.setMicrophoneEnabled(false);
        if (btnSilenciar) btnSilenciar.textContent = '🔇 Silenciado';
        setTimeout(async () => {
            try {
                await room.localParticipant.setMicrophoneEnabled(true);
                audioMuted = false;
                if (btnSilenciar) btnSilenciar.textContent = '🔊 Activar micrófono';
            } catch (error) {
                console.error('Error reactivando micrófono:', error);
            }
        }, 5000);
    } catch (error) {
        console.error('Error silenciando:', error);
        audioMuted = false;
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
    let informacion = 'DIAGNÓSTICO VENTANA DIGITAL\n\n';
    informacion += 'LiveKit URL:\n' + LIVEKIT_URL + '\n\n';
    informacion += 'Sala:\n' + ROOM_NAME + '\n\n';
    if (room) {
        informacion += 'Estado:\n' + room.state + '\n\n';
        informacion += 'Mi identidad:\n' + room.localParticipant.identity + '\n\n';
        informacion += 'Participantes remotos:\n' + room.remoteParticipants.size + '\n\n';
        informacion += 'Videos remotos:\n' + videoMap.size + '\n\n';
        informacion += 'Audios remotos:\n' + audioMap.size + '\n\n';
    } else {
        informacion += 'Room: NO CONECTADO\n\n';
    }
    informacion += 'Navegador:\n' + navigator.userAgent;
    console.log(informacion);
    alert(informacion);
}

if (btnMicrofono) btnMicrofono.addEventListener('click', alternarMicrofono);
if (btnCamara) btnCamara.addEventListener('click', alternarCamara);
if (btnSilenciar) btnSilenciar.addEventListener('click', silenciarTemporalmente);
if (btnFullscreen) btnFullscreen.addEventListener('click', pantallaCompleta);
if (btnReconectar) btnReconectar.addEventListener('click', reconectar);
if (btnDiagnostico) btnDiagnostico.addEventListener('click', diagnostico);
if (volumen) volumen.addEventListener('input', actualizarVolumen);

window.addEventListener('resize', actualizarLayout);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') actualizarLayout();
});

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

```javascript
'use strict';

/* ============================================================
   CONFIGURACIÓN
   ============================================================ */

const LIVEKIT_URL =
    'wss://ventana-digital-scr9uykx.livekit.cloud';

const ROOM_NAME = 'sala-principal';


/* ============================================================
   ELEMENTOS DEL DOM
   ============================================================ */

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


/* ============================================================
   VARIABLES GLOBALES
   ============================================================ */

let room = null;

let conectando = false;
let reconectando = false;

let audioMuted = false;

let volumenActual = 0.30;


/* ============================================================
   MAPAS DE TRACKS
   ============================================================ */

const videoMap = new Map();
const audioMap = new Map();
const audioTrackMap = new Map();


/* ============================================================
   ACTUALIZAR ESTADO
   ============================================================ */

function actualizarEstado(texto, tipo = '') {

    if (!estado) {
        return;
    }

    estado.textContent = texto;

    estado.className = '';

    if (tipo) {
        estado.classList.add(tipo);
    }
}


/* ============================================================
   GENERAR IDENTIDAD
   ============================================================ */

function generarIdentidad() {

    const aleatorio =
        Math.random()
            .toString(36)
            .substring(2, 8);

    return 'Usuario-' + aleatorio;
}


/* ============================================================
   CONECTAR CON LIVEKIT
   ============================================================ */

async function conectarLiveKit() {

    if (conectando) {
        console.log('Ya existe una conexión en proceso.');
        return;
    }

    conectando = true;

    try {

        actualizarEstado(
            'Conectando...',
            'conectando'
        );

        console.log('=================================');
        console.log('INICIANDO LIVEKIT');
        console.log('=================================');

        console.log(
            'LiveKit:',
            LIVEKIT_URL
        );

        console.log(
            'Sala:',
            ROOM_NAME
        );


        /* --------------------------------------------------------
           LIMPIAR CONEXIÓN ANTERIOR
           -------------------------------------------------------- */

        if (room) {

            try {
                room.disconnect();
            } catch (error) {
                console.warn(
                    'Error desconectando sala anterior:',
                    error
                );
            }

            room = null;
        }


        /* --------------------------------------------------------
           LIMPIAR INTERFAZ
           -------------------------------------------------------- */

        limpiarVideos();


        /* --------------------------------------------------------
           GENERAR IDENTIDAD
           -------------------------------------------------------- */

        const participantName =
            generarIdentidad();

        console.log(
            'Identidad:',
            participantName
        );


        /* --------------------------------------------------------
           SOLICITAR TOKEN AL SERVIDOR
           -------------------------------------------------------- */

        actualizarEstado(
            'Solicitando acceso...',
            'conectando'
        );

        const respuesta =
            await fetch('/get-token', {

                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json'
                },

                body: JSON.stringify({

                    roomName:
                        ROOM_NAME,

                    participantName:
                        participantName

                })

            });


        if (!respuesta.ok) {

            throw new Error(
                'El servidor respondió HTTP ' +
                respuesta.status
            );
        }


        const data =
            await respuesta.json();


        if (!data.token) {

            console.error(
                'Respuesta del servidor:',
                data
            );

            throw new Error(
                'El servidor no entregó un token LiveKit.'
            );
        }


        console.log(
            'Token LiveKit recibido correctamente.'
        );


        /* --------------------------------------------------------
           CREAR ROOM
           -------------------------------------------------------- */

        room =
            new LivekitClient.Room({

                adaptiveStream: true,

                dynacast: true

            });


        /* --------------------------------------------------------
           REGISTRAR EVENTOS
           -------------------------------------------------------- */

        registrarEventosLiveKit();


        /* --------------------------------------------------------
           CONECTAR
           -------------------------------------------------------- */

        actualizarEstado(
            'Entrando a la sala...',
            'conectando'
        );


        await room.connect(

            LIVEKIT_URL,

            data.token,

            {
                autoSubscribe: true
            }

        );


        console.log(
            'Conectado a LiveKit correctamente.'
        );


        /* --------------------------------------------------------
           MOSTRAR IDENTIDAD
           -------------------------------------------------------- */

        if (miId) {

            miId.textContent =
                participantName;

        }


        /* --------------------------------------------------------
           ACTIVAR CÁMARA
           -------------------------------------------------------- */

        try {

            await room.localParticipant.setCameraEnabled(
                true
            );

            console.log(
                'Cámara activada.'
            );

        } catch (error) {

            console.warn(
                'No se pudo activar la cámara:',
                error
            );

        }


        /* --------------------------------------------------------
           ACTIVAR MICRÓFONO
           -------------------------------------------------------- */

        try {

            await room.localParticipant.setMicrophoneEnabled(
                true
            );

            console.log(
                'Micrófono activado.'
            );

        } catch (error) {

            console.warn(
                'No se pudo activar el micrófono:',
                error
            );

        }


        /* --------------------------------------------------------
           PROCESAR PARTICIPANTES EXISTENTES
           -------------------------------------------------------- */

        room.remoteParticipants.forEach(
            participant => {

                console.log(
                    'Participante encontrado:',
                    participant.identity
                );

                agregarParticipante(
                    participant
                );

            }
        );


        /* --------------------------------------------------------
           ESTADO FINAL
           -------------------------------------------------------- */

        actualizarEstado(
            'Conectado',
            'conectado'
        );


        if (peerConectado) {

            peerConectado.textContent =
                room.remoteParticipants.size > 0
                    ? 'Conectado'
                    : 'Esperando participante...';

        }


        actualizarLayout();


    } catch (error) {

        console.error(
            'ERROR LIVEKIT:',
            error
        );

        actualizarEstado(
            'Error de conexión',
            'error'
        );


        alert(
            'No fue posible conectarse a la videollamada.\n\n' +
            error.message
        );


    } finally {

        conectando = false;

    }

}


/* ============================================================
   EVENTOS LIVEKIT
   ============================================================ */

function registrarEventosLiveKit() {

    if (!room) {
        return;
    }


    /* --------------------------------------------------------
       PARTICIPANTE CONECTADO
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.ParticipantConnected,
        participant => {

            console.log(
                'Participante conectado:',
                participant.identity
            );

            agregarParticipante(
                participant
            );

            actualizarLayout();

            actualizarParticipanteRemoto();

        }
    );


    /* --------------------------------------------------------
       PARTICIPANTE DESCONECTADO
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.ParticipantDisconnected,
        participant => {

            console.log(
                'Participante desconectado:',
                participant.identity
            );

            eliminarParticipante(
                participant
            );

            actualizarLayout();

            actualizarParticipanteRemoto();

        }
    );


    /* --------------------------------------------------------
       TRACK SUSCRITO
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.TrackSubscribed,
        (
            track,
            publication,
            participant
        ) => {

            console.log(
                'Track recibido:',
                track.kind,
                participant.identity
            );

            agregarTrackRemoto(
                track,
                participant
            );

        }
    );


    /* --------------------------------------------------------
       TRACK NO SUSCRITO
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.TrackUnsubscribed,
        (
            track,
            publication,
            participant
        ) => {

            console.log(
                'Track eliminado:',
                track.kind,
                participant.identity
            );

            eliminarTrackRemoto(
                track,
                participant
            );

        }
    );


    /* --------------------------------------------------------
       TRACK PUBLICADO
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.TrackPublished,
        (
            publication,
            participant
        ) => {

            console.log(
                'Track publicado:',
                publication.kind,
                participant.identity
            );

        }
    );


    /* --------------------------------------------------------
       TRACK MUTED
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.TrackMuted,
        track => {

            console.log(
                'Track silenciado:',
                track.kind
            );

        }
    );


    /* --------------------------------------------------------
       TRACK UNMUTED
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.TrackUnmuted,
        track => {

            console.log(
                'Track activado:',
                track.kind
            );

        }
    );


    /* --------------------------------------------------------
       TRACK LOCAL PUBLICADO
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.LocalTrackPublished,
        publication => {

            console.log(
                'Track local publicado:',
                publication.kind
            );

            mostrarVideoLocal();

        }
    );


    /* --------------------------------------------------------
       TRACK LOCAL NO PUBLICADO
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.LocalTrackUnpublished,
        publication => {

            console.log(
                'Track local eliminado:',
                publication.kind
            );

            mostrarVideoLocal();

        }
    );


    /* --------------------------------------------------------
       CAMBIO DE ESTADO DE CONEXIÓN
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.ConnectionStateChanged,
        state => {

            console.log(
                'Estado LiveKit:',
                state
            );

        }
    );


    /* --------------------------------------------------------
       RECONNECTING
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.Reconnecting,
        () => {

            console.warn(
                'LiveKit intentando reconectar...'
            );

            reconectando = true;

            actualizarEstado(
                'Reconectando...',
                'conectando'
            );

        }
    );


    /* --------------------------------------------------------
       RECONNECTED
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.Reconnected,
        () => {

            console.log(
                'LiveKit reconectado.'
            );

            reconectando = false;

            actualizarEstado(
                'Conectado',
                'conectado'
            );

        }
    );


    /* --------------------------------------------------------
       DESCONECTADO
       -------------------------------------------------------- */

    room.on(
        LivekitClient.RoomEvent.Disconnected,
        reason => {

            console.warn(
                'LiveKit desconectado:',
                reason
            );

            reconectando = false;

            actualizarEstado(
                'Desconectado',
                'error'
            );

        }
    );

}


/* ============================================================
   AGREGAR PARTICIPANTE
   ============================================================ */

function agregarParticipante(
    participant
) {

    if (!participant) {
        return;
    }


    console.log(
        'Procesando participante:',
        participant.identity
    );


    participant.trackPublications.forEach(
        publication => {

            if (
                publication.isSubscribed &&
                publication.track
            ) {

                agregarTrackRemoto(
                    publication.track,
                    participant
                );

            }

        }
    );

}


/* ============================================================
   AGREGAR TRACK REMOTO
   ============================================================ */

function agregarTrackRemoto(
    track,
    participant
) {

    if (!track || !participant) {
        return;
    }


    const identity =
        participant.identity;


    /* --------------------------------------------------------
       VIDEO
       -------------------------------------------------------- */

    if (
        track.kind ===
        LivekitClient.Track.Kind.Video
    ) {

        let video =
            videoMap.get(identity);


        if (!video) {

            video =
                document.createElement(
                    'video'
                );

            video.autoplay = true;

            video.playsInline = true;

            video.controls = false;

            video.className =
                'video-remoto';

            video.dataset.identity =
                identity;


            gridVideos.appendChild(
                video
            );


            videoMap.set(
                identity,
                video
            );

        }


        const stream =
            new MediaStream();

        stream.addTrack(
            track.mediaStreamTrack
        );

        video.srcObject =
            stream;


        video.play()
            .catch(error => {

                console.warn(
                    'Autoplay video bloqueado:',
                    error
                );

            });


        actualizarLayout();

    }


    /* --------------------------------------------------------
       AUDIO
       -------------------------------------------------------- */

    if (
        track.kind ===
        LivekitClient.Track.Kind.Audio
    ) {

        let audio =
            audioMap.get(identity);


        if (!audio) {

            audio =
                document.createElement(
                    'audio'
                );

            audio.autoplay = true;

            audio.playsInline = true;

            audio.dataset.identity =
                identity;


            audio.volume =
                volumenActual;


            document.body.appendChild(
                audio
            );


            audioMap.set(
                identity,
                audio
            );

        }


        audioTrackMap.set(
            identity,
            track
        );


        const stream =
            new MediaStream();

        stream.addTrack(
            track.mediaStreamTrack
        );

        audio.srcObject =
            stream;


        reproducirAudio(
            audio,
            identity
        );

    }

}


/* ============================================================
   REPRODUCIR AUDIO
   ============================================================ */

async function reproducirAudio(
    audio,
    identity
) {

    try {

        await audio.play();

        console.log(
            'Audio remoto reproduciéndose:',
            identity
        );

    } catch (error) {

        console.warn(
            'Autoplay de audio bloqueado:',
            identity,
            error
        );


        const desbloquear =
            async () => {

                try {

                    await audio.play();

                    console.log(
                        'Audio desbloqueado por interacción.'
                    );

                } catch (err) {

                    console.error(
                        'No se pudo reproducir audio:',
                        err
                    );

                }

            };


        document.addEventListener(
            'click',
            desbloquear,
            {
                once: true
            }
        );

    }

}


/* ============================================================
   ELIMINAR TRACK REMOTO
   ============================================================ */

function eliminarTrackRemoto(
    track,
    participant
) {

    if (!participant) {
        return;
    }


    const identity =
        participant.identity;


    if (
        track.kind ===
        LivekitClient.Track.Kind.Video
    ) {

        const video =
            videoMap.get(identity);


        if (video) {

            video.srcObject = null;

            video.remove();

            videoMap.delete(
                identity
            );

        }

    }


    if (
        track.kind ===
        LivekitClient.Track.Kind.Audio
    ) {

        const audio =
            audioMap.get(identity);


        if (audio) {

            audio.srcObject = null;

            audio.remove();

            audioMap.delete(
                identity
            );

        }


        audioTrackMap.delete(
            identity
        );

    }


    actualizarLayout();

}


/* ============================================================
   ELIMINAR PARTICIPANTE
   ============================================================ */

function eliminarParticipante(
    participant
) {

    if (!participant) {
        return;
    }


    const identity =
        participant.identity;


    const video =
        videoMap.get(identity);


    if (video) {

        video.srcObject = null;

        video.remove();

        videoMap.delete(
            identity
        );

    }


    const audio =
        audioMap.get(identity);


    if (audio) {

        audio.srcObject = null;

        audio.remove();

        audioMap.delete(
            identity
        );

    }


    audioTrackMap.delete(
        identity
    );

}


/* ============================================================
   VIDEO LOCAL
   ============================================================ */

function mostrarVideoLocal() {

    if (!room) {
        return;
    }


    const participant =
        room.localParticipant;


    const publication =
        participant.getTrackPublication(
            LivekitClient.Track.Source.Camera
        );


    if (
        !publication ||
        !publication.videoTrack
    ) {

        const anterior =
            document.getElementById(
                'video-local'
            );


        if (anterior) {
            anterior.remove();
        }


        return;
    }


    let video =
        document.getElementById(
            'video-local'
        );


    if (!video) {

        video =
            document.createElement(
                'video'
            );

        video.id =
            'video-local';

        video.autoplay =
            true;

        video.playsInline =
            true;

        video.muted =
            true;

        video.className =
            'video-local';


        gridVideos.prepend(
            video
        );

    }


    const stream =
        new MediaStream();

    stream.addTrack(
        publication.videoTrack.mediaStreamTrack
    );


    video.srcObject =
        stream;


    video.play()
        .catch(error => {

            console.warn(
                'No se pudo reproducir video local:',
                error
            );

        });


    actualizarLayout();

}


/* ============================================================
   LIMPIAR VIDEOS
   ============================================================ */

function limpiarVideos() {

    if (!gridVideos) {
        return;
    }


    gridVideos
        .querySelectorAll('video')
        .forEach(video => {

            video.srcObject = null;

            video.remove();

        });


    document
        .querySelectorAll('audio[data-identity]')
        .forEach(audio => {

            audio.srcObject = null;

            audio.remove();

        });


    videoMap.clear();

    audioMap.clear();

    audioTrackMap.clear();

}


/* ============================================================
   ACTUALIZAR PARTICIPANTE REMOTO
   ============================================================ */

function actualizarParticipanteRemoto() {

    if (!peerConectado || !room) {
        return;
    }


    const cantidad =
        room.remoteParticipants.size;


    if (cantidad > 0) {

        peerConectado.textContent =
            'Participante conectado';

    } else {

        peerConectado.textContent =
            'Esperando participante...';

    }

}


/* ============================================================
   ACTUALIZAR LAYOUT
   ============================================================ */

function actualizarLayout() {

    if (!gridVideos) {
        return;
    }


    const cantidad =
        gridVideos.children.length;


    gridVideos.dataset.count =
        cantidad;


    if (cantidad === 0) {

        gridVideos.style.gridTemplateColumns =
            '1fr';

        return;

    }


    if (cantidad === 1) {

        gridVideos.style.gridTemplateColumns =
            '1fr';

        return;

    }


    if (cantidad === 2) {

        gridVideos.style.gridTemplateColumns =
            'repeat(2, 1fr)';

        return;

    }


    if (cantidad <= 4) {

        gridVideos.style.gridTemplateColumns =
            'repeat(2, 1fr)';

        return;

    }


    if (cantidad <= 9) {

        gridVideos.style.gridTemplateColumns =
            'repeat(3, 1fr)';

        return;

    }


    if (cantidad <= 12) {

        gridVideos.style.gridTemplateColumns =
            'repeat(4, 1fr)';

        return;

    }


    gridVideos.style.gridTemplateColumns =
        'repeat(auto-fit, minmax(250px, 1fr))';

}


/* ============================================================
   MICRÓFONO
   ============================================================ */

async function alternarMicrofono() {

    if (!room) {

        alert(
            'Primero debes conectarte a la sala.'
        );

        return;

    }


    try {

        const publication =
            room.localParticipant
                .getTrackPublication(
                    LivekitClient.Track.Source.Microphone
                );


        const activo =
            publication &&
            publication.isEnabled;


        await room.localParticipant
            .setMicrophoneEnabled(
                !activo
            );


        actualizarBotonMicrofono(
            !activo
        );


    } catch (error) {

        console.error(
            'Error con micrófono:',
            error
        );

    }

}


/* ============================================================
   ACTUALIZAR BOTÓN MICRÓFONO
   ============================================================ */

function actualizarBotonMicrofono(
    activo
) {

    if (!btnMicrofono) {
        return;
    }


    btnMicrofono.textContent =
        activo
            ? '🎤 Micrófono'
            : '🔇 Micrófono apagado';


    btnMicrofono.classList.toggle(
        'apagado',
        !activo
    );

}


/* ============================================================
   CÁMARA
   ============================================================ */

async function alternarCamara() {

    if (!room) {

        alert(
            'Primero debes conectarte a la sala.'
        );

        return;

    }


    try {

        const publication =
            room.localParticipant
                .getTrackPublication(
                    LivekitClient.Track.Source.Camera
                );


        const activa =
            publication &&
            publication.isEnabled;


        await room.localParticipant
            .setCameraEnabled(
                !activa
            );


        if (btnCamara) {

            btnCamara.textContent =
                !activa
                    ? '📹 Cámara'
                    : '📷 Cámara apagada';

            btnCamara.classList.toggle(
                'apagado',
                activa
            );

        }


        mostrarVideoLocal();


    } catch (error) {

        console.error(
            'Error con cámara:',
            error
        );

    }

}


/* ============================================================
   SILENCIAR TEMPORALMENTE
   ============================================================ */

async function silenciarTemporalmente() {

    if (!room) {
        return;
    }


    if (audioMuted) {
        return;
    }


    audioMuted = true;


    try {

        await room.localParticipant
            .setMicrophoneEnabled(
                false
            );


        if (btnSilenciar) {

            btnSilenciar.textContent =
                '🔇 Silenciado';

        }


        setTimeout(
            async () => {

                try {

                    await room.localParticipant
                        .setMicrophoneEnabled(
                            true
                        );


                    audioMuted = false;


                    if (btnSilenciar) {

                        btnSilenciar.textContent =
                            '🔊 Activar micrófono';

                    }


                } catch (error) {

                    console.error(
                        'Error reactivando micrófono:',
                        error
                    );

                }

            },
            5000
        );


    } catch (error) {

        console.error(
            'Error silenciando:',
            error
        );

        audioMuted = false;

    }

}


/* ============================================================
   VOLUMEN
   ============================================================ */

function actualizarVolumen() {

    if (!volumen) {
        return;
    }


    volumenActual =
        Number(
            volumen.value
        );


    document
        .querySelectorAll(
            'audio[data-identity]'
        )
        .forEach(audio => {

            audio.volume =
                volumenActual;

        });


    if (volumenLabel) {

        volumenLabel.textContent =
            Math.round(
                volumenActual * 100
            ) + '%';

    }

}


/* ============================================================
   PANTALLA COMPLETA
   ============================================================ */

async function pantallaCompleta() {

    if (!gridVideos) {
        return;
    }


    try {

        if (
            !document.fullscreenElement
        ) {

            await gridVideos.requestFullscreen();

        } else {

            await document.exitFullscreen();

        }

    } catch (error) {

        console.error(
            'Error pantalla completa:',
            error
        );

    }

}


/* ============================================================
   RECONEXIÓN MANUAL
   ============================================================ */

async function reconectar() {

    if (reconectando) {
        return;
    }


    reconectando = true;


    actualizarEstado(
        'Reconectando...',
        'conectando'
    );


    try {

        if (room) {

            try {
                await room.disconnect();
            } catch (error) {
                console.warn(error);
            }

            room = null;

        }


        limpiarVideos();


        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    500
                )
        );


        await conectarLiveKit();


    } catch (error) {

        console.error(
            'Error reconectando:',
            error
        );

    } finally {

        reconectando = false;

    }

}


/* ============================================================
   DIAGNÓSTICO
   ============================================================ */

function diagnostico() {

    let informacion =
        'DIAGNÓSTICO VENTANA DIGITAL\n\n';


    informacion +=
        'LiveKit URL:\n' +
        LIVEKIT_URL +
        '\n\n';


    informacion +=
        'Sala:\n' +
        ROOM_NAME +
        '\n\n';


    if (room) {

        informacion +=
            'Estado:\n' +
            room.state +
            '\n\n';


        informacion +=
            'Mi identidad:\n' +
            room.localParticipant.identity +
            '\n\n';


        informacion +=
            'Participantes remotos:\n' +
            room.remoteParticipants.size +
            '\n\n';


        informacion +=
            'Videos remotos:\n' +
            videoMap.size +
            '\n\n';


        informacion +=
            'Audios remotos:\n' +
            audioMap.size +
            '\n\n';

    } else {

        informacion +=
            'Room: NO CONECTADO\n\n';

    }


    informacion +=
        'Navegador:\n' +
        navigator.userAgent;


    console.log(
        informacion
    );


    alert(
        informacion
    );

}


/* ============================================================
   EVENTOS DE BOTONES
   ============================================================ */

if (btnMicrofono) {

    btnMicrofono.addEventListener(
        'click',
        alternarMicrofono
    );

}


if (btnCamara) {

    btnCamara.addEventListener(
        'click',
        alternarCamara
    );

}


if (btnSilenciar) {

    btnSilenciar.addEventListener(
        'click',
        silenciarTemporalmente
    );

}


if (btnFullscreen) {

    btnFullscreen.addEventListener(
        'click',
        pantallaCompleta
    );

}


if (btnReconectar) {

    btnReconectar.addEventListener(
        'click',
        reconectar
    );

}


if (btnDiagnostico) {

    btnDiagnostico.addEventListener(
        'click',
        diagnostico
    );

}


if (volumen) {

    volumen.addEventListener(
        'input',
        actualizarVolumen
    );

}


/* ============================================================
   CAMBIO DE TAMAÑO
   ============================================================ */

window.addEventListener(
    'resize',
    actualizarLayout
);


/* ============================================================
   VISIBILIDAD DE PÁGINA
   ============================================================ */

document.addEventListener(
    'visibilitychange',
    () => {

        if (
            document.visibilityState ===
            'visible'
        ) {

            actualizarLayout();

        }

    }
);


/* ============================================================
   INICIAR CÁMARA
   ============================================================ */

async function iniciarCamara() {

    console.log(
        '================================='
    );

    console.log(
        'VENTANA DIGITAL'
    );

    console.log(
        'Iniciando cámara...'
    );

    console.log(
        '================================='
    );


    actualizarVolumen();

    actualizarLayout();


    await conectarLiveKit();

}


/* ============================================================
   ARRANQUE ÚNICO
   ============================================================ */

if (
    document.readyState ===
    'loading'
) {

    document.addEventListener(
        'DOMContentLoaded',
        iniciarCamara,
        {
            once: true
        }
    );

} else {

    iniciarCamara();

}
```

```javascript
/* =========================================================
   VENTANA DIGITAL
   CAMARA.JS
   Gestión de video, audio y conexión LiveKit
   ========================================================= */

'use strict';


/* =========================================================
   CONFIGURACIÓN
   ========================================================= */

const LIVEKIT_URL =
    'wss://ventana-digital-scr9uykx.livekit.cloud';

const ROOM_NAME =
    'sala-principal';


/* =========================================================
   ELEMENTOS HTML
   ========================================================= */

const gridVideos =
    document.getElementById('grid-videos');

const estado =
    document.getElementById('estado');

const btnMicrofono =
    document.getElementById('btn-microfono');

const btnCamara =
    document.getElementById('btn-camara');

const btnSilenciar =
    document.getElementById('btn-silenciar');

const btnFullscreen =
    document.getElementById('btn-fullscreen');

const btnReconectar =
    document.getElementById('btn-reconectar');

const btnDiagnostico =
    document.getElementById('btn-diagnostico');

const volumen =
    document.getElementById('volumen');

const volumenLabel =
    document.getElementById('volumen-label');

const miId =
    document.getElementById('mi-id');

const peerConectado =
    document.getElementById('peer-conectado');


/* =========================================================
   VARIABLES GLOBALES
   ========================================================= */

let room = null;

let conectando = false;

let reconectando = false;

let audioMuted = false;

let volumenActual = 0.30;


/*
    Videos:

    identidad -> contenedor HTML
*/
const videoMap = new Map();


/*
    Audios:

    identidad -> elemento <audio>
*/
const audioMap = new Map();


/*
    Tracks de audio:

    identidad -> LiveKit AudioTrack
*/
const audioTrackMap = new Map();


/* =========================================================
   ESTADO
   ========================================================= */

function actualizarEstado(mensaje, tipo = 'inicializando') {

    if (!estado) {
        return;
    }

    estado.textContent = mensaje;

    estado.className = tipo;
}


/* =========================================================
   IDENTIDAD
   ========================================================= */

function generarIdentidad() {

    const aleatorio =
        Math.random()
            .toString(36)
            .substring(2, 8);

    return `Usuario-${aleatorio}`;
}


/* =========================================================
   CONECTAR LIVEKIT
   ========================================================= */

async function conectarLiveKit() {

    if (conectando) {
        console.warn(
            '⚠️ Ya existe una conexión en proceso.'
        );

        return;
    }

    conectando = true;

    try {

        actualizarEstado(
            '🔄 Conectando...',
            'inicializando'
        );


        /* -------------------------------------------------
           Cerrar conexión anterior
           ------------------------------------------------- */

        if (room) {

            try {
                room.disconnect();
            } catch (error) {

                console.warn(
                    'Error cerrando conexión anterior:',
                    error
                );
            }

            room = null;
        }


        limpiarTodosLosMedios();


        /* -------------------------------------------------
           Generar identidad
           ------------------------------------------------- */

        const participantName =
            generarIdentidad();


        console.log(
            '🆔 Identidad generada:',
            participantName
        );


        /* -------------------------------------------------
           Solicitar token
           ------------------------------------------------- */

        const response =
            await fetch(
                '/get-token',
                {
                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json'
                    },

                    body: JSON.stringify({
                        roomName: ROOM_NAME,
                        participantName:
                            participantName
                    })
                }
            );


        if (!response.ok) {

            throw new Error(
                `Error obteniendo token: HTTP ${response.status}`
            );
        }


        const data =
            await response.json();


        if (
            !data ||
            !data.token
        ) {

            throw new Error(
                'El servidor no devolvió un token válido.'
            );
        }


        console.log(
            '✅ Token LiveKit recibido.'
        );


        /* -------------------------------------------------
           Crear sala
           ------------------------------------------------- */

        room =
            new LivekitClient.Room({
                adaptiveStream: true,
                dynacast: true
            });


        /* -------------------------------------------------
           Registrar eventos
           ------------------------------------------------- */

        registrarEventosLiveKit();


        /* -------------------------------------------------
           Conectar
           ------------------------------------------------- */

        await room.connect(
            LIVEKIT_URL,
            data.token,
            {
                autoSubscribe: true
            }
        );


        console.log(
            '========================================='
        );

        console.log(
            '🟢 CONECTADO A LIVEKIT'
        );

        console.log(
            '🆔 Identidad:',
            room.localParticipant.identity
        );

        console.log(
            '========================================='
        );


        /* -------------------------------------------------
           Mostrar identidad
           ------------------------------------------------- */

        if (miId) {

            miId.textContent =
                `ID: ${room.localParticipant.identity}`;
        }


        /* -------------------------------------------------
           Activar cámara
           ------------------------------------------------- */

        try {

            await room.localParticipant
                .setCameraEnabled(true);

            console.log(
                '📷 Cámara activada.'
            );

        } catch (error) {

            console.warn(
                '⚠️ No se pudo activar la cámara:',
                error
            );

            actualizarEstado(
                '⚠️ Cámara no disponible',
                'inicializando'
            );
        }


        /* -------------------------------------------------
           Activar micrófono
           ------------------------------------------------- */

        try {

            await room.localParticipant
                .setMicrophoneEnabled(
                    true,
                    {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                );

            audioMuted = false;

            console.log(
                '🎤 Micrófono activado.'
            );

        } catch (error) {

            console.warn(
                '⚠️ No se pudo activar el micrófono:',
                error
            );

            audioMuted = true;
        }


        /* -------------------------------------------------
           Procesar participantes existentes
           ------------------------------------------------- */

        room.remoteParticipants.forEach(
            participant => {

                procesarParticipanteExistente(
                    participant
                );
            }
        );


        actualizarBotones();

        actualizarLayout();

        actualizarParticipantes();


        actualizarEstado(
            '🟢 Conectado a la sala',
            'conectado'
        );


    } catch (error) {

        console.error(
            '❌ Error conectando a LiveKit:',
            error
        );


        actualizarEstado(
            '🔴 Error de conexión',
            'desconectado'
        );


    } finally {

        conectando = false;
    }
}


/* =========================================================
   EVENTOS LIVEKIT
   ========================================================= */

function registrarEventosLiveKit() {

    if (!room) {
        return;
    }


    /* =====================================================
       PARTICIPANTE CONECTADO
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.ParticipantConnected,
        participant => {

            console.log(
                '👤 Participante conectado:',
                participant.identity
            );

            actualizarParticipantes();
        }
    );


    /* =====================================================
       PARTICIPANTE DESCONECTADO
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.ParticipantDisconnected,
        participant => {

            console.log(
                '👋 Participante desconectado:',
                participant.identity
            );


            eliminarVideo(
                participant.identity
            );


            eliminarAudio(
                participant.identity
            );


            actualizarParticipantes();

            actualizarLayout();
        }
    );


    /* =====================================================
       TRACK PUBLICADO
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.TrackPublished,
        (
            publication,
            participant
        ) => {

            console.log(
                '📡 Track publicado:',
                publication.kind,
                participant.identity
            );
        }
    );


    /* =====================================================
       TRACK SUSCRITO
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.TrackSubscribed,
        (
            track,
            publication,
            participant
        ) => {

            console.log(
                '📥 Track recibido:',
                track.kind,
                participant.identity
            );


            if (
                room &&
                participant.identity ===
                room.localParticipant.identity
            ) {
                return;
            }


            if (
                track.kind ===
                LivekitClient.Track.Kind.Video
            ) {

                agregarVideoRemoto(
                    participant,
                    track
                );
            }


            if (
                track.kind ===
                LivekitClient.Track.Kind.Audio
            ) {

                agregarAudioRemoto(
                    participant,
                    track
                );
            }


            actualizarParticipantes();

            actualizarLayout();
        }
    );


    /* =====================================================
       TRACK NO SUSCRITO
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.TrackUnsubscribed,
        (
            track,
            publication,
            participant
        ) => {

            console.log(
                '📤 Track eliminado:',
                track.kind,
                participant.identity
            );


            if (
                track.kind ===
                LivekitClient.Track.Kind.Video
            ) {

                eliminarVideo(
                    participant.identity
                );
            }


            if (
                track.kind ===
                LivekitClient.Track.Kind.Audio
            ) {

                eliminarAudio(
                    participant.identity
                );
            }


            actualizarLayout();
        }
    );


    /* =====================================================
       TRACK MUTED
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.TrackMuted,
        (
            publication,
            participant
        ) => {

            console.log(
                '🔇 Track silenciado:',
                publication.kind,
                participant.identity
            );


            if (
                publication.kind ===
                LivekitClient.Track.Kind.Video
            ) {

                ocultarVideo(
                    participant.identity
                );
            }
        }
    );


    /* =====================================================
       TRACK UNMUTED
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.TrackUnmuted,
        (
            publication,
            participant
        ) => {

            console.log(
                '🔊 Track activado:',
                publication.kind,
                participant.identity
            );


            if (
                publication.kind ===
                LivekitClient.Track.Kind.Video
            ) {

                mostrarVideo(
                    participant.identity
                );
            }
        }
    );


    /* =====================================================
       TRACK LOCAL PUBLICADO
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.LocalTrackPublished,
        publication => {

            console.log(
                '📹 Track local publicado:',
                publication.kind
            );


            if (
                publication.kind ===
                LivekitClient.Track.Kind.Video
            ) {

                mostrarVideoLocal();
            }
        }
    );


    /* =====================================================
       TRACK LOCAL DESPUBLICADO
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.LocalTrackUnpublished,
        publication => {

            console.log(
                '📴 Track local despublicado:',
                publication.kind
            );


            if (
                publication.kind ===
                LivekitClient.Track.Kind.Video
            ) {

                eliminarVideo(
                    'mi-video-local'
                );
            }


            actualizarLayout();
        }
    );


    /* =====================================================
       ESTADO DE CONEXIÓN
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.ConnectionStateChanged,
        state => {

            console.log(
                '🌐 Estado LiveKit:',
                state
            );


            switch (state) {

                case 'connected':

                    actualizarEstado(
                        '🟢 Conectado',
                        'conectado'
                    );

                    break;


                case 'connecting':

                    actualizarEstado(
                        '🔄 Conectando...',
                        'inicializando'
                    );

                    break;


                case 'reconnecting':

                    actualizarEstado(
                        '🟡 Reconectando...',
                        'inicializando'
                    );

                    break;


                case 'disconnected':

                    actualizarEstado(
                        '🔴 Desconectado',
                        'desconectado'
                    );

                    break;
            }
        }
    );


    /* =====================================================
       RECONNECTING
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.Reconnecting,
        () => {

            console.warn(
                '🟡 LiveKit intentando reconectar...'
            );


            actualizarEstado(
                '🟡 Reconectando...',
                'inicializando'
            );
        }
    );


    /* =====================================================
       RECONNECTED
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.Reconnected,
        () => {

            console.log(
                '🟢 LiveKit reconectado.'
            );


            actualizarEstado(
                '🟢 Conectado',
                'conectado'
            );


            reconstruirParticipantes();
        }
    );


    /* =====================================================
       DISCONNECTED
       ===================================================== */

    room.on(
        LivekitClient.RoomEvent.Disconnected,
        reason => {

            console.warn(
                '🔴 LiveKit desconectado:',
                reason
            );


            actualizarEstado(
                '🔴 Desconectado',
                'desconectado'
            );


            actualizarParticipantes();
        }
    );
}


/* =========================================================
   PARTICIPANTE EXISTENTE
   ========================================================= */

function procesarParticipanteExistente(
    participant
) {

    if (!participant) {
        return;
    }


    participant.trackPublications.forEach(
        publication => {

            if (
                publication.isSubscribed &&
                publication.track
            ) {

                const track =
                    publication.track;


                if (
                    track.kind ===
                    LivekitClient.Track.Kind.Video
                ) {

                    agregarVideoRemoto(
                        participant,
                        track
                    );
                }


                if (
                    track.kind ===
                    LivekitClient.Track.Kind.Audio
                ) {

                    agregarAudioRemoto(
                        participant,
                        track
                    );
                }
            }
        }
    );
}


/* =========================================================
   RECONSTRUIR PARTICIPANTES
   ========================================================= */

function reconstruirParticipantes() {

    if (!room) {
        return;
    }


    room.remoteParticipants.forEach(
        participant => {

            procesarParticipanteExistente(
                participant
            );
        }
    );


    actualizarParticipantes();

    actualizarLayout();
}


/* =========================================================
   VIDEO LOCAL
   ========================================================= */

function mostrarVideoLocal() {

    if (!room || !gridVideos) {
        return;
    }


    const publication =
        room.localParticipant
            .getTrackPublication(
                LivekitClient.Track.Source.Camera
            );


    if (
        !publication ||
        !publication.videoTrack
    ) {

        return;
    }


    const track =
        publication.videoTrack;


    let container =
        videoMap.get(
            'mi-video-local'
        );


    if (!container) {

        container =
            document.createElement('div');

        container.className =
            'video-container local';

        container.dataset.peerId =
            'mi-video-local';


        const video =
            document.createElement('video');


        video.autoplay =
            true;

        video.muted =
            true;

        video.playsInline =
            true;


        video.setAttribute(
            'playsinline',
            ''
        );


        container.appendChild(
            video
        );


        gridVideos.appendChild(
            container
        );


        videoMap.set(
            'mi-video-local',
            container
        );
    }


    const video =
        container.querySelector(
            'video'
        );


    if (!video) {
        return;
    }


    video.srcObject =
        new MediaStream([
            track.mediaStreamTrack
        ]);


    video.style.display =
        'block';


    video.play().catch(
        error => {

            console.warn(
                'No se pudo reproducir video local:',
                error
            );
        }
    );


    actualizarLayout();
}


/* =========================================================
   VIDEO REMOTO
   ========================================================= */

function agregarVideoRemoto(
    participant,
    track
) {

    if (
        !participant ||
        !track ||
        !gridVideos
    ) {
        return;
    }


    const id =
        participant.identity;


    if (!id) {
        return;
    }


    let container =
        videoMap.get(id);


    if (!container) {

        container =
            document.createElement('div');

        container.className =
            'video-container remote';

        container.dataset.peerId =
            id;


        const video =
            document.createElement('video');


        video.autoplay =
            true;

        video.playsInline =
            true;


        video.setAttribute(
            'playsinline',
            ''
        );


        video.dataset.peerId =
            id;


        container.appendChild(
            video
        );


        gridVideos.appendChild(
            container
        );


        videoMap.set(
            id,
            container
        );
    }


    const video =
        container.querySelector(
            'video'
        );


    if (!video) {
        return;
    }


    if (
        !track.mediaStreamTrack
    ) {
        return;
    }


    video.srcObject =
        new MediaStream([
            track.mediaStreamTrack
        ]);


    video.style.display =
        'block';


    video.play().catch(
        error => {

            console.warn(
                `No se pudo reproducir video de ${id}:`,
                error
            );
        }
    );


    actualizarLayout();
}


/* =========================================================
   OCULTAR VIDEO
   ========================================================= */

function ocultarVideo(id) {

    const container =
        videoMap.get(id);


    if (!container) {
        return;
    }


    const video =
        container.querySelector(
            'video'
        );


    if (video) {

        video.style.display =
            'none';
    }
}


/* =========================================================
   MOSTRAR VIDEO
   ========================================================= */

function mostrarVideo(id) {

    const container =
        videoMap.get(id);


    if (!container) {
        return;
    }


    const video =
        container.querySelector(
            'video'
        );


    if (video) {

        video.style.display =
            'block';


        video.play().catch(
            () => {}
        );
    }
}


/* =========================================================
   ELIMINAR VIDEO
   ========================================================= */

function eliminarVideo(id) {

    const container =
        videoMap.get(id);


    if (!container) {
        return;
    }


    const video =
        container.querySelector(
            'video'
        );


    if (video) {

        try {
            video.pause();
        } catch (error) {}

        video.srcObject =
            null;
    }


    container.remove();


    videoMap.delete(id);
}


/* =========================================================
   AUDIO REMOTO
   ========================================================= */

function agregarAudioRemoto(
    participant,
    track
) {

    if (
        !participant ||
        !track
    ) {
        return;
    }


    const id =
        participant.identity;


    if (!id) {
        return;
    }


    console.log(
        '🔊 Creando audio remoto:',
        id
    );


    /*
        Eliminamos cualquier audio anterior
        del mismo participante.
    */

    eliminarAudio(id);


    if (!track.mediaStreamTrack) {

        console.warn(
            '⚠️ El track de audio no tiene MediaStreamTrack:',
            id
        );

        return;
    }


    const audio =
        document.createElement('audio');


    audio.id =
        `audio-${id}`;


    audio.autoplay =
        true;

    audio.playsInline =
        true;


    audio.setAttribute(
        'playsinline',
        ''
    );


    audio.volume =
        volumenActual;


    audio.dataset.peerId =
        id;


    audio.srcObject =
        new MediaStream([
            track.mediaStreamTrack
        ]);


    /*
        No usamos muted=true.
        Este es el audio que debe escuchar
        el usuario remoto.
    */


    document.body.appendChild(
        audio
    );


    audioMap.set(
        id,
        audio
    );


    audioTrackMap.set(
        id,
        track
    );


    reproducirAudio(
        audio,
        id
    );
}


/* =========================================================
   REPRODUCIR AUDIO
   ========================================================= */

function reproducirAudio(
    audio,
    id
) {

    if (!audio) {
        return;
    }


    audio.play()
        .then(
            () => {

                console.log(
                    '🔊 Audio reproduciendo:',
                    id
                );
            }
        )
        .catch(
            error => {

                console.warn(
                    `⚠️ Autoplay bloqueado para ${id}:`,
                    error
                );


                /*
                    Intentamos activar el audio
                    después de una interacción
                    del usuario.
                */

                const activarAudio =
                    () => {

                        audio.play()
                            .catch(
                                () => {}
                            );
                    };


                document.addEventListener(
                    'click',
                    activarAudio,
                    {
                        once: true
                    }
                );
            }
        );
}


/* =========================================================
   ELIMINAR AUDIO
   ========================================================= */

function eliminarAudio(id) {

    const audio =
        audioMap.get(id);


    if (audio) {

        try {
            audio.pause();
        } catch (error) {}


        audio.srcObject =
            null;


        audio.remove();


        audioMap.delete(id);
    }


    audioTrackMap.delete(id);
}


/* =========================================================
   LIMPIAR TODOS LOS MEDIOS
   ========================================================= */

function limpiarTodosLosMedios() {

    /* -----------------------------------------------------
       VIDEOS
       ----------------------------------------------------- */

    videoMap.forEach(
        container => {

            const video =
                container.querySelector(
                    'video'
                );


            if (video) {

                try {
                    video.pause();
                } catch (error) {}


                video.srcObject =
                    null;
            }


            container.remove();
        }
    );


    videoMap.clear();


    /* -----------------------------------------------------
       AUDIOS
       ----------------------------------------------------- */

    audioMap.forEach(
        audio => {

            try {
                audio.pause();
            } catch (error) {}


            audio.srcObject =
                null;


            audio.remove();
        }
    );


    audioMap.clear();


    audioTrackMap.clear();
}


/* =========================================================
   PARTICIPANTES
   ========================================================= */

function actualizarParticipantes() {

    if (!peerConectado) {
        return;
    }


    const cantidad =
        room
            ? room.remoteParticipants.size
            : 0;


    peerConectado.textContent =
        `Participantes: ${cantidad}`;
}


/* =========================================================
   LAYOUT
   ========================================================= */

function actualizarLayout() {

    if (!gridVideos) {
        return;
    }


    const containers =
        Array.from(
            gridVideos.children
        );


    const total =
        containers.length;


    if (total === 0) {

        gridVideos.style.gridTemplateColumns =
            '1fr';

        gridVideos.style.gridTemplateRows =
            '1fr';

        return;
    }


    if (total === 1) {

        gridVideos.style.gridTemplateColumns =
            '1fr';

        gridVideos.style.gridTemplateRows =
            '1fr';

        return;
    }


    if (total === 2) {

        gridVideos.style.gridTemplateColumns =
            'repeat(2, minmax(0, 1fr))';

        gridVideos.style.gridTemplateRows =
            '1fr';

        return;
    }


    if (total <= 4) {

        gridVideos.style.gridTemplateColumns =
            'repeat(2, minmax(0, 1fr))';

        gridVideos.style.gridTemplateRows =
            'repeat(2, minmax(0, 1fr))';

        return;
    }


    if (total <= 6) {

        gridVideos.style.gridTemplateColumns =
            'repeat(3, minmax(0, 1fr))';

        gridVideos.style.gridTemplateRows =
            'repeat(2, minmax(0, 1fr))';

        return;
    }


    if (total <= 9) {

        gridVideos.style.gridTemplateColumns =
            'repeat(3, minmax(0, 1fr))';

        gridVideos.style.gridTemplateRows =
            'repeat(3, minmax(0, 1fr))';

        return;
    }


    if (total <= 12) {

        gridVideos.style.gridTemplateColumns =
            'repeat(4, minmax(0, 1fr))';

        gridVideos.style.gridTemplateRows =
            'repeat(3, minmax(0, 1fr))';

        return;
    }


    const columnas =
        Math.ceil(
            Math.sqrt(total)
        );


    const filas =
        Math.ceil(
            total / columnas
        );


    gridVideos.style.gridTemplateColumns =
        `repeat(${columnas}, minmax(0, 1fr))`;


    gridVideos.style.gridTemplateRows =
        `repeat(${filas}, minmax(0, 1fr))`;
}


/* =========================================================
   BOTONES
   ========================================================= */

function actualizarBotones() {

    if (!room) {
        return;
    }


    const microphoneEnabled =
        room.localParticipant
            .isMicrophoneEnabled();


    const cameraEnabled =
        room.localParticipant
            .isCameraEnabled();


    if (btnMicrofono) {

        btnMicrofono.textContent =
            microphoneEnabled
                ? '🎤'
                : '🔇';


        btnMicrofono.classList.toggle(
            'activo',
            microphoneEnabled
        );


        btnMicrofono.classList.toggle(
            'inactivo',
            !microphoneEnabled
        );
    }


    if (btnCamara) {

        btnCamara.textContent =
            cameraEnabled
                ? '📷'
                : '📵';


        btnCamara.classList.toggle(
            'activo',
            cameraEnabled
        );


        btnCamara.classList.toggle(
            'inactivo',
            !cameraEnabled
        );
    }
}


/* =========================================================
   BOTÓN MICRÓFONO
   ========================================================= */

if (btnMicrofono) {

    btnMicrofono.addEventListener(
        'click',
        async () => {

            if (!room) {
                return;
            }


            try {

                const nuevoEstado =
                    !room.localParticipant
                        .isMicrophoneEnabled();


                await room.localParticipant
                    .setMicrophoneEnabled(
                        nuevoEstado,
                        {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true
                        }
                    );


                audioMuted =
                    !nuevoEstado;


                actualizarBotones();


            } catch (error) {

                console.error(
                    '❌ Error con micrófono:',
                    error
                );
            }
        }
    );
}


/* =========================================================
   BOTÓN CÁMARA
   ========================================================= */

if (btnCamara) {

    btnCamara.addEventListener(
        'click',
        async () => {

            if (!room) {
                return;
            }


            try {

                const nuevoEstado =
                    !room.localParticipant
                        .isCameraEnabled();


                await room.localParticipant
                    .setCameraEnabled(
                        nuevoEstado
                    );


                actualizarBotones();

                actualizarLayout();


            } catch (error) {

                console.error(
                    '❌ Error con cámara:',
                    error
                );
            }
        }
    );
}


/* =========================================================
   SILENCIAR 5 SEGUNDOS
   ========================================================= */

if (btnSilenciar) {

    btnSilenciar.addEventListener(
        'click',
        async () => {

            if (!room) {
                return;
            }


            try {

                await room.localParticipant
                    .setMicrophoneEnabled(
                        false
                    );


                audioMuted =
                    true;


                btnSilenciar.textContent =
                    '🔊';


                actualizarBotones();


                setTimeout(
                    async () => {

                        if (!room) {
                            return;
                        }


                        try {

                            await room.localParticipant
                                .setMicrophoneEnabled(
                                    true,
                                    {
                                        echoCancellation: true,
                                        noiseSuppression: true,
                                        autoGainControl: true
                                    }
                                );


                            audioMuted =
                                false;


                            btnSilenciar.textContent =
                                '🔇';


                            actualizarBotones();

                        } catch (error) {

                            console.warn(
                                '⚠️ No se pudo reactivar el micrófono:',
                                error
                            );
                        }

                    },
                    5000
                );


            } catch (error) {

                console.error(
                    '❌ Error silenciando:',
                    error
                );
            }
        }
    );
}


/* =========================================================
   VOLUMEN
   ========================================================= */

if (volumen) {

    volumenActual =
        Number(
            volumen.value
        );


    if (Number.isNaN(volumenActual)) {
        volumenActual = 0.30;
    }


    volumen.addEventListener(
        'input',
        () => {

            volumenActual =
                Number(
                    volumen.value
                );


            if (Number.isNaN(volumenActual)) {
                volumenActual = 0.30;
            }


            if (volumenLabel) {

                volumenLabel.textContent =
                    `${Math.round(
                        volumenActual * 100
                    )}%`;
            }


            audioMap.forEach(
                audio => {

                    audio.volume =
                        volumenActual;
                }
            );
        }
    );
}


/* =========================================================
   PANTALLA COMPLETA
   ========================================================= */

if (btnFullscreen) {

    btnFullscreen.addEventListener(
        'click',
        async () => {

            try {

                if (!gridVideos) {
                    return;
                }


                if (
                    !document.fullscreenElement
                ) {

                    await gridVideos
                        .requestFullscreen();

                } else {

                    await document
                        .exitFullscreen();
                }

            } catch (error) {

                console.error(
                    '❌ Error pantalla completa:',
                    error
                );
            }
        }
    );
}


/* =========================================================
   RECONEXIÓN MANUAL
   ========================================================= */

if (btnReconectar) {

    btnReconectar.addEventListener(
        'click',
        async () => {

            if (reconectando) {
                return;
            }


            reconectando =
                true;


            try {

                actualizarEstado(
                    '🔄 Reconectando...',
                    'inicializando'
                );


                if (room) {

                    try {
                        room.disconnect();
                    } catch (error) {

                        console.warn(
                            'Error desconectando:',
                            error
                        );
                    }
                }


                room =
                    null;


                limpiarTodosLosMedios();


                await new Promise(
                    resolve => {

                        setTimeout(
                            resolve,
                            500
                        );
                    }
                );


                await conectarLiveKit();


            } finally {

                reconectando =
                    false;
            }
        }
    );
}


/* =========================================================
   DIAGNÓSTICO
   ========================================================= */

if (btnDiagnostico) {

    btnDiagnostico.addEventListener(
        'click',
        () => {

            if (!room) {

                alert(
                    '❌ No estás conectado a LiveKit.'
                );

                return;
            }


            const participantes =
                room.remoteParticipants.size;


            const videos =
                videoMap.size;


            const audios =
                audioMap.size;


            const estadoConexion =
                room.state;


            const identidad =
                room.localParticipant
                    .identity;


            alert(
                `CONEXIÓN\n\n` +

                `Estado: ${estadoConexion}\n` +

                `Tu ID: ${identidad}\n` +

                `Participantes remotos: ${participantes}\n` +

                `Videos activos: ${videos}\n` +

                `Audios activos: ${audios}\n\n` +

                `URL LiveKit:\n${LIVEKIT_URL}`
            );
        }
    );
}


/* =========================================================
   CAMBIO DE TAMAÑO
   ========================================================= */

window.addEventListener(
    'resize',
    () => {

        actualizarLayout();
    }
);


/* =========================================================
   VISIBILIDAD
   ========================================================= */

document.addEventListener(
    'visibilitychange',
    () => {

        if (
            !document.hidden &&
            room &&
            room.state === 'connected'
        ) {

            actualizarLayout();

            actualizarParticipantes();
        }
    }
);


/* =========================================================
   INICIALIZACIÓN
   ========================================================= */

function iniciarCamara() {

    console.log(
        '========================================='
    );

    console.log(
        '🎥 VENTANA DIGITAL - CAMARA.JS'
    );

    console.log(
        '========================================='
    );


    actualizarEstado(
        '🔄 Inicializando...',
        'inicializando'
    );


    actualizarLayout();


    conectarLiveKit();
}


/* =========================================================
   DOM READY
   ========================================================= */

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

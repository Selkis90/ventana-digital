// ============================================
// CONFIGURACIÓN INICIAL
// ============================================
const gridVideos = document.getElementById("grid-videos");
const estado = document.getElementById("estado");

// 🔥 Esto ya no es necesario para LiveKit, pero lo dejamos para evitar errores
// const socket = io("https://ventana-digital.onrender.com", { ... });

let room;
let isAudioMuted = false;

// ============================================
// FUNCIÓN PARA CONECTAR A LIVEKIT
// ============================================
async function conectarLiveKit() {
    try {
        const roomName = "sala-principal";
        const participantName = "Usuario-" + Math.random().toString(36).substring(7);

        // 1. Pedir token al servidor
        const response = await fetch('/get-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomName, participantName })
        });
        const data = await response.json();
        const token = data.token;

        // Obtener URL del servidor
        const livekitUrl = "wss://ventana-digital-scr9uykx.livekit.cloud"; // ⚠️ REEMPLAZA ESTO con tu URL exacta

        // 2. Conectar a la sala
        room = new LivekitClient.Room();
        await room.connect(livekitUrl, token);

        // 3. Activar cámara y micrófono
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);

        // Mostrar mi propio video
        mostrarVideoLocal();

        // 4. Escuchar cuando se unen otros
        room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'video') {
                const videoElement = document.createElement('video');
                videoElement.autoplay = true;
                videoElement.playsInline = true;
                videoElement.srcObject = new MediaStream([track.mediaStreamTrack]);
                videoElement.id = participant.identity;
                
                const container = document.createElement('div');
                container.className = 'video-container';
                container.appendChild(videoElement);
                gridVideos.appendChild(container);
            }
        });

        room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            const video = document.getElementById(participant.identity);
            if (video) video.parentElement.remove();
        });

        actualizarEstado("🟢 Conectado a la sala", "conectado");
        document.getElementById('mi-id').textContent = `ID: ${participantName}`;
    } catch (error) {
        console.error("❌ Error conectando a LiveKit:", error);
        actualizarEstado("🔴 Error de conexión", "desconectado");
    }
}

// ============================================
// MOSTRAR MI VIDEO
// ============================================
function mostrarVideoLocal() {
    const localVideo = document.createElement('video');
    localVideo.autoplay = true;
    localVideo.muted = true;
    localVideo.playsInline = true;
    localVideo.id = "mi-video-local";

    room.localParticipant.setCameraEnabled(true).then(() => {
        const trackPublication = room.localParticipant.getTrackPublication('camera');
        if (trackPublication && trackPublication.videoTrack) {
            localVideo.srcObject = new MediaStream([trackPublication.videoTrack.mediaStreamTrack]);
        }
    });

    const container = document.createElement('div');
    container.className = 'video-container local';
    container.appendChild(localVideo);
    gridVideos.appendChild(container);
}

// ============================================
// ESTADO Y CONTROLES
// ============================================
function actualizarEstado(mensaje, tipo) {
    estado.textContent = mensaje;
    estado.className = tipo || "inicializando";
}

document.getElementById('btn-microfono').addEventListener('click', () => {
    if (!room) return;
    room.localParticipant.setMicrophoneEnabled(!isAudioMuted);
    isAudioMuted = !isAudioMuted;
    document.getElementById('btn-microfono').textContent = isAudioMuted ? '🎤 Silenciado' : '🎤 Micrófono';
});

document.getElementById('btn-camara').addEventListener('click', async () => {
    if (!room) return;
    const enabled = await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled());
    document.getElementById('btn-camara').textContent = enabled ? '📷 Cámara' : '📷 Apagada';
});

document.getElementById('btn-silenciar').addEventListener('click', () => {
    // Con LiveKit, silenciar a todos no es necesario, el audio llega individual.
    // Este botón es un extra para silenciar el audio local de tu dispositivo.
    if (room) {
        room.localParticipant.setMicrophoneEnabled(false);
        document.getElementById('btn-silenciar').textContent = '🔊 Activar';
        setTimeout(() => {
            room.localParticipant.setMicrophoneEnabled(true);
            document.getElementById('btn-silenciar').textContent = '🔇 Silenciar';
        }, 5000);
    }
});

document.getElementById('btn-fullscreen').addEventListener('click', () => {
    if (gridVideos.requestFullscreen) gridVideos.requestFullscreen();
});

document.getElementById('btn-reconectar').addEventListener('click', () => {
    if (room) room.disconnect();
    setTimeout(() => conectarLiveKit(), 1000);
});

document.getElementById('btn-diagnostico').addEventListener('click', () => {
    alert(`Conectado: ${room ? room.state : 'No conectado'}\nParticipantes: ${room ? room.numParticipants : 0}`);
});

// Iniciar
conectarLiveKit();

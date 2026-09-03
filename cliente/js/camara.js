// ============================================
// CONFIGURACIÓN INICIAL
// ============================================
const gridVideos = document.getElementById("grid-videos");
const estado = document.getElementById("estado");

let room;
let isAudioMuted = false;
let currentVolume = 0.3;

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

        const livekitUrl = "wss://ventana-digital-scr9uykx.livekit.cloud";

        // 2. Conectar a la sala
        room = new LivekitClient.Room();
        await room.connect(livekitUrl, token);

        // 3. Activar cámara y micrófono
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);

        // 4. Escuchar cuando se publica MI video local
        room.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication) => {
            if (publication.kind === 'video') {
                mostrarVideoLocal();
            }
        });

        // 5. Escuchar cuando se unen otros participantes (videos remotos)
        room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'video') {
                const videoElement = document.createElement('video');
                videoElement.autoplay = true;
                videoElement.playsInline = true;
                videoElement.srcObject = new MediaStream([track.mediaStreamTrack]);
                videoElement.dataset.peerId = participant.identity;
                
                const container = document.createElement('div');
                container.className = 'video-container remote';
                container.dataset.peerId = participant.identity;
                container.appendChild(videoElement);
                gridVideos.appendChild(container);
                
                // 🔥 ORDENAR Y ACTUALIZAR LAYOUT AUTOMÁTICAMENTE
                ordenarContenedores();
                actualizarLayout();
            }
        });

        room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            const contenedor = gridVideos.querySelector(`[data-peer-id="${participant.identity}"]`);
            if (contenedor) contenedor.remove();
            ordenarContenedores();
            actualizarLayout();
        });

        actualizarEstado("🟢 Conectado a la sala", "conectado");
        document.getElementById('mi-id').textContent = `ID: ${participantName}`;
    } catch (error) {
        console.error("❌ Error conectando a LiveKit:", error);
        actualizarEstado("🔴 Error de conexión", "desconectado");
    }
}

// ============================================
// MOSTRAR MI VIDEO (CON CLASES CSS)
// ============================================
function mostrarVideoLocal() {
    const localVideo = document.createElement('video');
    localVideo.autoplay = true;
    localVideo.muted = true;
    localVideo.playsInline = true;
    localVideo.dataset.peerId = "mi-video-local";
    
    const trackPublication = room.localParticipant.getTrackPublication('camera');
    if (trackPublication && trackPublication.videoTrack) {
        localVideo.srcObject = new MediaStream([trackPublication.videoTrack.mediaStreamTrack]);
    }

    const container = document.createElement('div');
    container.className = 'video-container local';
    container.dataset.peerId = "mi-video-local";
    container.appendChild(localVideo);
    gridVideos.appendChild(container);

    ordenarContenedores();
    actualizarLayout();
}

// ============================================
// 🔥 ORDENAR Y ACTUALIZAR LAYOUT (COMO TUS EJEMPLOS)
// ============================================
function ordenarContenedores() {
    const contenedores = Array.from(gridVideos.children);
    contenedores.sort((a, b) => {
        const idA = a.dataset.peerId || '';
        const idB = b.dataset.peerId || '';
        return idA.localeCompare(idB);
    });
    contenedores.forEach(container => {
        gridVideos.appendChild(container);
    });
}

function actualizarLayout() {
    const containers = Array.from(gridVideos.children);
    const total = containers.length;
    
    containers.forEach(c => {
        c.style.position = 'static';
        c.style.width = '';
        c.style.height = '';
        c.style.left = '';
        c.style.top = '';
        c.style.zIndex = '';
        c.style.borderRadius = '';
        c.style.boxShadow = '';
        c.classList.remove('grande', 'pequeno');
    });

    document.body.classList.remove('layout-especial');

    if (total === 0) return;

    if (total === 1) {
        containers[0].style.width = '100%';
        containers[0].style.height = '100%';
        return;
    }

    if (total === 2) {
        document.body.classList.add('layout-especial');
        containers.forEach((c, i) => {
            c.style.position = 'absolute';
            c.style.top = '0';
            c.style.height = '100%';
            c.style.width = '50%';
            c.style.borderRadius = '0';
            if (i === 0) c.style.left = '0';
            else c.style.left = '50%';
        });
        return;
    }

    if (total === 3) {
        document.body.classList.add('layout-especial');
        containers.forEach((c, i) => {
            c.style.position = 'absolute';
            c.style.borderRadius = '0';
            if (i === 0) {
                c.style.top = '0';
                c.style.left = '0';
                c.style.width = '50%';
                c.style.height = '100%';
            } else {
                c.style.left = '50%';
                c.style.width = '50%';
                c.style.height = '50%';
                if (i === 1) c.style.top = '0';
                else c.style.top = '50%';
            }
        });
        return;
    }

    if (total >= 4) {
        document.body.classList.add('layout-especial');
        containers.forEach((c, i) => {
            c.style.position = 'absolute';
            c.style.width = '50%';
            c.style.height = '50%';
            c.style.borderRadius = '0';
            const col = (i % 2);
            const row = Math.floor(i / 2);
            c.style.left = `${col * 50}%`;
            c.style.top = `${row * 50}%`;
        });
        return;
    }
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
    if (room) {
        room.localParticipant.setMicrophoneEnabled(false);
        document.getElementById('btn-silenciar').textContent = '🔊 Activar';
        setTimeout(() => {
            room.localParticipant.setMicrophoneEnabled(true);
            document.getElementById('btn-silenciar').textContent = '🔇 Silenciar';
        }, 5000);
    }
});

document.getElementById('volumen').addEventListener('input', (e) => {
    currentVolume = parseFloat(e.target.value);
    document.getElementById('volumen-label').textContent = `${Math.round(currentVolume * 100)}%`;
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

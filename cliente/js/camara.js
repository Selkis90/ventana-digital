// ============================================
// CONFIGURACIÓN INICIAL
// ============================================
const gridVideos = document.getElementById("grid-videos");
const estado = document.getElementById("estado");

let room;
let isAudioMuted = false;

// ============================================
// MAPA PARA GUARDAR VIDEOS (Evita duplicados)
// ============================================
const videoMap = new Map();

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

        // 2. Conectar a la sala
        room = new LivekitClient.Room();
        await room.connect("wss://ventana-digital-scr9uykx.livekit.cloud", token);

        // 3. Activar cámara y micrófono
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);

        // 🔥 4. Mostrar MI video (usando método directo, sin trucos)
        setTimeout(() => {
            mostrarVideoLocal();
        }, 500);

        // 🔥 5. Evento para agregar videos de otros
        room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'video') {
                agregarVideoRemoto(participant, track);
            }
        });

        // 🔥 6. Cuando un track se silencia (alguien apaga cámara)
        room.on(LivekitClient.RoomEvent.TrackMuted, (publication, participant) => {
            if (publication.kind === 'video') {
                const contenedor = videoMap.get(participant.identity);
                if (contenedor) {
                    const video = contenedor.querySelector('video');
                    if (video) video.style.display = 'none';
                }
            }
        });

        // 🔥 7. Cuando un track se reactiva (alguien enciende cámara)
        room.on(LivekitClient.RoomEvent.TrackUnmuted, (publication, participant) => {
            if (publication.kind === 'video') {
                const contenedor = videoMap.get(participant.identity);
                if (contenedor) {
                    const video = contenedor.querySelector('video');
                    if (video) video.style.display = 'block';
                }
            }
        });

        // 🔥 8. Cuando alguien se va, eliminar su video
        room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            const contenedor = videoMap.get(participant.identity);
            if (contenedor) {
                contenedor.remove();
                videoMap.delete(participant.identity);
            }
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
// MOSTRAR MI VIDEO (FUNCIÓN DIRECTA)
// ============================================
function mostrarVideoLocal() {
    // Si ya existe, eliminarlo para no duplicar
    const existing = videoMap.get("mi-video-local");
    if (existing) existing.remove();

    const localVideo = document.createElement('video');
    localVideo.autoplay = true;
    localVideo.muted = true;
    localVideo.playsInline = true;
    localVideo.dataset.peerId = "mi-video-local";

    // 🔥 CONEXIÓN DIRECTA: Obtener mi track
    const localTrack = room.localParticipant.getTrackPublication('camera');
    if (localTrack && localTrack.videoTrack) {
        localVideo.srcObject = new MediaStream([localTrack.videoTrack.mediaStreamTrack]);
    } else {
        // 🔥 Si no está listo, esperar y reintentar
        setTimeout(() => {
            const localTrack = room.localParticipant.getTrackPublication('camera');
            if (localTrack && localTrack.videoTrack) {
                localVideo.srcObject = new MediaStream([localTrack.videoTrack.mediaStreamTrack]);
            }
        }, 500);
    }

    const container = document.createElement('div');
    container.className = 'video-container local';
    container.dataset.peerId = "mi-video-local";
    container.appendChild(localVideo);
    gridVideos.appendChild(container);

    // 🔥 Guardar en mapa
    videoMap.set("mi-video-local", container);

    // 🔥 ORDENAR Y ACTUALIZAR LAYOUT
    ordenarContenedores();
    actualizarLayout();
}

// ============================================
// AGREGAR VIDEO REMOTO (FUNCIÓN NUEVA)
// ============================================
function agregarVideoRemoto(participant, track) {
    // Si ya existe, no duplicar
    if (videoMap.has(participant.identity)) {
        const contenedor = videoMap.get(participant.identity);
        const video = contenedor.querySelector('video');
        video.srcObject = new MediaStream([track.mediaStreamTrack]);
        video.style.display = 'block';
        return;
    }

    const videoElement = document.createElement('video');
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.dataset.peerId = participant.identity;
    videoElement.srcObject = new MediaStream([track.mediaStreamTrack]);

    const container = document.createElement('div');
    container.className = 'video-container remote';
    container.dataset.peerId = participant.identity;
    container.appendChild(videoElement);
    gridVideos.appendChild(container);

    // 🔥 Guardar en mapa
    videoMap.set(participant.identity, container);

    // 🔥 ORDENAR Y ACTUALIZAR LAYOUT
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

    // 1 SOLO VIDEO (PANTALLA COMPLETA)
    if (total === 1) {
        containers[0].style.width = '100%';
        containers[0].style.height = '100%';
        return;
    }

    // 2 VIDEOS (50/50)
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

    // 3 VIDEOS (1 IZQUIERDA, 2 DERECHA)
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

    // 4 VIDEOS (CUADRÍCULA 2x2)
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

document.getElementById('btn-fullscreen').addEventListener('click', () => {
    if (gridVideos.requestFullscreen) gridVideos.requestFullscreen();
});

document.getElementById('btn-reconectar').addEventListener('click', () => {
    if (room) room.disconnect();
    setTimeout(() => conectarLiveKit(), 1000);
});

document.getElementById('btn-diagnostico').addEventListener('click', () => {
    if (!room) {
        alert('No estás conectado a ninguna sala.');
        return;
    }
    const participantes = room.remoteParticipants.size;
    alert(`✅ Conectado: ${room.state}\n📊 Participantes en sala: ${participantes}\n🆔 Tu ID: ${room.localParticipant.identity}`);
});

// Iniciar
conectarLiveKit();

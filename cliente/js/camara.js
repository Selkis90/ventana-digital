/* ============================================================
   VENTANA DIGITAL — CLIENTE
   ------------------------------------------------------------
   Arquitectura:
   - Un solo estado (st) y una función sincronizar() idempotente
     que reconstruye la vista a partir del estado real de LiveKit.
     Así no hay "videos fantasma" ni audios duplicados.
   - Reconexión: LiveKit resuelve los cortes cortos por sí mismo;
     si la sala se cae del todo, reintentamos con backoff exponencial.
   - Sin polling, sin setInterval: todo se mueve por eventos.
   ============================================================ */

(function () {
    'use strict';

    // ============================================================
    // CONSTANTES
    // ============================================================

    const APP_VERSION = '2.1.0';
    const CDN_RESPALDO = 'https://unpkg.com/livekit-client@2.22.3/dist/livekit-client.umd.js';
    const MAX_REINTENTOS = 8;

    const esTactil = window.matchMedia('(pointer: coarse)').matches;
    const esMovil =
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS

    let LK = null; // window.LivekitClient cuando esté cargado

    // ============================================================
    // ELEMENTOS DEL DOM
    // ============================================================

    const $ = (id) => document.getElementById(id);

    const ui = {
        lobby: $('lobby'),
        form: $('form-entrar'),
        inputNombre: $('input-nombre'),
        prefMic: $('pref-mic'),
        prefCam: $('pref-cam'),
        lobbyError: $('lobby-error'),
        btnEntrar: $('btn-entrar'),

        sala: $('sala'),
        escenario: $('escenario'),
        grid: $('grid-videos'),
        vacio: $('vacio'),
        btnInvitarVacio: $('btn-invitar-vacio'),
        estado: $('estado'),
        estadoTexto: document.querySelector('#estado .estado-texto'),

        pip: $('pip-local'),
        videoLocal: $('video-local'),
        pipIniciales: $('pip-iniciales'),

        contador: $('contador-participantes'),
        calidad: $('calidad-red'),
        btnMic: $('btn-microfono'),
        btnCam: $('btn-camara'),
        btnVoltear: $('btn-voltear'),
        btnCompartir: $('btn-compartir'),
        btnInvitar: $('btn-invitar'),
        btnSalir: $('btn-salir'),
        volumen: $('volumen'),
        volumenLabel: $('volumen-label'),
        btnFullscreen: $('btn-fullscreen'),
        btnDiag: $('btn-diagnostico'),

        salida: $('salida'),
        salidaTitulo: $('salida-titulo'),
        salidaTexto: $('salida-texto'),
        btnVolver: $('btn-volver'),
        btnInicio: $('btn-inicio'),

        avisoAudio: $('aviso-audio'),
        btnActivarAudio: $('btn-activar-audio'),

        cargando: $('loading-overlay'),
        cargandoTexto: $('loading-texto'),

        dlgDiag: $('dlg-diagnostico'),
        diagContenido: $('diag-contenido'),
        btnDiagCopiar: $('btn-diag-copiar'),
        btnDiagCerrar: $('btn-diag-cerrar'),

        toasts: $('toasts')
    };

    // Contenedor oculto para los <audio> remotos
    const contAudios = document.createElement('div');
    contAudios.id = 'audios-remotos';
    contAudios.hidden = true;
    document.body.appendChild(contAudios);

    // ============================================================
    // ESTADO
    // ============================================================

    const st = {
        room: null,
        nombre: '',
        sala: '',
        salaDefecto: 'sala-principal',
        quiereMic: true,
        quiereCam: true,
        conectando: false,
        acceso: null,       // { token, url, sala, identidad, nombre, expira }
        salidaVoluntaria: false,
        intentos: 0,
        timerReintento: null,

        tiles: new Map(),   // clave -> { clave, identidad, tipo, el, video, nombre, avatar, calidad, track }
        audios: new Map(),  // trackSid -> { el, track }
        foco: null,         // tile fijado por el usuario
        focoAuto: null,     // pantalla compartida fijada automáticamente
        focoDescartado: new Set(),

        hablando: new Set(),
        calidades: new Map(),
        volumen: 1,
        facingMode: 'user',
        wakeLock: null,

        pipTrack: null,
        pipEsquina: 'abajo-derecha',
        pipPos: { x: 0, y: 0 },
        pipColocada: false,

        ocupado: { mic: false, cam: false, pantalla: false, voltear: false },
        syncPendiente: false,
        layoutPendiente: false,
        timerEstado: null,
        ultimoAvisoCalidad: 0
    };

    // ============================================================
    // UTILIDADES
    // ============================================================

    const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    const almacen = {
        leer(clave) {
            try { return localStorage.getItem(clave); } catch (e) { return null; }
        },
        guardar(clave, valor) {
            try { localStorage.setItem(clave, valor); } catch (e) { /* modo privado */ }
        }
    };

    function nombreDe(participante) {
        return (participante && (participante.name || participante.identity)) || 'Invitado';
    }

    function iniciales(nombre) {
        const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
        if (!partes.length) return '?';
        const a = partes[0][0] || '';
        const b = partes.length > 1 ? partes[partes.length - 1][0] : (partes[0][1] || '');
        return (a + b).toUpperCase();
    }

    async function fetchConTimeout(url, opciones, ms) {
        const control = new AbortController();
        const timer = setTimeout(() => control.abort(), ms);
        try {
            return await fetch(url, Object.assign({}, opciones, { signal: control.signal }));
        } finally {
            clearTimeout(timer);
        }
    }

    function cargarScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = resolve;
            s.onerror = () => reject(new Error('No se pudo cargar ' + src));
            document.head.appendChild(s);
        });
    }

    async function asegurarLiveKit() {
        if (window.LivekitClient) return window.LivekitClient;
        console.warn('[livekit] CDN principal falló, usando respaldo…');
        try { await cargarScript(CDN_RESPALDO); } catch (e) { /* se maneja abajo */ }
        if (!window.LivekitClient) {
            throw new Error('No se pudo cargar la librería de video. Revisa tu conexión y recarga la página.');
        }
        return window.LivekitClient;
    }

    // ============================================================
    // NOTIFICACIONES, CARGA Y ESTADO
    // ============================================================

    function toast(mensaje, tipo, duracion) {
        const el = document.createElement('div');
        el.className = 'toast ' + (tipo || 'info');
        el.textContent = mensaje;
        ui.toasts.appendChild(el);

        while (ui.toasts.children.length > 3) ui.toasts.firstElementChild.remove();

        setTimeout(() => {
            el.classList.add('saliendo');
            setTimeout(() => el.remove(), 300);
        }, duracion || 3500);
    }

    function mostrarCargando(texto) {
        ui.cargandoTexto.textContent = texto || 'Conectando…';
        ui.cargando.hidden = false;
    }

    function ocultarCargando() {
        ui.cargando.hidden = true;
    }

    function actualizarEstado(texto, tipo) {
        clearTimeout(st.timerEstado);
        ui.estado.className = 'estado estado-' + (tipo || 'conectando');
        ui.estadoTexto.textContent = texto;

        const compartiendo = st.room && st.room.localParticipant.isScreenShareEnabled;
        if (tipo === 'conectado') {
            if (compartiendo) {
                ui.estadoTexto.textContent = 'Conectado · compartiendo tu pantalla';
            } else {
                st.timerEstado = setTimeout(() => ui.estado.classList.add('discreto'), 3000);
            }
        }
    }

    // ============================================================
    // VISTAS
    // ============================================================

    function mostrarLobby() {
        ui.sala.hidden = true;
        ui.salida.hidden = true;
        ui.avisoAudio.hidden = true;
        ui.form.hidden = false;
        ui.lobby.hidden = false;
    }

    function mostrarSala() {
        ui.lobby.hidden = true;
        ui.salida.hidden = true;
        ui.sala.hidden = false;
        requestAnimationFrame(() => {
            actualizarLayout();
            actualizarPip();
        });
    }

    function mostrarSalida(titulo, texto) {
        // Al salir se descarta el token; al volver se pide uno nuevo
        st.acceso = null;
        clearTimeout(st.timerReintento);
        ui.sala.hidden = true;
        ui.lobby.hidden = true;
        ui.avisoAudio.hidden = true;
        ui.salidaTitulo.textContent = titulo;
        ui.salidaTexto.textContent = texto;
        ui.salida.hidden = false;
        ocultarCargando();
    }

    function mostrarErrorLobby(mensaje) {
        ui.lobbyError.textContent = mensaje;
        ui.lobbyError.hidden = !mensaje;
    }

    function setBotonCargando(boton, cargando) {
        boton.disabled = cargando;
        boton.classList.toggle('cargando', cargando);
    }

    // ============================================================
    // MENSAJES DE ERROR LEGIBLES
    // ============================================================

    function mensajeDispositivo(error, dispositivo) {
        const nombre = (error && error.name) || '';
        const msg = ((error && error.message) || '').toLowerCase();

        if (nombre === 'NotAllowedError' || nombre === 'PermissionDeniedError' || msg.includes('permission')) {
            return `Permiso de ${dispositivo} denegado. Actívalo desde el candado 🔒 junto a la dirección de la página.`;
        }
        if (nombre === 'NotFoundError' || nombre === 'DevicesNotFoundError' || msg.includes('not found')) {
            return `No se encontró ${dispositivo} en este dispositivo.`;
        }
        if (nombre === 'NotReadableError' || nombre === 'TrackStartError' || msg.includes('in use') || msg.includes('could not start')) {
            return `El ${dispositivo} está siendo usado por otra aplicación. Ciérrala e inténtalo de nuevo.`;
        }
        if (nombre === 'OverconstrainedError') {
            return `El ${dispositivo} no soporta la configuración solicitada.`;
        }
        return `No se pudo activar el ${dispositivo}.`;
    }

    function mensajeConexion(error) {
        if (!navigator.onLine) return 'No tienes conexión a internet.';
        if (error && error.status) return error.message;
        if (error && error.name === 'AbortError') return 'El servidor tardó demasiado en responder. Inténtalo de nuevo.';
        return 'No se pudo conectar a la sala. Si estás en una red de empresa o colegio, puede estar bloqueando las videollamadas.';
    }

    // ============================================================
    // CONEXIÓN
    // ============================================================

    async function postJson(url, cuerpo, timeoutMs) {
        const resp = await fetchConTimeout(
            url,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) },
            timeoutMs
        );
        const datos = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const err = new Error(datos.error || `Error del servidor (${resp.status})`);
            err.status = resp.status;
            throw err;
        }
        return datos;
    }

    // Reutiliza el token mientras esté vigente (así las reconexiones conservan
    // la misma identidad); si venció, pide uno nuevo al servidor.
    async function obtenerAcceso() {
        const a = st.acceso;
        if (a && a.token && a.url && a.expira - Date.now() > 60000) return a;
        st.acceso = null;
        // Hasta 60 s: en Render gratis el servidor puede estar "dormido"
        const datos = await postJson('/api/token', { nombre: st.nombre }, 60000);
        st.acceso = datos;
        st.sala = datos.sala || st.salaDefecto;
        return datos;
    }

    function crearRoom() {
        const VP = LK.VideoPresets;
        const SP = LK.ScreenSharePresets;

        return new LK.Room({
            adaptiveStream: true,          // baja la calidad de videos pequeños/ocultos
            dynacast: true,                // no envía capas que nadie está viendo
            disconnectOnPageLeave: true,
            videoCaptureDefaults: {
                resolution: esMovil ? VP.h540.resolution : VP.h720.resolution,
                facingMode: 'user'
            },
            audioCaptureDefaults: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            publishDefaults: {
                simulcast: true,
                videoSimulcastLayers: [VP.h180, VP.h360],
                dtx: true,                 // ahorra datos en silencios
                red: true,                 // audio más resistente a pérdida de paquetes
                screenShareEncoding: SP && SP.h1080fps15 ? SP.h1080fps15.encoding : undefined
            }
        });
    }

    async function conectar(opciones) {
        const primeraVez = Boolean(opciones && opciones.primeraVez);
        if (st.conectando) return;

        st.conectando = true;
        st.salidaVoluntaria = false;
        clearTimeout(st.timerReintento);

        try {
            mostrarCargando(primeraVez
                ? 'Preparando la sala… si el servidor estaba dormido puede tardar hasta un minuto.'
                : 'Reconectando…');
            const datos = await obtenerAcceso();

            await destruirRoom();

            const room = crearRoom();
            st.room = room;
            registrarEventos(room);

            mostrarCargando('Conectando con el servidor de video…');
            await room.connect(datos.url, datos.token);

            st.conectando = false; // desde aquí los eventos de desconexión se manejan normal
            st.intentos = 0;
            mostrarSala();
            ocultarCargando();
            actualizarEstado('Conectado', 'conectado');

            await activarDispositivos(room);

            if (!room.canPlaybackAudio) ui.avisoAudio.hidden = false;
            solicitarWakeLock();
            actualizarBotonVoltear();
            programarSync();
        } catch (error) {
            console.error('[conexión]', error);
            ocultarCargando();

            if (primeraVez || (error && error.status && error.status < 500)) {
                await destruirRoom();
                mostrarLobby();
                mostrarErrorLobby(mensajeConexion(error));
            } else {
                programarReintento();
            }
        } finally {
            st.conectando = false;
        }
    }

    async function activarDispositivos(room) {
        const lp = room.localParticipant;

        // Pedir cámara y micrófono juntos = un solo aviso de permisos
        if (st.quiereMic && st.quiereCam) {
            try {
                await lp.enableCameraAndMicrophone();
                return;
            } catch (e) {
                console.warn('[dispositivos] Falló activación conjunta, probando por separado', e);
            }
        }

        if (st.quiereMic && !lp.isMicrophoneEnabled) {
            try {
                await lp.setMicrophoneEnabled(true);
            } catch (e) {
                toast(mensajeDispositivo(e, 'micrófono'), 'error', 6000);
            }
        }

        if (st.quiereCam && !lp.isCameraEnabled) {
            try {
                await lp.setCameraEnabled(true, { facingMode: st.facingMode });
            } catch (e) {
                toast(mensajeDispositivo(e, 'cámara'), 'error', 6000);
            }
        }
    }

    async function destruirRoom() {
        const room = st.room;
        st.room = null; // los eventos de esta sala se ignoran a partir de aquí
        limpiarMedia();

        if (room) {
            try { room.removeAllListeners(); } catch (e) { /* noop */ }
            try { await room.disconnect(true); } catch (e) { /* noop */ }
        }
    }

    function programarReintento() {
        if (st.salidaVoluntaria) return;
        clearTimeout(st.timerReintento);

        if (!navigator.onLine) {
            actualizarEstado('Sin internet. Esperando conexión…', 'error');
            return; // el evento "online" retoma la conexión
        }

        if (st.intentos >= MAX_REINTENTOS) {
            mostrarSalida('No pudimos reconectar', 'Revisa tu conexión a internet e inténtalo de nuevo.');
            return;
        }

        const espera = Math.min(30000, 1000 * Math.pow(2, st.intentos)) + Math.random() * 500;
        st.intentos += 1;
        actualizarEstado(`Conexión perdida. Reintentando en ${Math.round(espera / 1000)} s…`, 'error');
        st.timerReintento = setTimeout(() => conectar(), espera);
    }

    function onDesconectado(reason) {
        // Si falla durante conectar(), esa función ya maneja el error
        if (st.conectando) return;
        const R = LK.DisconnectReason || {};
        const room = st.room;
        st.room = null;
        limpiarMedia();
        if (room) {
            try { room.removeAllListeners(); } catch (e) { /* noop */ }
        }

        console.warn('[sala] Desconectado. Motivo:', reason);

        if (st.salidaVoluntaria || reason === R.CLIENT_INITIATED) {
            mostrarSalida('Saliste de la llamada', 'Puedes volver a entrar cuando quieras.');
            return;
        }
        if (reason === R.DUPLICATE_IDENTITY) {
            mostrarSalida('Sesión abierta en otro lugar', 'Entraste a esta sala desde otra pestaña o dispositivo.');
            return;
        }
        if (reason === R.PARTICIPANT_REMOVED) {
            mostrarSalida('Fuiste retirado de la sala', 'Un administrador te sacó de la llamada.');
            return;
        }
        if (reason === R.ROOM_DELETED) {
            mostrarSalida('La sala fue cerrada', 'La llamada terminó.');
            return;
        }

        programarReintento();
    }

    // ============================================================
    // EVENTOS DE LIVEKIT
    // ============================================================

    function registrarEventos(room) {
        const E = LK.RoomEvent;

        // Ignora eventos de una sala que ya fue reemplazada
        const on = (evento, fn) => {
            if (!evento) return;
            room.on(evento, function () {
                if (st.room !== room) return;
                try {
                    fn.apply(null, arguments);
                } catch (e) {
                    console.error('[evento ' + evento + ']', e);
                }
            });
        };

        on(E.ParticipantConnected, (p) => {
            toast(`${nombreDe(p)} se unió`);
            programarSync();
        });

        on(E.ParticipantDisconnected, (p) => {
            toast(`${nombreDe(p)} salió`);
            st.calidades.delete(p.identity);
            programarSync();
        });

        on(E.TrackSubscribed, (track) => {
            if (track.kind === 'audio') adjuntarAudio(track);
            programarSync();
        });

        on(E.TrackUnsubscribed, (track) => {
            if (track.kind === 'audio') quitarAudio(track);
            programarSync();
        });

        [
            E.TrackPublished,
            E.TrackUnpublished,
            E.TrackMuted,
            E.TrackUnmuted,
            E.TrackStreamStateChanged,
            E.ParticipantNameChanged
        ].forEach((ev) => on(ev, programarSync));

        on(E.LocalTrackPublished, () => {
            actualizarControles();
            actualizarPip();
        });

        on(E.LocalTrackUnpublished, () => {
            actualizarControles();
            actualizarPip();
            actualizarEstado('Conectado', 'conectado');
        });

        on(E.ActiveSpeakersChanged, (hablantes) => {
            st.hablando = new Set(hablantes.map((p) => p.identity));
            aplicarHablando();
        });

        on(E.ConnectionQualityChanged, (calidad, participante) => {
            st.calidades.set(participante.identity, calidad);
            if (participante.isLocal) actualizarCalidadLocal(calidad);
            else aplicarCalidades();
        });

        on(E.AudioPlaybackStatusChanged, () => {
            ui.avisoAudio.hidden = room.canPlaybackAudio;
        });

        on(E.MediaDevicesError, (error) => {
            toast(mensajeDispositivo(error, 'dispositivo'), 'error', 6000);
        });

        on(E.MediaDevicesChanged, actualizarBotonVoltear);

        on(E.TrackSubscriptionFailed, (sid, p) => {
            console.warn('[sala] No se pudo recibir una pista de', nombreDe(p), sid);
        });

        on(E.SignalReconnecting, () => actualizarEstado('Conexión inestable, reconectando…', 'conectando'));
        on(E.Reconnecting, () => actualizarEstado('Conexión inestable, reconectando…', 'conectando'));

        on(E.Reconnected, () => {
            actualizarEstado('Conectado', 'conectado');
            toast('Conexión restablecida', 'exito');
            programarSync();
        });

        on(E.Disconnected, onDesconectado);
    }

    // ============================================================
    // SINCRONIZACIÓN VISTA ⇄ ESTADO DE LIVEKIT
    // ============================================================

    function programarSync() {
        if (st.syncPendiente) return;
        st.syncPendiente = true;
        // setTimeout (no rAF) para que también funcione con la pestaña en segundo plano
        setTimeout(() => {
            st.syncPendiente = false;
            sincronizar();
        }, 16);
    }

    function sincronizar() {
        const room = st.room;
        if (!room) return;

        const S = LK.Track.Source;
        const clavesVivas = new Set();
        const audiosVivos = new Set();

        room.remoteParticipants.forEach((p) => {
            // --- Cámara (siempre hay un tile por participante) ---
            const claveCam = p.identity + '|camara';
            clavesVivas.add(claveCam);
            const tileCam = obtenerTile(claveCam, p, 'camara');

            const pubCam = p.getTrackPublication(S.Camera);
            const trackCam = pubCam && pubCam.isSubscribed && pubCam.track && !pubCam.isMuted ? pubCam.track : null;
            ponerVideo(tileCam, trackCam);

            const pubMic = p.getTrackPublication(S.Microphone);
            tileCam.el.classList.toggle('mic-off', !pubMic || pubMic.isMuted);
            tileCam.nombre.textContent = nombreDe(p);
            tileCam.avatar.textContent = iniciales(nombreDe(p));

            // --- Pantalla compartida ---
            const pubPantalla = p.getTrackPublication(S.ScreenShare);
            if (pubPantalla && pubPantalla.isSubscribed && pubPantalla.track) {
                const claveP = p.identity + '|pantalla';
                clavesVivas.add(claveP);
                const tileP = obtenerTile(claveP, p, 'pantalla');
                tileP.nombre.textContent = 'Pantalla de ' + nombreDe(p);
                tileP.avatar.textContent = iniciales(nombreDe(p));
                ponerVideo(tileP, pubPantalla.isMuted ? null : pubPantalla.track);
            }

            // --- Audios (micrófono y audio de pantalla) ---
            p.audioTrackPublications.forEach((pub) => {
                if (pub.isSubscribed && pub.track) {
                    adjuntarAudio(pub.track);
                    audiosVivos.add(pub.track.sid);
                }
            });
        });

        // Quitar lo que ya no existe
        Array.from(st.tiles.keys()).forEach((clave) => {
            if (!clavesVivas.has(clave)) quitarTile(clave);
        });
        Array.from(st.audios.keys()).forEach((sid) => {
            if (!audiosVivos.has(sid)) quitarAudio(st.audios.get(sid).track);
        });

        // Foco: el del usuario manda; si no, la primera pantalla compartida
        if (st.foco && !st.tiles.has(st.foco)) st.foco = null;
        st.focoAuto = null;
        if (!st.foco) {
            for (const clave of st.tiles.keys()) {
                if (clave.endsWith('|pantalla') && !st.focoDescartado.has(clave)) {
                    st.focoAuto = clave;
                    break;
                }
            }
        }
        st.focoDescartado.forEach((clave) => {
            if (!st.tiles.has(clave)) st.focoDescartado.delete(clave);
        });

        ui.vacio.hidden = st.tiles.size > 0;
        ui.contador.textContent = String(room.remoteParticipants.size + 1);

        aplicarHablando();
        aplicarCalidades();
        actualizarLayout();
        actualizarPip();
        actualizarControles();
    }

    // ============================================================
    // TILES (VIDEOS REMOTOS)
    // ============================================================

    const SVG_MIC_OFF =
        '<svg viewBox="0 0 24 24"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/></svg>';

    function obtenerTile(clave, participante, tipo) {
        const existente = st.tiles.get(clave);
        if (existente) return existente;

        const el = document.createElement('div');
        el.className = 'tile sin-video' + (tipo === 'pantalla' ? ' pantalla' : '');
        el.setAttribute('role', 'listitem');
        el.tabIndex = 0;
        el.dataset.clave = clave;

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true; // el audio va por <audio> separado
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.disablePictureInPicture = true;

        const avatarCont = document.createElement('div');
        avatarCont.className = 'tile-avatar';
        const avatar = document.createElement('span');
        avatar.className = 'avatar-circulo';
        avatarCont.appendChild(avatar);

        const info = document.createElement('div');
        info.className = 'tile-info';
        const mic = document.createElement('span');
        mic.className = 'tile-mic';
        mic.innerHTML = SVG_MIC_OFF; // SVG estático, sin datos del usuario
        const nombre = document.createElement('span');
        nombre.className = 'tile-nombre';
        info.append(mic, nombre);

        const calidadCont = document.createElement('span');
        calidadCont.className = 'tile-calidad';
        const calidad = document.createElement('span');
        calidad.className = 'calidad calidad-desconocida';
        calidad.innerHTML = '<i></i><i></i><i></i>';
        calidadCont.appendChild(calidad);

        const estado = document.createElement('span');
        estado.className = 'tile-estado';
        estado.textContent = 'Video en pausa · conexión lenta';

        el.append(video, avatarCont, info, calidadCont, estado);

        // Videos verticales (celulares) no se recortan
        const revisarOrientacion = () => {
            if (video.videoWidth && video.videoHeight) {
                el.classList.toggle('retrato', video.videoHeight > video.videoWidth * 1.1);
            }
        };
        video.addEventListener('loadedmetadata', revisarOrientacion);
        video.addEventListener('resize', revisarOrientacion);

        el.addEventListener('click', () => alternarFoco(clave));
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                alternarFoco(clave);
            }
        });

        ui.grid.appendChild(el);

        const tile = {
            clave,
            identidad: participante.identity,
            tipo,
            el,
            video,
            nombre,
            avatar,
            calidad,
            track: null
        };
        st.tiles.set(clave, tile);
        return tile;
    }

    function ponerVideo(tile, track) {
        if (tile.track !== track) {
            if (tile.track) {
                try { tile.track.detach(tile.video); } catch (e) { /* noop */ }
            }
            tile.track = track || null;
            if (track) {
                try {
                    track.attach(tile.video);
                } catch (e) {
                    console.warn('[video] No se pudo adjuntar', e);
                    tile.track = null;
                }
            }
        }

        const pausado = Boolean(tile.track && tile.track.streamState === 'paused' && !tile.el.classList.contains('fuera-tira'));
        tile.el.classList.toggle('sin-video', !tile.track);
        tile.el.classList.toggle('pausado', pausado);
    }

    function quitarTile(clave) {
        const tile = st.tiles.get(clave);
        if (!tile) return;
        if (tile.track) {
            try { tile.track.detach(tile.video); } catch (e) { /* noop */ }
        }
        tile.video.srcObject = null;
        tile.el.remove();
        st.tiles.delete(clave);
        if (st.foco === clave) st.foco = null;
    }

    function alternarFoco(clave) {
        const efectivo = st.foco || st.focoAuto;
        if (efectivo === clave) {
            if (st.focoAuto === clave) st.focoDescartado.add(clave);
            st.foco = null;
            st.focoAuto = null;
        } else {
            st.foco = clave;
        }
        actualizarLayout();
    }

    function aplicarHablando() {
        st.tiles.forEach((tile) => {
            tile.el.classList.toggle('hablando', tile.tipo === 'camara' && st.hablando.has(tile.identidad));
        });
        const yo = st.room && st.room.localParticipant.identity;
        ui.pip.classList.toggle('hablando', Boolean(yo && st.hablando.has(yo)));
    }

    const CLASE_CALIDAD = {
        excellent: 'excelente',
        good: 'buena',
        poor: 'mala',
        lost: 'perdida',
        unknown: 'desconocida'
    };

    const TEXTO_CALIDAD = {
        excelente: 'Excelente',
        buena: 'Buena',
        mala: 'Débil',
        perdida: 'Perdida',
        desconocida: 'Midiendo…'
    };

    function aplicarCalidades() {
        st.tiles.forEach((tile) => {
            const q = CLASE_CALIDAD[st.calidades.get(tile.identidad)] || 'desconocida';
            tile.calidad.className = 'calidad calidad-' + q;
            tile.calidad.title = 'Conexión: ' + TEXTO_CALIDAD[q];
        });
    }

    function actualizarCalidadLocal(calidad) {
        const q = CLASE_CALIDAD[calidad] || 'desconocida';
        ui.calidad.className = 'calidad calidad-' + q;
        ui.calidad.setAttribute('aria-label', 'Calidad de conexión: ' + TEXTO_CALIDAD[q]);
        ui.calidad.title = 'Tu conexión: ' + TEXTO_CALIDAD[q];

        if ((q === 'mala' || q === 'perdida') && Date.now() - st.ultimoAvisoCalidad > 60000) {
            st.ultimoAvisoCalidad = Date.now();
            toast('Tu conexión está débil. Ajustamos la calidad del video automáticamente.', 'info', 5000);
        }
    }

    // ============================================================
    // LAYOUT
    // ============================================================

    function calcularGrid(n, ancho, alto, gap) {
        if (n <= 1 || !ancho || !alto) return { cols: 1, rows: 1 };
        const proporcion = 4 / 3;
        let mejor = { cols: 1, rows: n, area: 0 };

        for (let cols = 1; cols <= n; cols++) {
            const rows = Math.ceil(n / cols);
            const w = (ancho - (cols - 1) * gap) / cols;
            const h = (alto - (rows - 1) * gap) / rows;
            const tw = Math.min(w, h * proporcion);
            const area = tw * (tw / proporcion);
            if (area > mejor.area) mejor = { cols, rows, area };
        }
        return mejor;
    }

    function actualizarLayout() {
        const grid = ui.grid;
        const tiles = Array.from(st.tiles.values());
        const n = tiles.length;
        const foco = n > 1 ? (st.foco || st.focoAuto) : null;
        const gap = parseFloat(getComputedStyle(grid).columnGap) || 6;

        grid.classList.toggle('con-foco', Boolean(foco));

        if (foco) {
            const maxTira = grid.clientWidth < 600 ? 3 : 5;
            let i = 0;
            tiles.forEach((t) => {
                const esFoco = t.clave === foco;
                t.el.classList.toggle('foco', esFoco);
                if (!esFoco) {
                    t.el.classList.toggle('fuera-tira', i >= maxTira);
                    i++;
                } else {
                    t.el.classList.remove('fuera-tira');
                }
            });
            grid.style.setProperty('--tira-n', String(Math.max(1, Math.min(i, maxTira))));
        } else {
            tiles.forEach((t) => t.el.classList.remove('foco', 'fuera-tira'));
            const { cols, rows } = calcularGrid(n, grid.clientWidth, grid.clientHeight, gap);
            grid.style.setProperty('--cols', String(cols));
            grid.style.setProperty('--rows', String(rows));
        }
    }

    function programarLayout() {
        if (st.layoutPendiente) return;
        st.layoutPendiente = true;
        requestAnimationFrame(() => {
            st.layoutPendiente = false;
            if (ui.sala.hidden) return;
            actualizarLayout();
            if (!ui.pip.hidden) colocarPip(st.pipEsquina);
        });
    }

    // ============================================================
    // VIDEO LOCAL (PIP) — arrastrable, se acomoda a la esquina más cercana
    // ============================================================

    function actualizarPip() {
        const room = st.room;
        if (!room) {
            ui.pip.hidden = true;
            return;
        }

        const lp = room.localParticipant;
        const pub = lp.getTrackPublication(LK.Track.Source.Camera);
        const track = pub && pub.track && !pub.isMuted ? pub.track : null;

        if (track !== st.pipTrack) {
            if (st.pipTrack) {
                try { st.pipTrack.detach(ui.videoLocal); } catch (e) { /* noop */ }
            }
            st.pipTrack = track;
            if (track) track.attach(ui.videoLocal);
        }

        const eraOculto = ui.pip.hidden;
        ui.pip.hidden = false;
        ui.pip.classList.toggle('sin-video', !track);
        ui.pip.classList.toggle('espejo', Boolean(track) && st.facingMode === 'user');
        ui.pip.classList.toggle('mic-off', !lp.isMicrophoneEnabled);
        ui.pipIniciales.textContent = iniciales(st.nombre);

        if (eraOculto || !st.pipColocada) {
            colocarPip(st.pipEsquina);
            st.pipColocada = true;
        }
    }

    function medidasPip() {
        const cs = getComputedStyle(ui.escenario);
        return {
            ancho: ui.escenario.clientWidth,
            alto: ui.escenario.clientHeight,
            w: ui.pip.offsetWidth,
            h: ui.pip.offsetHeight,
            mIzq: parseFloat(cs.paddingLeft) + 8,
            mDer: parseFloat(cs.paddingRight) + 8,
            mArr: parseFloat(cs.paddingTop) + 8,
            mAba: parseFloat(cs.paddingBottom) + 8
        };
    }

    function moverPip(x, y) {
        const m = medidasPip();
        const nx = clamp(x, m.mIzq, Math.max(m.mIzq, m.ancho - m.w - m.mDer));
        const ny = clamp(y, m.mArr, Math.max(m.mArr, m.alto - m.h - m.mAba));
        st.pipPos = { x: nx, y: ny };
        ui.pip.style.transform = `translate3d(${nx}px, ${ny}px, 0)`;
    }

    function colocarPip(esquina) {
        const m = medidasPip();
        if (!m.w) return;
        const derecha = esquina.endsWith('derecha');
        const abajo = esquina.startsWith('abajo');
        const x = derecha ? m.ancho - m.w - m.mDer : m.mIzq;
        // Arriba dejamos espacio para el indicador de estado
        const y = abajo ? m.alto - m.h - m.mAba : m.mArr + 40;
        moverPip(x, y);
    }

    function iniciarArrastrePip() {
        let arrastre = null;

        ui.pip.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            arrastre = {
                id: e.pointerId,
                inicioX: e.clientX,
                inicioY: e.clientY,
                baseX: st.pipPos.x,
                baseY: st.pipPos.y,
                movido: false
            };
            try { ui.pip.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
            ui.pip.classList.add('arrastrando');
        });

        ui.pip.addEventListener('pointermove', (e) => {
            if (!arrastre || e.pointerId !== arrastre.id) return;
            const dx = e.clientX - arrastre.inicioX;
            const dy = e.clientY - arrastre.inicioY;
            if (Math.abs(dx) + Math.abs(dy) > 4) arrastre.movido = true;
            moverPip(arrastre.baseX + dx, arrastre.baseY + dy);
        });

        const terminar = () => {
            if (!arrastre) return;
            const movido = arrastre.movido;
            arrastre = null;
            ui.pip.classList.remove('arrastrando');
            if (!movido) return;

            const m = medidasPip();
            const derecha = st.pipPos.x + m.w / 2 > m.ancho / 2;
            const abajo = st.pipPos.y + m.h / 2 > m.alto / 2;
            st.pipEsquina = (abajo ? 'abajo' : 'arriba') + '-' + (derecha ? 'derecha' : 'izquierda');
            colocarPip(st.pipEsquina);
        };

        ui.pip.addEventListener('pointerup', terminar);
        ui.pip.addEventListener('pointercancel', terminar);
    }

    // ============================================================
    // AUDIO REMOTO
    // ============================================================

    function aplicarVolumen(track, el) {
        if (typeof track.setVolume === 'function') {
            track.setVolume(st.volumen);
        } else if (el) {
            el.volume = st.volumen;
        }
    }

    function adjuntarAudio(track) {
        const sid = track.sid;
        if (!sid || st.audios.has(sid)) return;

        const el = track.attach(); // LiveKit crea el <audio> y maneja autoplay
        el.dataset.sid = sid;
        contAudios.appendChild(el);
        aplicarVolumen(track, el);
        st.audios.set(sid, { el, track });
    }

    function quitarAudio(track) {
        if (!track) return;
        const entrada = st.audios.get(track.sid);
        if (!entrada) return;
        try { track.detach(entrada.el); } catch (e) { /* noop */ }
        entrada.el.remove();
        st.audios.delete(track.sid);
    }

    function cambiarVolumen() {
        st.volumen = clamp(Number(ui.volumen.value), 0, 1);
        ui.volumenLabel.textContent = Math.round(st.volumen * 100) + '%';
        st.audios.forEach(({ el, track }) => aplicarVolumen(track, el));
        almacen.guardar('vd_volumen', String(st.volumen));
    }

    async function activarAudio() {
        if (!st.room) {
            ui.avisoAudio.hidden = true;
            return;
        }
        try {
            await st.room.startAudio();
        } catch (e) {
            console.warn('[audio] startAudio falló', e);
        }
        ui.avisoAudio.hidden = st.room ? st.room.canPlaybackAudio : true;
    }

    // Truco para iOS/Safari: crear audio dentro del gesto del usuario
    function desbloquearAudioEnGesto() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const buffer = ctx.createBuffer(1, 1, 22050);
            const fuente = ctx.createBufferSource();
            fuente.buffer = buffer;
            fuente.connect(ctx.destination);
            fuente.start(0);
            ctx.resume().catch(() => {});
            setTimeout(() => ctx.close().catch(() => {}), 1000);
        } catch (e) { /* noop */ }
    }

    // ============================================================
    // LIMPIEZA
    // ============================================================

    function limpiarMedia() {
        Array.from(st.tiles.keys()).forEach(quitarTile);
        Array.from(st.audios.values()).forEach(({ track }) => quitarAudio(track));
        contAudios.textContent = '';

        if (st.pipTrack) {
            try { st.pipTrack.detach(ui.videoLocal); } catch (e) { /* noop */ }
            st.pipTrack = null;
        }
        ui.videoLocal.srcObject = null;
        ui.pip.hidden = true;

        st.foco = null;
        st.focoAuto = null;
        st.focoDescartado.clear();
        st.hablando.clear();
        st.calidades.clear();
        ui.vacio.hidden = true;
        ui.contador.textContent = '1';
        actualizarCalidadLocal('unknown');
        liberarWakeLock();
    }

    // ============================================================
    // CONTROLES
    // ============================================================

    function setBotonToggle(btn, encendido, texto) {
        btn.classList.toggle('apagado', !encendido);
        btn.setAttribute('aria-pressed', String(encendido));
        btn.dataset.tip = texto;
        const sr = btn.querySelector('.sr-only');
        if (sr) sr.textContent = texto;
    }

    function actualizarControles() {
        const lp = st.room && st.room.localParticipant;
        const mic = Boolean(lp && lp.isMicrophoneEnabled);
        const cam = Boolean(lp && lp.isCameraEnabled);
        const pantalla = Boolean(lp && lp.isScreenShareEnabled);

        setBotonToggle(ui.btnMic, mic, mic ? 'Silenciar micrófono (M)' : 'Activar micrófono (M)');
        setBotonToggle(ui.btnCam, cam, cam ? 'Apagar cámara (V)' : 'Encender cámara (V)');

        ui.btnCompartir.classList.toggle('activo-azul', pantalla);
        ui.btnCompartir.setAttribute('aria-pressed', String(pantalla));
        ui.btnCompartir.dataset.tip = pantalla ? 'Dejar de compartir' : 'Compartir pantalla';

        ui.btnVoltear.disabled = !cam;
    }

    async function alternarMicrofono() {
        const room = st.room;
        if (!room || st.ocupado.mic) return;
        st.ocupado.mic = true;
        ui.btnMic.disabled = true;

        const activar = !room.localParticipant.isMicrophoneEnabled;
        try {
            await room.localParticipant.setMicrophoneEnabled(activar);
            st.quiereMic = activar;
        } catch (e) {
            toast(mensajeDispositivo(e, 'micrófono'), 'error', 6000);
        } finally {
            st.ocupado.mic = false;
            ui.btnMic.disabled = false;
            actualizarControles();
            actualizarPip();
        }
    }

    async function alternarCamara() {
        const room = st.room;
        if (!room || st.ocupado.cam) return;
        st.ocupado.cam = true;
        ui.btnCam.disabled = true;

        const activar = !room.localParticipant.isCameraEnabled;
        try {
            await room.localParticipant.setCameraEnabled(activar, activar ? { facingMode: st.facingMode } : undefined);
            st.quiereCam = activar;
        } catch (e) {
            toast(mensajeDispositivo(e, 'cámara'), 'error', 6000);
        } finally {
            st.ocupado.cam = false;
            ui.btnCam.disabled = false;
            actualizarControles();
            actualizarPip();
        }
    }

    async function voltearCamara() {
        const room = st.room;
        if (!room || st.ocupado.voltear) return;

        const pub = room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
        if (!pub || !pub.track || pub.isMuted) return;

        st.ocupado.voltear = true;
        ui.btnVoltear.disabled = true;
        try {
            if (esMovil) {
                const nuevo = st.facingMode === 'user' ? 'environment' : 'user';
                await pub.track.restartTrack({
                    facingMode: nuevo,
                    resolution: LK.VideoPresets.h540.resolution
                });
                st.facingMode = nuevo;
            } else {
                const dispositivos = await LK.Room.getLocalDevices('videoinput', false);
                if (dispositivos.length < 2) return;
                const actual = typeof room.getActiveDevice === 'function' ? room.getActiveDevice('videoinput') : null;
                const idx = dispositivos.findIndex((d) => d.deviceId === actual);
                const siguiente = dispositivos[(idx + 1) % dispositivos.length];
                await room.switchActiveDevice('videoinput', siguiente.deviceId);
                toast('Cámara: ' + (siguiente.label || 'siguiente dispositivo'));
            }
        } catch (e) {
            console.warn('[cámara] No se pudo cambiar', e);
            toast('No se pudo cambiar de cámara.', 'error');
        } finally {
            st.ocupado.voltear = false;
            actualizarControles();
            actualizarPip();
        }
    }

    async function actualizarBotonVoltear() {
        let mostrar = false;
        try {
            if (esMovil) {
                mostrar = true;
            } else if (LK) {
                const dispositivos = await LK.Room.getLocalDevices('videoinput', false);
                mostrar = dispositivos.length > 1;
            }
        } catch (e) { /* noop */ }
        ui.btnVoltear.hidden = !mostrar;
    }

    async function alternarPantalla() {
        const room = st.room;
        if (!room || st.ocupado.pantalla) return;
        st.ocupado.pantalla = true;
        ui.btnCompartir.disabled = true;

        const activar = !room.localParticipant.isScreenShareEnabled;
        try {
            await room.localParticipant.setScreenShareEnabled(activar, { audio: true });
            if (activar) toast('Estás compartiendo tu pantalla', 'exito');
        } catch (e) {
            const cancelado = e && (e.name === 'NotAllowedError' || e.name === 'AbortError');
            if (!cancelado) toast('No se pudo compartir la pantalla.', 'error');
        } finally {
            st.ocupado.pantalla = false;
            ui.btnCompartir.disabled = false;
            actualizarControles();
            actualizarEstado('Conectado', 'conectado');
        }
    }

    function urlInvitacion() {
        return `${location.origin}${location.pathname}`;
    }

    async function invitar() {
        const url = urlInvitacion();

        if (navigator.share && esTactil) {
            try {
                await navigator.share({
                    title: 'Ventana Digital',
                    text: 'Únete a mi videollamada en Ventana Digital',
                    url
                });
                return;
            } catch (e) {
                if (e && e.name === 'AbortError') return;
            }
        }

        try {
            await navigator.clipboard.writeText(url);
            toast('Enlace copiado. ¡Compártelo!', 'exito');
        } catch (e) {
            window.prompt('Copia este enlace de invitación:', url);
        }
    }

    function soportaFullscreen() {
        return Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    }

    async function alternarPantallaCompleta() {
        try {
            const activo = document.fullscreenElement || document.webkitFullscreenElement;
            if (!activo) {
                if (ui.sala.requestFullscreen) await ui.sala.requestFullscreen();
                else if (ui.sala.webkitRequestFullscreen) ui.sala.webkitRequestFullscreen();
            } else if (document.exitFullscreen) {
                await document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } catch (e) {
            console.warn('[fullscreen]', e);
        }
    }

    async function salir() {
        st.salidaVoluntaria = true;
        clearTimeout(st.timerReintento);
        await destruirRoom();
        mostrarSalida('Saliste de la llamada', 'Puedes volver a entrar cuando quieras.');
    }

    // ============================================================
    // WAKE LOCK (evita que la pantalla se apague en móviles)
    // ============================================================

    async function solicitarWakeLock() {
        if (!('wakeLock' in navigator) || st.wakeLock || document.visibilityState !== 'visible') return;
        try {
            st.wakeLock = await navigator.wakeLock.request('screen');
            st.wakeLock.addEventListener('release', () => { st.wakeLock = null; });
        } catch (e) { /* no soportado o denegado */ }
    }

    function liberarWakeLock() {
        if (st.wakeLock) {
            st.wakeLock.release().catch(() => {});
            st.wakeLock = null;
        }
    }

    // ============================================================
    // DIAGNÓSTICO
    // ============================================================

    async function mostrarDiagnostico() {
        const room = st.room;
        const l = [];
        const si = (v) => (v ? 'sí' : 'no');

        l.push(`Ventana Digital ${APP_VERSION} · LiveKit ${(LK && LK.version) || '?'}`);
        l.push(`Navegador: ${navigator.userAgent}`);
        l.push(`HTTPS: ${si(window.isSecureContext)} · En línea: ${si(navigator.onLine)} · Táctil: ${si(esTactil)}`);
        l.push('');

        if (room) {
            const lp = room.localParticipant;
            const q = CLASE_CALIDAD[st.calidades.get(lp.identity)] || 'desconocida';
            l.push(`Sala: ${st.sala} · Estado: ${room.state}`);
            l.push(`Tú: ${st.nombre} (${lp.identity})`);
            l.push(`Participantes: ${room.remoteParticipants.size + 1}`);
            l.push(`Tu conexión: ${TEXTO_CALIDAD[q]}`);
            l.push(`Micrófono: ${si(lp.isMicrophoneEnabled)} · Cámara: ${si(lp.isCameraEnabled)} · Pantalla: ${si(lp.isScreenShareEnabled)}`);
            l.push(`Audio habilitado por el navegador: ${si(room.canPlaybackAudio)}`);
            l.push(`Videos remotos: ${st.tiles.size} · Audios remotos: ${st.audios.size}`);
            l.push('');
            room.remoteParticipants.forEach((p) => {
                const qp = CLASE_CALIDAD[st.calidades.get(p.identity)] || 'desconocida';
                const pubs = Array.from(p.trackPublications.values())
                    .map((pub) => `${pub.source}${pub.isSubscribed ? '' : '(no suscrito)'}${pub.isMuted ? '(silenciado)' : ''}`)
                    .join(', ');
                l.push(`• ${nombreDe(p)} — conexión ${TEXTO_CALIDAD[qp]} — ${pubs || 'sin pistas'}`);
            });
        } else {
            l.push('Sin conexión a una sala.');
        }

        try {
            const devs = await navigator.mediaDevices.enumerateDevices();
            const cuenta = (k) => devs.filter((d) => d.kind === k).length;
            l.push('');
            l.push(`Dispositivos: ${cuenta('videoinput')} cámara(s), ${cuenta('audioinput')} micrófono(s), ${cuenta('audiooutput')} salida(s) de audio`);
        } catch (e) { /* noop */ }

        ui.diagContenido.textContent = l.join('\n');

        if (typeof ui.dlgDiag.showModal === 'function') ui.dlgDiag.showModal();
        else ui.dlgDiag.setAttribute('open', '');
    }

    function cerrarDiagnostico() {
        if (typeof ui.dlgDiag.close === 'function') ui.dlgDiag.close();
        else ui.dlgDiag.removeAttribute('open');
    }

    // ============================================================
    // LOBBY
    // ============================================================

    async function cargarConfig() {
        try {
            const resp = await fetchConTimeout('/api/config', {}, 8000);
            if (!resp.ok) return;
            const cfg = await resp.json();
            if (cfg.salaPorDefecto) st.salaDefecto = cfg.salaPorDefecto;
        } catch (e) {
            // El servidor puede estar "dormido" (Render free); no es crítico aquí
        }
    }

    // Entrar: con el nombre basta, sin código de verificación
    async function onEntrar(evento) {
        evento.preventDefault();
        mostrarErrorLobby('');
        if (st.conectando) return;

        const nombre = ui.inputNombre.value.replace(/\s+/g, ' ').trim();

        ui.inputNombre.setAttribute('aria-invalid', String(!nombre));
        if (!nombre) {
            mostrarErrorLobby('Escribe tu nombre para entrar.');
            ui.inputNombre.focus();
            return;
        }

        if (!LK) {
            mostrarErrorLobby('La librería de video aún no ha cargado. Recarga la página.');
            return;
        }

        desbloquearAudioEnGesto();

        st.nombre = nombre;
        st.sala = st.salaDefecto;
        st.quiereMic = ui.prefMic.checked;
        st.quiereCam = ui.prefCam.checked;
        st.acceso = null;
        st.intentos = 0;
        st.facingMode = 'user';

        almacen.guardar('vd_nombre', nombre);
        almacen.guardar('vd_mic', st.quiereMic ? '1' : '0');
        almacen.guardar('vd_cam', st.quiereCam ? '1' : '0');

        setBotonCargando(ui.btnEntrar, true);
        try {
            await conectar({ primeraVez: true });
        } finally {
            setBotonCargando(ui.btnEntrar, false);
        }
    }

    // Volver a entrar desde la pantalla de salida, con el mismo nombre
    async function volverAEntrar() {
        if (!st.nombre || !LK) {
            mostrarLobby();
            return;
        }
        desbloquearAudioEnGesto();
        st.acceso = null;
        st.intentos = 0;
        setBotonCargando(ui.btnVolver, true);
        try {
            await conectar({ primeraVez: true });
        } finally {
            setBotonCargando(ui.btnVolver, false);
        }
    }

    function restaurarPreferencias() {
        ui.inputNombre.value = almacen.leer('vd_nombre') || '';
        ui.prefMic.checked = almacen.leer('vd_mic') !== '0';
        ui.prefCam.checked = almacen.leer('vd_cam') !== '0';

        const vol = Number(almacen.leer('vd_volumen'));
        if (!Number.isNaN(vol) && almacen.leer('vd_volumen') !== null) {
            ui.volumen.value = String(clamp(vol, 0, 1));
        }
        cambiarVolumen();
    }

    function verificarCompatibilidad() {
        if (!window.isSecureContext) {
            return 'La cámara y el micrófono solo funcionan con HTTPS. Abre la página con https:// (o en localhost).';
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return 'Tu navegador no permite videollamadas. Actualízalo o usa Chrome, Safari, Edge o Firefox.';
        }
        if (typeof LK.isBrowserSupported === 'function' && !LK.isBrowserSupported()) {
            return 'Tu navegador no es compatible. Actualízalo o usa Chrome, Safari, Edge o Firefox recientes.';
        }
        return '';
    }

    // ============================================================
    // LISTENERS GLOBALES
    // ============================================================

    function registrarListenersUI() {
        ui.form.addEventListener('submit', onEntrar);
        ui.inputNombre.addEventListener('input', () => {
            ui.inputNombre.removeAttribute('aria-invalid');
            mostrarErrorLobby('');
        });

        ui.btnMic.addEventListener('click', alternarMicrofono);
        ui.btnCam.addEventListener('click', alternarCamara);
        ui.btnVoltear.addEventListener('click', voltearCamara);
        ui.btnCompartir.addEventListener('click', alternarPantalla);
        ui.btnInvitar.addEventListener('click', invitar);
        ui.btnInvitarVacio.addEventListener('click', invitar);
        ui.btnSalir.addEventListener('click', salir);
        ui.btnFullscreen.addEventListener('click', alternarPantallaCompleta);
        ui.btnDiag.addEventListener('click', mostrarDiagnostico);
        ui.volumen.addEventListener('input', cambiarVolumen);

        ui.btnActivarAudio.addEventListener('click', activarAudio);

        // Volver a entrar directamente, sin pasar por el lobby
        ui.btnVolver.addEventListener('click', volverAEntrar);
        ui.btnInicio.addEventListener('click', mostrarLobby);

        ui.btnDiagCerrar.addEventListener('click', cerrarDiagnostico);
        ui.btnDiagCopiar.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(ui.diagContenido.textContent);
                toast('Diagnóstico copiado', 'exito');
            } catch (e) {
                toast('No se pudo copiar', 'error');
            }
        });

        // Atajos de teclado (solo dentro de la sala y fuera de campos de texto)
        document.addEventListener('keydown', (e) => {
            if (ui.sala.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            const tecla = e.key.toLowerCase();
            if (tecla === 'm') alternarMicrofono();
            if (tecla === 'v') alternarCamara();
        });

        // Red
        window.addEventListener('online', () => {
            toast('Conexión a internet recuperada', 'exito');
            if (!st.room && !ui.sala.hidden && !st.salidaVoluntaria && !st.conectando) {
                st.intentos = 0;
                conectar();
            }
        });
        window.addEventListener('offline', () => {
            actualizarEstado('Sin internet. Esperando conexión…', 'error');
        });

        // Volver a la pestaña / app
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || !st.room) return;
            solicitarWakeLock();
            programarSync();
            if (!st.room.canPlaybackAudio) ui.avisoAudio.hidden = false;
        });

        // Redimensionar / girar el teléfono
        if ('ResizeObserver' in window) {
            new ResizeObserver(programarLayout).observe(ui.escenario);
        }
        window.addEventListener('resize', programarLayout);
        window.addEventListener('orientationchange', () => setTimeout(programarLayout, 250));

        iniciarArrastrePip();
    }

    // ============================================================
    // INICIO
    // ============================================================

    async function iniciar() {
        registrarListenersUI();
        restaurarPreferencias();

        ui.btnCompartir.hidden = esMovil || !(navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices);
        ui.btnFullscreen.hidden = !soportaFullscreen();
        mostrarLobby();

        cargarConfig(); // en paralelo; también "despierta" el servidor

        try {
            LK = await asegurarLiveKit();
        } catch (e) {
            mostrarErrorLobby(e.message);
            ui.btnEntrar.disabled = true;
            return;
        }

        const problema = verificarCompatibilidad();
        if (problema) {
            mostrarErrorLobby(problema);
            ui.btnEntrar.disabled = true;
            return;
        }

        if (!esTactil) {
            (ui.inputNombre.value ? ui.btnEntrar : ui.inputNombre).focus();
        }

        console.info(`Ventana Digital ${APP_VERSION} lista · LiveKit ${LK.version || ''}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar, { once: true });
    } else {
        iniciar();
    }
})();

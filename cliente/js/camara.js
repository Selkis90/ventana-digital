/* ============================================================
   VENTANA DIGITAL — CLIENTE
   ------------------------------------------------------------
   Arquitectura:
   - El video viaja por Cloudflare Realtime (motor.js), gratis
     hasta 1.000 GB al mes y sin límite de minutos.
   - Un solo estado (st) y una función sincronizar() idempotente
     que reconstruye la vista a partir del estado real del motor.
     Así no hay "videos fantasma" ni audios duplicados.
   - Reconexión: si la conexión se cae, se vuelve a entrar sola
     con backoff exponencial (1, 2, 4… hasta 30 s).
   - MODO KIOSCO: al abrir la URL entra solo a la sala, sin pedir
     nada. Si no hay internet o el servidor está dormido, reintenta
     para siempre. Parámetros opcionales en la URL:
        ?nombre=Recepcion   nombre que verán los demás
        &mic=0  &cam=0      entrar con micrófono / cámara apagados
        &calidad=baja       ahorrar datos (alta | normal | baja)
   ============================================================ */

(function () {
    'use strict';

    // ============================================================
    // CONSTANTES
    // ============================================================

    const APP_VERSION = '3.0.0';
    const ESPERA_MAX_MS = 30000; // los reintentos nunca esperan más de 30 s

    const esTactil = window.matchMedia('(pointer: coarse)').matches;
    const esMovil =
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS


    // ============================================================
    // ELEMENTOS DEL DOM
    // ============================================================

    const $ = (id) => document.getElementById(id);

    const ui = {
        lobby: $('lobby'),
        form: $('form-entrar'),
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
        motor: null,        // VDMotor conectado
        nombre: '',
        sala: '',
        salaDefecto: 'sala-principal',
        quiereMic: true,
        quiereCam: true,
        conectando: false,
        calidad: '',        // alta | normal | baja (vacío = la del servidor)
        timerApertura: null,
        audioBloqueado: false,
        salidaVoluntaria: false,
        intentos: 0,
        timerReintento: null,
        timerVolver: null,  // regreso automático tras tocar "Salir"

        tiles: new Map(),   // clave -> { clave, identidad, tipo, el, video, nombre, avatar, calidad, track }
        audios: new Map(),  // track.id -> { el, track }
        foco: null,         // tile fijado por el usuario
        focoAuto: null,     // pantalla compartida fijada automáticamente
        focoDescartado: new Set(),

        hablando: new Set(),
        calidades: new Map(),
        volumen: 1,
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

    // Nombre automático: ?nombre= en la URL, o uno fijo guardado en este equipo
    function nombreAutomatico() {
        const desdeUrl = new URLSearchParams(location.search).get('nombre');
        if (desdeUrl && desdeUrl.trim()) return desdeUrl.replace(/\s+/g, ' ').trim().slice(0, 40);
        let guardado = almacen.leer('vd_nombre_equipo');
        if (!guardado) {
            guardado = 'Equipo ' + String(Math.floor(1000 + Math.random() * 9000));
            almacen.guardar('vd_nombre_equipo', guardado);
        }
        return guardado;
    }

    function parametroActivo(clave) {
        const v = new URLSearchParams(location.search).get(clave);
        return v === null ? true : !/^(0|no|false|off)$/i.test(v.trim());
    }

    function nombreDe(participante) {
        return (participante && participante.nombre) || 'Invitado';
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

        const compartiendo = st.motor && st.motor.pantallaActiva;
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

    function mostrarSalida(titulo, texto, sinRegreso) {
        clearTimeout(st.timerReintento);
        ui.sala.hidden = true;
        ui.lobby.hidden = true;
        ui.avisoAudio.hidden = true;
        ui.salidaTitulo.textContent = titulo;
        ui.salidaTexto.textContent = texto;
        ui.salida.hidden = false;
        ocultarCargando();

        // Modo kiosco: si alguien salió por error, el equipo vuelve solo en 1 minuto
        clearTimeout(st.timerVolver);
        if (!sinRegreso) st.timerVolver = setTimeout(volverAEntrar, 60000);
    }

    // Error que no se arregla reintentando (navegador, HTTPS, librería)
    function mostrarErrorFatal(mensaje) {
        ocultarCargando();
        mostrarLobby();
        mostrarErrorLobby(mensaje);
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
        if (error && error.name === 'AbortError') return 'El servidor tardó demasiado en responder.';
        if (error && error.name === 'IceError') return error.message;
        return 'No se pudo conectar a la sala.';
    }

    // ============================================================
    // CONEXIÓN
    // ============================================================

    async function conectar(opciones) {
        const primeraVez = Boolean(opciones && opciones.primeraVez);
        if (st.conectando) return;

        st.conectando = true;
        st.salidaVoluntaria = false;
        clearTimeout(st.timerReintento);

        let motor = null;
        try {
            mostrarCargando(primeraVez
                ? 'Entrando a la sala… si el servidor estaba dormido puede tardar hasta un minuto.'
                : 'Reconectando…');

            // Despierta el servidor (Render free) y revisa el horario antes de abrir la cámara
            const cfg = await cargarConfig(60000);
            if (cfg && cfg.horario && cfg.horario.activo === false) {
                st.conectando = false;
                mostrarFueraDeHorario(cfg.horario.msCambio);
                return;
            }

            await destruirMotor();

            motor = new window.VDMotor({
                nombre: st.nombre,
                mic: st.quiereMic,
                cam: st.quiereCam,
                calidad: st.calidad,
                esMovil
            });
            st.motor = motor;
            registrarEventos(motor);

            mostrarCargando('Conectando con el servidor de video…');
            await motor.conectar();
            if (st.motor !== motor) return;

            st.conectando = false; // desde aquí los eventos de desconexión se manejan normal
            st.intentos = 0;
            mostrarSala();
            ocultarCargando();
            actualizarEstado('Conectado', 'conectado');

            solicitarWakeLock();
            actualizarBotonVoltear();
            programarSync();
        } catch (error) {
            console.error('[conexión]', error);
            ocultarCargando();
            const fatal = motor && motor._errorServidor;
            await destruirMotor();
            if (fatal) {
                // Sala llena o sin configurar: se reintenta, pero más despacio
                st.intentos = Math.max(st.intentos, 5);
                programarReintento(fatal.message);
            } else {
                programarReintento(mensajeConexion(error));
            }
        } finally {
            st.conectando = false;
        }
    }

    async function destruirMotor() {
        const motor = st.motor;
        st.motor = null; // los eventos de este motor se ignoran a partir de aquí
        limpiarMedia();
        if (motor) {
            try { motor.desconectar(); } catch (e) { /* noop */ }
        }
    }

    function avisoReintento(texto) {
        if (ui.sala.hidden) mostrarCargando(texto);
        else actualizarEstado(texto, 'error');
    }

    function programarReintento(motivo) {
        if (st.salidaVoluntaria) return;
        clearTimeout(st.timerReintento);

        if (!navigator.onLine) {
            avisoReintento('Sin internet. Se conectará solo cuando vuelva la conexión…');
            return; // el evento "online" retoma la conexión
        }

        // Modo kiosco: nunca se rinde; espera 1, 2, 4… hasta 30 s entre intentos
        const espera = Math.min(ESPERA_MAX_MS, 1000 * Math.pow(2, Math.min(st.intentos, 5))) + Math.random() * 500;
        st.intentos += 1;
        const seg = Math.round(espera / 1000);
        avisoReintento((motivo ? motivo + ' ' : 'Conexión perdida. ') + `Reintentando en ${seg} s…`);
        st.timerReintento = setTimeout(() => conectar(), espera);
    }

    function onDesconectado(info) {
        // Si falla durante conectar(), esa función ya maneja el error
        if (st.conectando) return;
        st.motor = null;
        limpiarMedia();

        console.warn('[sala] Desconectado. Motivo:', info && info.motivo);

        if (st.salidaVoluntaria || (info && info.voluntario)) {
            mostrarSalida('Saliste de la llamada', 'Volverás a entrar automáticamente en 1 minuto.');
            return;
        }
        // Modo kiosco: cualquier otra desconexión vuelve a entrar sola
        if (info && info.error) st.intentos = Math.max(st.intentos, 5);
        programarReintento(info && info.error ? info.error.message : '');
    }

    // Fuera del horario configurado: se apaga la cámara y vuelve sola a la hora de apertura
    function mostrarFueraDeHorario(msCambio) {
        clearTimeout(st.timerReintento);
        clearTimeout(st.timerApertura);
        const ms = Number(msCambio) > 0 ? Number(msCambio) : 30 * 60000;
        const apertura = new Date(Date.now() + ms);
        const hora = apertura.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
        const dia = apertura.toDateString() === new Date().toDateString()
            ? 'hoy'
            : apertura.toLocaleDateString('es-CO', { weekday: 'long' });
        const frase = `La llamada se activará sola ${dia} a las ${hora}`;
        mostrarSalida('Fuera de horario', /\.$/.test(frase) ? frase : frase + '.', true);
        // Se revisa de nuevo a la hora de apertura (o cada 6 h si falta mucho)
        st.timerApertura = setTimeout(volverAEntrar, Math.min(ms + 5000, 6 * 3600000));
    }

    // ============================================================
    // EVENTOS DEL MOTOR DE VIDEO
    // ============================================================

    function registrarEventos(motor) {
        // Ignora eventos de un motor que ya fue reemplazado
        const on = (evento, fn) => {
            motor.on(evento, function () {
                if (st.motor !== motor) return;
                fn.apply(null, arguments);
            });
        };

        on('entro', (p) => toast(`${nombreDe(p)} se unió`));
        on('salio', (p) => toast(`${nombreDe(p)} salió`));
        on('cambio', programarSync);
        on('cambioLocal', () => {
            actualizarControles();
            actualizarPip();
            actualizarEstado('Conectado', 'conectado');
        });
        on('hablando', (set) => {
            st.hablando = new Set(set);
            aplicarHablando();
        });
        on('calidad', actualizarCalidadLocal);
        on('errorDispositivo', (error, dispositivo) => toast(mensajeDispositivo(error, dispositivo), 'error', 6000));
        on('inestable', () => actualizarEstado('Conexión inestable, reconectando…', 'conectando'));
        on('reconectado', () => {
            actualizarEstado('Conectado', 'conectado');
            toast('Conexión restablecida', 'exito');
        });
        on('cierre', (ms) => {
            st.motor = null;
            limpiarMedia();
            mostrarFueraDeHorario(ms);
        });
        on('desconectado', onDesconectado);
    }

    // ============================================================
    // SINCRONIZACIÓN VISTA ⇄ ESTADO DEL MOTOR
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
        const motor = st.motor;
        if (!motor) return;

        const clavesVivas = new Set();
        const audiosVivos = new Set();

        motor.remotos.forEach((p) => {
            if (p.salio) return;
            // --- Cámara (siempre hay un tile por participante) ---
            const claveCam = p.id + '|camara';
            clavesVivas.add(claveCam);
            const tileCam = obtenerTile(claveCam, p, 'camara');

            const pullCam = p.pulls.get('camara');
            ponerVideo(tileCam, p.cam && pullCam ? pullCam.track : null);

            tileCam.el.classList.toggle('mic-off', !p.mic);
            tileCam.nombre.textContent = nombreDe(p);
            tileCam.avatar.textContent = iniciales(nombreDe(p));

            // --- Pantalla compartida ---
            const pullPantalla = p.pulls.get('pantalla');
            if (pullPantalla) {
                const claveP = p.id + '|pantalla';
                clavesVivas.add(claveP);
                const tileP = obtenerTile(claveP, p, 'pantalla');
                tileP.nombre.textContent = 'Pantalla de ' + nombreDe(p);
                tileP.avatar.textContent = iniciales(nombreDe(p));
                ponerVideo(tileP, pullPantalla.track);
            }

            // --- Audio ---
            const pullMic = p.pulls.get('microfono');
            if (pullMic && pullMic.track) {
                adjuntarAudio(pullMic.track);
                audiosVivos.add(pullMic.track.id);
            }
            st.calidades.set(p.id, p.calidad);
        });

        // Quitar lo que ya no existe
        Array.from(st.tiles.keys()).forEach((clave) => {
            if (!clavesVivas.has(clave)) quitarTile(clave);
        });
        Array.from(st.audios.keys()).forEach((id) => {
            if (!audiosVivos.has(id)) quitarAudio(st.audios.get(id).track);
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

        const remotos = Array.from(motor.remotos.values()).filter((p) => !p.salio).length;
        ui.vacio.hidden = st.tiles.size > 0;
        ui.contador.textContent = String(remotos + 1);

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
            identidad: participante.id,
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
            tile.track = track || null;
            tile.video.srcObject = track ? new MediaStream([track]) : null;
            if (track) tile.video.play().catch(() => { /* se reintenta al tocar la pantalla */ });
        }

        // Chrome marca la pista "muted" cuando no llegan datos (conexión lenta o recién conectado)
        const sinDatos = Boolean(tile.track && tile.track.muted);
        tile.el.classList.toggle('sin-video', !tile.track || sinDatos);
        tile.el.classList.toggle('pausado', false);
    }

    function quitarTile(clave) {
        const tile = st.tiles.get(clave);
        if (!tile) return;
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
        const yo = st.motor && st.motor.id;
        ui.pip.classList.toggle('hablando', Boolean(yo && st.hablando.has(yo)));
    }

    const TEXTO_CALIDAD = {
        excelente: 'Excelente',
        buena: 'Buena',
        mala: 'Débil',
        perdida: 'Perdida',
        desconocida: 'Midiendo…'
    };

    function aplicarCalidades() {
        st.tiles.forEach((tile) => {
            const q = TEXTO_CALIDAD[st.calidades.get(tile.identidad)] ? st.calidades.get(tile.identidad) : 'desconocida';
            tile.calidad.className = 'calidad calidad-' + q;
            tile.calidad.title = 'Conexión: ' + TEXTO_CALIDAD[q];
        });
    }

    function actualizarCalidadLocal(calidad) {
        const q = TEXTO_CALIDAD[calidad] ? calidad : 'desconocida';
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
        const motor = st.motor;
        if (!motor) {
            ui.pip.hidden = true;
            return;
        }

        const track = motor.pistaCamara;
        if (track !== st.pipTrack) {
            st.pipTrack = track;
            ui.videoLocal.srcObject = track ? new MediaStream([track]) : null;
            if (track) ui.videoLocal.play().catch(() => {});
        }

        const eraOculto = ui.pip.hidden;
        ui.pip.hidden = false;
        ui.pip.classList.toggle('sin-video', !track);
        ui.pip.classList.toggle('espejo', Boolean(track) && motor.facingMode === 'user');
        ui.pip.classList.toggle('mic-off', !motor.micActivo);
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
        if (el) el.volume = st.volumen;
    }

    function adjuntarAudio(track) {
        const id = track.id;
        if (!id || st.audios.has(id)) return;

        const el = document.createElement('audio');
        el.autoplay = true;
        el.dataset.track = id;
        el.srcObject = new MediaStream([track]);
        contAudios.appendChild(el);
        aplicarVolumen(track, el);
        st.audios.set(id, { el, track });
        reproducirAudio(el);
    }

    // Los navegadores bloquean el audio hasta que la persona toca la pantalla
    function reproducirAudio(el) {
        const p = el.play();
        if (p && p.catch) {
            p.catch(() => {
                st.audioBloqueado = true;
                ui.avisoAudio.hidden = false;
            });
        }
    }

    function quitarAudio(track) {
        if (!track) return;
        const entrada = st.audios.get(track.id);
        if (!entrada) return;
        entrada.el.srcObject = null;
        entrada.el.remove();
        st.audios.delete(track.id);
    }

    function cambiarVolumen() {
        st.volumen = clamp(Number(ui.volumen.value), 0, 1);
        ui.volumenLabel.textContent = Math.round(st.volumen * 100) + '%';
        st.audios.forEach(({ el, track }) => aplicarVolumen(track, el));
        almacen.guardar('vd_volumen', String(st.volumen));
    }

    async function activarAudio() {
        desbloquearAudioEnGesto();
        st.audioBloqueado = false;
        const intentos = Array.from(st.audios.values()).map(({ el }) => el.play().catch(() => { st.audioBloqueado = true; }));
        intentos.push(ui.videoLocal.play().catch(() => {}));
        st.tiles.forEach((t) => { if (t.track) intentos.push(t.video.play().catch(() => {})); });
        await Promise.all(intentos);
        ui.avisoAudio.hidden = !st.audioBloqueado;
    }

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

        st.pipTrack = null;
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
        const m = st.motor;
        const mic = Boolean(m && m.micActivo);
        const cam = Boolean(m && m.camActiva);
        const pantalla = Boolean(m && m.pantallaActiva);

        setBotonToggle(ui.btnMic, mic, mic ? 'Silenciar micrófono (M)' : 'Activar micrófono (M)');
        setBotonToggle(ui.btnCam, cam, cam ? 'Apagar cámara (V)' : 'Encender cámara (V)');

        ui.btnCompartir.classList.toggle('activo-azul', pantalla);
        ui.btnCompartir.setAttribute('aria-pressed', String(pantalla));
        ui.btnCompartir.dataset.tip = pantalla ? 'Dejar de compartir' : 'Compartir pantalla';

        ui.btnVoltear.disabled = !cam;
    }

    async function alternarMicrofono() {
        const motor = st.motor;
        if (!motor || st.ocupado.mic) return;
        st.ocupado.mic = true;
        ui.btnMic.disabled = true;

        const activar = !motor.micActivo;
        try {
            await motor.setMicrofono(activar);
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
        const motor = st.motor;
        if (!motor || st.ocupado.cam) return;
        st.ocupado.cam = true;
        ui.btnCam.disabled = true;

        const activar = !motor.camActiva;
        try {
            await motor.setCamara(activar);
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
        const motor = st.motor;
        if (!motor || st.ocupado.voltear || !motor.camActiva) return;

        st.ocupado.voltear = true;
        ui.btnVoltear.disabled = true;
        try {
            const etiqueta = await motor.voltearCamara();
            if (etiqueta) toast('Cámara: ' + etiqueta);
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
            } else {
                const dispositivos = await navigator.mediaDevices.enumerateDevices();
                mostrar = dispositivos.filter((d) => d.kind === 'videoinput').length > 1;
            }
        } catch (e) { /* noop */ }
        ui.btnVoltear.hidden = !mostrar;
    }

    async function alternarPantalla() {
        const motor = st.motor;
        if (!motor || st.ocupado.pantalla) return;
        st.ocupado.pantalla = true;
        ui.btnCompartir.disabled = true;

        const activar = !motor.pantallaActiva;
        try {
            await motor.setPantalla(activar);
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
        await destruirMotor();
        mostrarSalida('Saliste de la llamada', 'Volverás a entrar automáticamente en 1 minuto.');
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
        const motor = st.motor;
        const l = [];
        const si = (v) => (v ? 'sí' : 'no');

        l.push(`Ventana Digital ${APP_VERSION} · Video: Cloudflare Realtime`);
        l.push(`Navegador: ${navigator.userAgent}`);
        l.push(`HTTPS: ${si(window.isSecureContext)} · En línea: ${si(navigator.onLine)} · Táctil: ${si(esTactil)}`);
        l.push('');

        if (motor) {
            const r = motor.resumen();
            const q = TEXTO_CALIDAD[motor.calidadLocal] ? motor.calidadLocal : 'desconocida';
            l.push(`Sala: ${st.sala} · Conexión: ${r.conexion} (ICE ${r.ice}) · TURN: ${si(r.usaTurn)}`);
            l.push(`Tú: ${st.nombre} (${r.id}) · Sesión: ${r.sessionId}`);
            l.push(`Calidad de video: ${r.calidadVideo} · Datos recibidos en esta conexión: ${r.mbRecibidos} MB`);
            l.push(`Participantes: ${motor.remotos.size + 1}`);
            l.push(`Tu conexión: ${TEXTO_CALIDAD[q]}`);
            l.push(`Micrófono: ${si(motor.micActivo)} · Cámara: ${si(motor.camActiva)} · Pantalla: ${si(motor.pantallaActiva)}`);
            l.push(`Audio bloqueado por el navegador: ${si(st.audioBloqueado)}`);
            l.push(`Videos remotos: ${st.tiles.size} · Audios remotos: ${st.audios.size}`);
            l.push('');
            motor.remotos.forEach((p) => {
                const qp = TEXTO_CALIDAD[p.calidad] ? p.calidad : 'desconocida';
                const pistas = Array.from(p.pulls.keys()).join(', ');
                l.push(`• ${nombreDe(p)} — conexión ${TEXTO_CALIDAD[qp]} — recibiendo: ${pistas || 'nada aún'}${p.mic ? '' : ' (mic apagado)'}${p.cam ? '' : ' (cámara apagada)'}`);
            });
        } else {
            l.push('Sin conexión a una sala.');
        }

        try {
            const resp = await fetchConTimeout('/health', {}, 5000);
            const h = await resp.json();
            if (h && h.consumo) {
                l.push('');
                l.push(`Consumo estimado del mes (${h.consumo.mes}): ${h.consumo.gbEstimados} GB de ${h.consumo.cupoGratisGb} GB gratis (${h.consumo.porcentaje}%)`);
                l.push('El dato exacto está en el panel de Cloudflare → Realtime.');
            }
        } catch (e) { /* noop */ }

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

    async function cargarConfig(timeoutMs) {
        try {
            const resp = await fetchConTimeout('/api/config', { cache: 'no-store' }, timeoutMs || 8000);
            if (!resp.ok) return null;
            const cfg = await resp.json();
            if (cfg.salaPorDefecto) st.salaDefecto = cfg.salaPorDefecto;
            return cfg;
        } catch (e) {
            // El servidor puede estar "dormido" (Render free); no es crítico aquí
            return null;
        }
    }

    async function entrarAutomatico() {
        if (st.conectando || st.motor) return;
        clearTimeout(st.timerReintento);

        st.nombre = nombreAutomatico();
        st.sala = st.salaDefecto;
        st.quiereMic = parametroActivo('mic');
        st.quiereCam = parametroActivo('cam');
        const calidad = (new URLSearchParams(location.search).get('calidad') || '').toLowerCase();
        st.calidad = window.VDMotor.PRESETS[calidad] ? calidad : '';
        st.intentos = 0;

        ui.lobby.hidden = true;
        await conectar({ primeraVez: true });
    }

    function onEntrar(evento) {
        evento.preventDefault();
        location.reload();
    }

    // Volver a entrar desde la pantalla de salida, con el mismo nombre
    async function volverAEntrar() {
        clearTimeout(st.timerVolver);
        clearTimeout(st.timerApertura);
        if (st.conectando || st.motor) return;
        if (!st.nombre) st.nombre = nombreAutomatico();
        desbloquearAudioEnGesto();
        st.intentos = 0;
        setBotonCargando(ui.btnVolver, true);
        try {
            await conectar({ primeraVez: true });
        } finally {
            setBotonCargando(ui.btnVolver, false);
        }
    }

    function restaurarPreferencias() {
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
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
            return 'Tu navegador no permite videollamadas. Actualízalo o usa Chrome, Safari, Edge o Firefox.';
        }
        if (!window.RTCRtpTransceiver || !('WebSocket' in window)) {
            return 'Tu navegador no es compatible. Actualízalo o usa Chrome, Safari, Edge o Firefox recientes.';
        }
        if (!window.VDMotor) {
            return 'No se pudo cargar el motor de video. Recarga la página.';
        }
        return '';
    }

    // ============================================================
    // LISTENERS GLOBALES
    // ============================================================

    function registrarListenersUI() {
        // Si algún elemento no existe (HTML de otra versión), se omite en vez de romper la app
        const escuchar = (el, evento, fn) => {
            if (el) el.addEventListener(evento, fn);
            else console.warn('[ui] Falta un elemento para el evento', evento);
        };

        escuchar(ui.form, 'submit', onEntrar);

        escuchar(ui.btnMic, 'click', alternarMicrofono);
        escuchar(ui.btnCam, 'click', alternarCamara);
        escuchar(ui.btnVoltear, 'click', voltearCamara);
        escuchar(ui.btnCompartir, 'click', alternarPantalla);
        escuchar(ui.btnInvitar, 'click', invitar);
        escuchar(ui.btnInvitarVacio, 'click', invitar);
        escuchar(ui.btnSalir, 'click', salir);
        escuchar(ui.btnFullscreen, 'click', alternarPantallaCompleta);
        escuchar(ui.btnDiag, 'click', mostrarDiagnostico);
        escuchar(ui.volumen, 'input', cambiarVolumen);

        escuchar(ui.btnActivarAudio, 'click', activarAudio);
        ['pointerdown', 'keydown'].forEach((ev) =>
            document.addEventListener(ev, () => {
                if (st.audioBloqueado) activarAudio();
            })
        );

        // Volver a entrar directamente, sin pasar por el lobby
        escuchar(ui.btnVolver, 'click', volverAEntrar);

        escuchar(ui.btnDiagCerrar, 'click', cerrarDiagnostico);
        escuchar(ui.btnDiagCopiar, 'click', async () => {
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
            if (!st.motor && st.nombre && !st.salidaVoluntaria && !st.conectando && ui.salida.hidden) {
                st.intentos = 0;
                conectar();
            }
        });
        window.addEventListener('offline', () => {
            actualizarEstado('Sin internet. Esperando conexión…', 'error');
        });

        // Volver a la pestaña / app
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || !st.motor) return;
            solicitarWakeLock();
            programarSync();
            if (st.audioBloqueado) ui.avisoAudio.hidden = false;
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
        mostrarCargando('Entrando a la sala…');

        const problema = verificarCompatibilidad();
        if (problema) {
            mostrarErrorFatal(problema);
            return;
        }

        console.info(`Ventana Digital ${APP_VERSION} lista · Cloudflare Realtime`);
        entrarAutomatico();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar, { once: true });
    } else {
        iniciar();
    }
})();

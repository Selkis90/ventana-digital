/* ============================================================
   VENTANA DIGITAL — MOTOR DE VIDEO (Cloudflare Realtime SFU)
   ------------------------------------------------------------
   Una sola conexión WebRTC por navegador contra Cloudflare:
   - "publicar": envía micrófono, cámara y pantalla.
   - "suscribir": recibe las pistas de los demás.
   La lista de participantes llega por WebSocket desde nuestro
   servidor (Render), que también habla con la API de Cloudflare.

   Uso:
     const m = new VDMotor({ nombre, mic, cam, calidad, esMovil });
     m.on('cambio', fn)  m.on('desconectado', fn) …
     await m.conectar();
   ============================================================ */

(function () {
    'use strict';

    // Calidad del video. "normal" mantiene el consumo bajo el cupo gratis
    // incluso con dos equipos prendidos todo el día.
    const PRESETS = {
        alta: {
            camara: { ancho: 1280, alto: 720, fps: 24, kbps: 1500 },
            movil: { ancho: 960, alto: 540, fps: 24, kbps: 900 },
            pantalla: { fps: 15, kbps: 2000 }
        },
        normal: {
            camara: { ancho: 1280, alto: 720, fps: 20, kbps: 1000 },
            movil: { ancho: 960, alto: 540, fps: 20, kbps: 700 },
            pantalla: { fps: 10, kbps: 1200 }
        },
        baja: {
            camara: { ancho: 640, alto: 360, fps: 15, kbps: 400 },
            movil: { ancho: 640, alto: 360, fps: 15, kbps: 350 },
            pantalla: { fps: 5, kbps: 600 }
        }
    };
    const AUDIO_KBPS = 32;
    const TIMEOUT_RPC_MS = 20000;
    const TIMEOUT_CONEXION_MS = 25000;
    const GRACIA_ICE_MS = 10000;      // espera antes de dar por caída la conexión
    const PING_MS = 20000;            // mantiene vivo el WebSocket (y despierto Render)
    const SILENCIO_MAX_MS = 50000;    // sin noticias del servidor = conexión muerta
    const REPORTE_CONSUMO_MS = 60000;

    const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

    function errorConNombre(mensaje, nombre) {
        const e = new Error(mensaje);
        e.name = nombre || 'Error';
        return e;
    }

    // --------------------------------------------------------
    // Pistas "de relleno": permiten negociar audio/video aunque
    // la cámara o el micrófono no estén disponibles al entrar.
    // --------------------------------------------------------
    function pistaVideoVacia() {
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = 90;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
        const stream = c.captureStream ? c.captureStream(1) : null;
        return stream ? stream.getVideoTracks()[0] : null;
    }

    function pistaAudioVacia() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            const ctx = new Ctx();
            const dest = ctx.createMediaStreamDestination();
            const t = dest.stream.getAudioTracks()[0];
            t.addEventListener('ended', () => ctx.close().catch(() => {}));
            return t;
        } catch (e) {
            return null;
        }
    }

    class VDMotor {
        constructor(op) {
            this.op = Object.assign({ nombre: 'Invitado', mic: true, cam: true, calidad: '', esMovil: false }, op);
            this.facingMode = 'user';
            this.handlers = {};

            this.ws = null;
            this.pc = null;
            this.id = null;
            this.sessionId = null;
            this.iceServers = [];
            this.calidad = 'normal';
            this.cerrado = false;
            this.conectado = false;

            this.rpcSeq = 0;
            this.rpcs = new Map();
            this.cola = Promise.resolve();

            // Lo propio
            this.local = {
                microfono: { track: null, transceiver: null, activo: false },
                camara: { track: null, transceiver: null, activo: false },
                pantalla: { track: null, transceiver: null, activo: false }
            };
            this.calidadLocal = 'desconocida';
            this.hablandoLocal = false;

            // Lo de los demás: id -> { id, nombre, mic, cam, calidad, sessionId, tracks, pulls: Map(fuente -> pull) }
            this.remotos = new Map();
            this.porTrackId = new Map(); // MediaStreamTrack.id -> { pid, fuente }
            this.fallosPull = new Map();  // trackName -> intentos
            this.estadoPendiente = null;

            this.hablando = new Set();
            this.timers = {};
            this.ultimoMensaje = Date.now();
            this.bytesRecibidos = 0;
            this.bytesReportados = 0;
            this.statsPrevias = { perdidos: 0, recibidos: 0 };
        }

        // ---------------- Eventos ----------------
        on(evento, fn) {
            (this.handlers[evento] = this.handlers[evento] || []).push(fn);
            return this;
        }

        emit(evento) {
            const args = Array.prototype.slice.call(arguments, 1);
            (this.handlers[evento] || []).forEach((fn) => {
                try { fn.apply(null, args); } catch (e) { console.error('[motor ' + evento + ']', e); }
            });
        }

        // ---------------- Getters útiles para la vista ----------------
        get micActivo() { return this.local.microfono.activo; }
        get camActiva() { return this.local.camara.activo; }
        get pantallaActiva() { return this.local.pantalla.activo; }
        get pistaCamara() { return this.local.camara.activo ? this.local.camara.track : null; }

        // ========================================================
        // CONEXIÓN
        // ========================================================

        async conectar() {
            await this._abrirWs();
            const bienvenida = await this._esperarBienvenida();
            this.id = bienvenida.id;
            this.iceServers = bienvenida.iceServers || [];
            this.calidad = PRESETS[this.op.calidad] ? this.op.calidad : (PRESETS[bienvenida.calidad] ? bienvenida.calidad : 'normal');
            this.estadoPendiente = bienvenida.participantes || [];

            await this._capturarMedios();
            if (this.cerrado) throw errorConNombre('Conexión cancelada', 'AbortError');

            this.pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
            this.pc.addEventListener('connectionstatechange', () => this._alCambiarConexion());
            this.pc.addEventListener('track', (ev) => this._registrarPistaRemota(ev.track, ev.transceiver));

            const { sessionId } = await this.rpc('sesion');
            this.sessionId = sessionId;

            await this._enCola(() => this._publicarIniciales());
            await this._esperarConexion();

            this.conectado = true;
            this._iniciarCiclos();
            this._enviarMedios();

            const pendiente = this.estadoPendiente;
            this.estadoPendiente = null;
            this._aplicarEstado(pendiente);
        }

        desconectar() {
            this._fin('voluntario');
        }

        _abrirWs() {
            return new Promise((resolve, reject) => {
                const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
                let ws;
                try {
                    ws = new WebSocket(url);
                } catch (e) {
                    return reject(e);
                }
                this.ws = ws;
                const timer = setTimeout(() => {
                    try { ws.close(); } catch (e) { /* noop */ }
                    reject(errorConNombre('El servidor tardó demasiado en responder.', 'AbortError'));
                }, TIMEOUT_CONEXION_MS);

                ws.onopen = () => {
                    clearTimeout(timer);
                    resolve();
                };
                ws.onerror = () => { /* el detalle llega en onclose */ };
                ws.onclose = (ev) => {
                    clearTimeout(timer);
                    reject(errorConNombre('No se pudo conectar con el servidor.', 'WsError'));
                    this._alCerrarWs(ev);
                };
                ws.onmessage = (ev) => this._alMensaje(ev.data);
            });
        }

        _esperarBienvenida() {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(errorConNombre('El servidor no respondió.', 'AbortError')), TIMEOUT_CONEXION_MS);
                this._resolverBienvenida = (msg) => {
                    clearTimeout(timer);
                    this._resolverBienvenida = null;
                    this._rechazarBienvenida = null;
                    resolve(msg);
                };
                this._rechazarBienvenida = (err) => {
                    clearTimeout(timer);
                    this._resolverBienvenida = null;
                    this._rechazarBienvenida = null;
                    reject(err);
                };
                this._enviar({ t: 'unirse', nombre: this.op.nombre, mic: this.op.mic, cam: this.op.cam });
            });
        }

        _esperarConexion() {
            const pc = this.pc;
            if (pc.connectionState === 'connected') return Promise.resolve();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pc.removeEventListener('connectionstatechange', revisar);
                    reject(errorConNombre('No se pudo conectar con el servidor de video. Si estás en una red de empresa, puede estar bloqueando las videollamadas.', 'IceError'));
                }, TIMEOUT_CONEXION_MS);
                const revisar = () => {
                    if (pc.connectionState === 'connected') {
                        clearTimeout(timer);
                        pc.removeEventListener('connectionstatechange', revisar);
                        resolve();
                    } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                        clearTimeout(timer);
                        pc.removeEventListener('connectionstatechange', revisar);
                        reject(errorConNombre('La conexión de video falló.', 'IceError'));
                    }
                };
                pc.addEventListener('connectionstatechange', revisar);
            });
        }

        _alCambiarConexion() {
            if (!this.pc || this.cerrado) return;
            const estado = this.pc.connectionState;
            if (!this.conectado) return; // durante conectar() lo maneja _esperarConexion

            if (estado === 'connected') {
                clearTimeout(this.timers.gracia);
                this.timers.gracia = null;
                this.emit('reconectado');
            } else if (estado === 'disconnected') {
                this.emit('inestable');
                if (!this.timers.gracia) {
                    this.timers.gracia = setTimeout(() => this._fin('ice'), GRACIA_ICE_MS);
                }
            } else if (estado === 'failed') {
                this._fin('ice');
            }
        }

        _alCerrarWs(ev) {
            if (this._rechazarBienvenida) {
                this._rechazarBienvenida(this._errorServidor || errorConNombre('Se perdió la conexión con el servidor.', 'WsError'));
            }
            this._fin(ev && ev.code === 4001 ? 'horario' : 'servidor');
        }

        _fin(motivo) {
            if (this.cerrado) return;
            this.cerrado = true;
            const estabaConectado = this.conectado;
            this.conectado = false;

            Object.values(this.timers).forEach((t) => { clearTimeout(t); clearInterval(t); });
            this.timers = {};
            this.rpcs.forEach(({ reject, timer }) => {
                clearTimeout(timer);
                reject(errorConNombre('Conexión cerrada', 'AbortError'));
            });
            this.rpcs.clear();

            Object.values(this.local).forEach((l) => {
                if (l.track) { try { l.track.stop(); } catch (e) { /* noop */ } }
                l.track = null;
                l.activo = false;
            });
            if (this.pc) { try { this.pc.close(); } catch (e) { /* noop */ } }
            if (this.ws) {
                this.ws.onclose = null;
                this.ws.onmessage = null;
                try { this.ws.close(1000); } catch (e) { /* noop */ }
            }
            this.remotos.clear();
            this.porTrackId.clear();
            this.hablando.clear();

            if (motivo === 'horario') {
                this.emit('cierre', this._msCambio || null);
            } else {
                this.emit('desconectado', { motivo, voluntario: motivo === 'voluntario', estabaConectado, error: this._errorServidor || null });
            }
        }

        // ========================================================
        // MENSAJES DEL SERVIDOR
        // ========================================================

        _enviar(msg) {
            if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
        }

        _alMensaje(texto) {
            this.ultimoMensaje = Date.now();
            let msg;
            try { msg = JSON.parse(texto); } catch (e) { return; }

            switch (msg.t) {
                case 'bienvenida':
                    if (this._resolverBienvenida) this._resolverBienvenida(msg);
                    break;
                case 'estado':
                    if (this.estadoPendiente !== null) this.estadoPendiente = msg.participantes;
                    else this._aplicarEstado(msg.participantes);
                    break;
                case 'rpc': {
                    const p = this.rpcs.get(msg.id);
                    if (!p) return;
                    this.rpcs.delete(msg.id);
                    clearTimeout(p.timer);
                    if (msg.ok) p.resolve(msg.resultado || {});
                    else p.reject(Object.assign(new Error(msg.error || 'Error del servidor'), { codigo: msg.codigo }));
                    break;
                }
                case 'cierre':
                    this._msCambio = msg.msCambio;
                    break;
                case 'error':
                    this._errorServidor = Object.assign(new Error(msg.error), { status: msg.llena ? 409 : 503, fatal: true });
                    break;
                default:
            }
        }

        rpc(metodo, datos) {
            return new Promise((resolve, reject) => {
                if (!this.ws || this.ws.readyState !== 1) {
                    return reject(errorConNombre('Sin conexión con el servidor', 'WsError'));
                }
                const id = ++this.rpcSeq;
                const timer = setTimeout(() => {
                    this.rpcs.delete(id);
                    reject(errorConNombre('El servidor tardó demasiado (' + metodo + ')', 'AbortError'));
                }, TIMEOUT_RPC_MS);
                this.rpcs.set(id, { resolve, reject, timer });
                this._enviar({ t: 'rpc', id, metodo, datos });
            });
        }

        // Todas las negociaciones van en fila: evita choques de SDP
        _enCola(fn) {
            const r = this.cola.then(() => (this.cerrado ? null : fn()));
            this.cola = r.catch(() => {});
            return r;
        }

        // ========================================================
        // MEDIOS LOCALES
        // ========================================================

        _restriccionesVideo() {
            const p = PRESETS[this.calidad][this.op.esMovil ? 'movil' : 'camara'];
            return {
                width: { ideal: p.ancho },
                height: { ideal: p.alto },
                frameRate: { ideal: p.fps, max: p.fps },
                facingMode: this.facingMode
            };
        }

        _codificacionVideo(fuente) {
            const P = PRESETS[this.calidad];
            const p = fuente === 'pantalla' ? P.pantalla : P[this.op.esMovil ? 'movil' : 'camara'];
            return [{ maxBitrate: p.kbps * 1000, maxFramerate: p.fps }];
        }

        async _capturarMedios() {
            const quiereMic = this.op.mic;
            const quiereCam = this.op.cam;
            if (!quiereMic && !quiereCam) return;

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: quiereMic ? AUDIO_CONSTRAINTS : false,
                    video: quiereCam ? this._restriccionesVideo() : false
                });
                this._guardarPistas(stream);
                return;
            } catch (e) {
                console.warn('[medios] Falló la captura conjunta, probando por separado', e);
            }

            if (quiereMic) {
                try {
                    this._guardarPistas(await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS }));
                } catch (e) {
                    this.emit('errorDispositivo', e, 'micrófono');
                }
            }
            if (quiereCam) {
                try {
                    this._guardarPistas(await navigator.mediaDevices.getUserMedia({ video: this._restriccionesVideo() }));
                } catch (e) {
                    this.emit('errorDispositivo', e, 'cámara');
                }
            }
        }

        _guardarPistas(stream) {
            const a = stream.getAudioTracks()[0];
            const v = stream.getVideoTracks()[0];
            if (a) {
                this.local.microfono.track = a;
                this.local.microfono.activo = true;
            }
            if (v) {
                v.contentHint = 'motion';
                this.local.camara.track = v;
                this.local.camara.activo = true;
                this._vigilarFinCamara(v);
            }
        }

        // Si la cámara se desconecta (USB) o el sistema la quita
        _vigilarFinCamara(track) {
            track.addEventListener('ended', () => {
                if (this.local.camara.track !== track || this.cerrado) return;
                this.local.camara.track = null;
                this.local.camara.activo = false;
                if (this.local.camara.transceiver) this.local.camara.transceiver.sender.replaceTrack(null).catch(() => {});
                this._enviarMedios();
                this.emit('cambioLocal');
            });
        }

        async _publicarIniciales() {
            const pc = this.pc;
            const relleno = [];

            const mic = this.local.microfono;
            let pistaMic = mic.track;
            if (!pistaMic) { pistaMic = pistaAudioVacia(); if (pistaMic) relleno.push(pistaMic); }
            mic.transceiver = pc.addTransceiver(pistaMic || 'audio', {
                direction: 'sendonly',
                sendEncodings: [{ maxBitrate: AUDIO_KBPS * 1000 }]
            });

            const cam = this.local.camara;
            let pistaCam = cam.track;
            if (!pistaCam) { pistaCam = pistaVideoVacia(); if (pistaCam) relleno.push(pistaCam); }
            cam.transceiver = pc.addTransceiver(pistaCam || 'video', {
                direction: 'sendonly',
                sendEncodings: this._codificacionVideo('camara')
            });

            await this._publicar([
                { transceiver: mic.transceiver, fuente: 'microfono' },
                { transceiver: cam.transceiver, fuente: 'camara' }
            ]);

            // Las pistas de relleno se quitan: no se envía nada hasta que se active el dispositivo
            for (const t of relleno) {
                if (t.kind === 'audio') await mic.transceiver.sender.replaceTrack(null);
                else await cam.transceiver.sender.replaceTrack(null);
                t.stop();
            }
        }

        async _publicar(items) {
            const pc = this.pc;
            const oferta = await pc.createOffer();
            await pc.setLocalDescription(oferta);
            const r = await this.rpc('publicar', {
                sdp: pc.localDescription.sdp,
                tracks: items.map((i) => ({ mid: i.transceiver.mid, fuente: i.fuente }))
            });
            await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
            if (r.errores && r.errores.length) console.warn('[publicar] Pistas con error:', r.errores);
        }

        _enviarMedios() {
            this._enviar({ t: 'medios', mic: this.local.microfono.activo, cam: this.local.camara.activo });
        }

        async setMicrofono(activar) {
            const mic = this.local.microfono;
            if (activar) {
                if (!mic.track || mic.track.readyState === 'ended') {
                    const s = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
                    mic.track = s.getAudioTracks()[0];
                    if (mic.transceiver) await mic.transceiver.sender.replaceTrack(mic.track);
                }
                mic.track.enabled = true;
                mic.activo = true;
            } else {
                if (mic.track) mic.track.enabled = false;
                mic.activo = false;
            }
            this._enviarMedios();
            this.emit('cambioLocal');
        }

        async setCamara(activar) {
            const cam = this.local.camara;
            if (activar) {
                const s = await navigator.mediaDevices.getUserMedia({ video: this._restriccionesVideo() });
                const nueva = s.getVideoTracks()[0];
                nueva.contentHint = 'motion';
                if (cam.track) cam.track.stop();
                cam.track = nueva;
                this._vigilarFinCamara(nueva);
                if (cam.transceiver) await cam.transceiver.sender.replaceTrack(nueva);
                cam.activo = true;
            } else {
                // Apagar de verdad: se libera la cámara (se apaga la luz) y no se envían datos
                if (cam.transceiver) await cam.transceiver.sender.replaceTrack(null);
                if (cam.track) cam.track.stop();
                cam.track = null;
                cam.activo = false;
            }
            this._enviarMedios();
            this.emit('cambioLocal');
        }

        // Móvil: frontal/trasera. Escritorio: siguiente cámara conectada.
        async voltearCamara() {
            const cam = this.local.camara;
            if (!cam.activo) return null;
            let restricciones = this._restriccionesVideo();
            let etiqueta = '';

            if (this.op.esMovil) {
                this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
                restricciones = this._restriccionesVideo();
            } else {
                const lista = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
                if (lista.length < 2) return null;
                const actual = cam.track && cam.track.getSettings ? cam.track.getSettings().deviceId : null;
                const idx = lista.findIndex((d) => d.deviceId === actual);
                const siguiente = lista[(idx + 1) % lista.length];
                delete restricciones.facingMode;
                restricciones.deviceId = { exact: siguiente.deviceId };
                etiqueta = siguiente.label;
            }

            // En móviles hay que soltar la cámara actual antes de abrir la otra
            if (this.op.esMovil && cam.track) cam.track.stop();
            let nueva;
            try {
                nueva = (await navigator.mediaDevices.getUserMedia({ video: restricciones })).getVideoTracks()[0];
            } catch (e) {
                if (this.op.esMovil) {
                    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
                    await this.setCamara(true);
                }
                throw e;
            }
            nueva.contentHint = 'motion';
            if (cam.track && cam.track !== nueva) cam.track.stop();
            cam.track = nueva;
            this._vigilarFinCamara(nueva);
            await cam.transceiver.sender.replaceTrack(nueva);
            this.emit('cambioLocal');
            return etiqueta || null;
        }

        async setPantalla(activar) {
            const pan = this.local.pantalla;
            if (activar) {
                if (pan.activo) return;
                const P = PRESETS[this.calidad].pantalla;
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: { frameRate: { ideal: P.fps, max: P.fps } },
                    audio: false
                });
                const track = stream.getVideoTracks()[0];
                track.contentHint = 'detail';
                track.addEventListener('ended', () => {
                    if (pan.track === track) this.setPantalla(false).catch(() => {});
                });
                pan.track = track;
                pan.activo = true;
                this.emit('cambioLocal');
                try {
                    await this._enCola(async () => {
                        pan.transceiver = this.pc.addTransceiver(track, {
                            direction: 'sendonly',
                            sendEncodings: this._codificacionVideo('pantalla')
                        });
                        await this._publicar([{ transceiver: pan.transceiver, fuente: 'pantalla' }]);
                    });
                } catch (e) {
                    track.stop();
                    pan.track = null;
                    pan.activo = false;
                    this.emit('cambioLocal');
                    throw e;
                }
            } else {
                if (!pan.activo) return;
                const track = pan.track;
                const tr = pan.transceiver;
                pan.track = null;
                pan.transceiver = null;
                pan.activo = false;
                if (track) track.stop();
                this.emit('cambioLocal');
                if (tr) {
                    await this._enCola(() => this._cerrarTransceivers([tr], ['pantalla']));
                }
            }
        }

        // Cierra pistas (propias o recibidas) en Cloudflare y en el navegador
        async _cerrarTransceivers(transceivers, fuentes) {
            const pc = this.pc;
            const mids = transceivers.map((t) => t.mid).filter((m) => m !== null && m !== undefined);
            transceivers.forEach((t) => {
                try { t.stop(); } catch (e) { /* noop */ }
            });
            if (!mids.length) return;
            try {
                const oferta = await pc.createOffer();
                await pc.setLocalDescription(oferta);
                const r = await this.rpc('cerrar', { mids, sdp: pc.localDescription.sdp, fuentes: fuentes || [] });
                await this._aplicarSdpRemota(r);
            } catch (e) {
                console.warn('[cerrar] No se pudo cerrar en Cloudflare', e);
                // Si la negociación quedó a medias, se vuelve a un estado estable
                if (pc.signalingState === 'have-local-offer') {
                    try { await pc.setLocalDescription({ type: 'rollback' }); } catch (e2) { /* noop */ }
                }
                if (fuentes && fuentes.length) {
                    this.rpc('cerrar', { mids, fuentes }).catch(() => {});
                }
            }
        }

        async _aplicarSdpRemota(r) {
            if (!r || !r.sdp) return;
            const pc = this.pc;
            if (r.tipo === 'offer') {
                await pc.setRemoteDescription({ type: 'offer', sdp: r.sdp });
                const respuesta = await pc.createAnswer();
                await pc.setLocalDescription(respuesta);
                await this.rpc('renegociar', { sdp: pc.localDescription.sdp });
            } else {
                await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
            }
        }

        // ========================================================
        // PISTAS REMOTAS
        // ========================================================

        _aplicarEstado(lista) {
            if (!Array.isArray(lista)) return;
            const vistos = new Set();

            lista.forEach((info) => {
                if (info.id === this.id) return;
                vistos.add(info.id);
                let r = this.remotos.get(info.id);
                const nuevo = !r;
                if (!r) {
                    r = { id: info.id, pulls: new Map(), pendientes: new Set() };
                    this.remotos.set(info.id, r);
                }
                r.nombre = info.nombre || 'Invitado';
                r.mic = info.mic !== false;
                r.cam = info.cam !== false;
                r.calidad = info.calidad || 'desconocida';
                r.sessionId = info.sessionId;
                r.tracks = info.tracks || {};
                if (nuevo && this.conectado) this.emit('entro', r);
            });

            const salieron = [];
            this.remotos.forEach((r, id) => {
                if (!vistos.has(id)) salieron.push(r);
            });
            salieron.forEach((r) => {
                r.salio = true;
                this.emit('salio', r);
            });

            this._sincronizarPulls();
            this.emit('cambio');
        }

        _sincronizarPulls() {
            if (this.timers.sync) return;
            this.timers.sync = setTimeout(() => {
                this.timers.sync = null;
                this._enCola(() => this._hacerSyncPulls()).catch((e) => {
                    console.warn('[suscribir]', e);
                    this._reintentarSync();
                });
            }, 30);
        }

        _reintentarSync() {
            if (this.cerrado || this.timers.reintentoSync) return;
            this.timers.reintentoSync = setTimeout(() => {
                this.timers.reintentoSync = null;
                this._sincronizarPulls();
            }, 2000);
        }

        async _hacerSyncPulls() {
            if (!this.pc || this.cerrado) return;

            // 1) Cerrar lo que ya no existe (persona que salió o dejó de compartir)
            const cerrar = [];
            this.remotos.forEach((r) => {
                r.pulls.forEach((pull, fuente) => {
                    if (r.salio || r.tracks[fuente] !== pull.trackName) {
                        cerrar.push(pull.transceiver);
                        r.pulls.delete(fuente);
                        this.porTrackId.delete(pull.track && pull.track.id);
                    }
                });
            });
            this.remotos.forEach((r, id) => {
                if (r.salio) this.remotos.delete(id);
            });
            if (cerrar.length) {
                await this._cerrarTransceivers(cerrar);
                this.emit('cambio');
            }

            // 2) Pedir lo nuevo
            const pedir = [];
            this.remotos.forEach((r) => {
                Object.keys(r.tracks).forEach((fuente) => {
                    if (!r.pulls.has(fuente) && (this.fallosPull.get(r.tracks[fuente]) || 0) < 15) {
                        pedir.push({ participante: r.id, fuente });
                    }
                });
            });
            if (!pedir.length) return;

            const res = await this.rpc('suscribir', { tracks: pedir });
            if (res.sdp) await this._aplicarSdpRemota(res);

            let conError = false;
            (res.tracks || []).forEach((t) => {
                const r = this.remotos.get(t.participante);
                if (t.error || t.mid === null) {
                    conError = true;
                    this.fallosPull.set(t.trackName, (this.fallosPull.get(t.trackName) || 0) + 1);
                    console.warn('[suscribir] Pista no disponible todavía:', t.trackName, t.error);
                    return;
                }
                const transceiver = this.pc.getTransceivers().find((x) => x.mid === t.mid);
                if (!r || !transceiver) return;
                this.fallosPull.delete(t.trackName);
                const track = transceiver.receiver.track;
                const pull = { trackName: t.trackName, mid: t.mid, transceiver, track };
                r.pulls.set(t.fuente, pull);
                this.porTrackId.set(track.id, { pid: r.id, fuente: t.fuente });
                track.addEventListener('mute', () => this.emit('cambio'));
                track.addEventListener('unmute', () => this.emit('cambio'));
            });

            this.emit('cambio');
            if (conError) this._reintentarSync();
        }

        _registrarPistaRemota() {
            // Las pistas se asocian por "mid" en _hacerSyncPulls; aquí solo se refresca la vista
            this.emit('cambio');
        }

        // ========================================================
        // ESTADÍSTICAS: calidad, quién habla y consumo
        // ========================================================

        _iniciarCiclos() {
            this.timers.stats = setInterval(() => this._leerStats(), 1000);
            this.timers.ping = setInterval(() => {
                if (Date.now() - this.ultimoMensaje > SILENCIO_MAX_MS) {
                    console.warn('[motor] El servidor dejó de responder');
                    this._fin('servidor');
                    return;
                }
                this._enviar({ t: 'ping' });
            }, PING_MS);
            this.timers.consumo = setInterval(() => this._reportarConsumo(), REPORTE_CONSUMO_MS);
        }

        _reportarConsumo() {
            const delta = this.bytesRecibidos - this.bytesReportados;
            if (delta > 0) {
                this._enviar({ t: 'consumo', bytes: delta });
                this.bytesReportados = this.bytesRecibidos;
            }
        }

        async _leerStats() {
            if (!this.pc || this.cerrado) return;
            let stats;
            try { stats = await this.pc.getStats(); } catch (e) { return; }

            let bytes = 0;
            let rtt = null;
            let perdidos = 0;
            let recibidos = 0;
            let perdidaRemota = null;
            let nivelLocal = 0;
            const hablando = new Set();

            stats.forEach((s) => {
                if (s.type === 'inbound-rtp') {
                    bytes += (s.bytesReceived || 0) + (s.headerBytesReceived || 0);
                    perdidos += s.packetsLost || 0;
                    recibidos += s.packetsReceived || 0;
                    if (s.kind === 'audio' && typeof s.audioLevel === 'number' && s.audioLevel > 0.02) {
                        const ref = this.porTrackId.get(s.trackIdentifier);
                        if (ref) {
                            const r = this.remotos.get(ref.pid);
                            if (r && r.mic) hablando.add(ref.pid);
                        }
                    }
                } else if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
                    if (typeof s.currentRoundTripTime === 'number') rtt = s.currentRoundTripTime;
                } else if (s.type === 'remote-inbound-rtp' && typeof s.fractionLost === 'number') {
                    perdidaRemota = Math.max(perdidaRemota || 0, s.fractionLost);
                } else if (s.type === 'media-source' && s.kind === 'audio' && typeof s.audioLevel === 'number') {
                    nivelLocal = s.audioLevel;
                }
            });

            this.bytesRecibidos = Math.max(this.bytesRecibidos, bytes);

            // Pérdida de paquetes recibidos en el último segundo
            const dPerd = Math.max(0, perdidos - this.statsPrevias.perdidos);
            const dRec = Math.max(0, recibidos - this.statsPrevias.recibidos);
            this.statsPrevias = { perdidos, recibidos };
            const perdidaEntrada = dRec + dPerd > 0 ? dPerd / (dRec + dPerd) : 0;
            const perdida = Math.max(perdidaEntrada, perdidaRemota || 0);

            let q = 'desconocida';
            if (this.pc.connectionState !== 'connected') q = 'perdida';
            else if (rtt !== null) {
                if (rtt < 0.15 && perdida < 0.02) q = 'excelente';
                else if (rtt < 0.4 && perdida < 0.08) q = 'buena';
                else q = 'mala';
            }
            if (q !== this.calidadLocal) {
                this.calidadLocal = q;
                this._enviar({ t: 'calidad', q });
                this.emit('calidad', q);
            }

            if (this.local.microfono.activo && nivelLocal > 0.02) hablando.add(this.id);
            const antes = Array.from(this.hablando).sort().join(',');
            const ahora = Array.from(hablando).sort().join(',');
            if (antes !== ahora) {
                this.hablando = hablando;
                this.emit('hablando', hablando);
            }
        }

        // Datos para la ventana de diagnóstico
        resumen() {
            return {
                id: this.id,
                sessionId: this.sessionId,
                calidadVideo: this.calidad,
                conexion: this.pc ? this.pc.connectionState : 'sin conexión',
                ice: this.pc ? this.pc.iceConnectionState : '-',
                usaTurn: this.iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u))),
                mbRecibidos: Math.round(this.bytesRecibidos / 1e5) / 10
            };
        }
    }

    VDMotor.PRESETS = PRESETS;
    window.VDMotor = VDMotor;
})();

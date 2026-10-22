'use strict';

/**
 * Ventana Digital — sala por WebSocket
 * --------------------------------------------------------------
 * Cloudflare Realtime solo mueve audio y video; no sabe quién está
 * en la sala. Este módulo lleva esa lista y hace de intermediario:
 *
 *   navegador ──WebSocket──> este servidor ──HTTPS──> Cloudflare
 *
 * Mensajes del navegador:
 *   { t: 'unirse', nombre, mic, cam }
 *   { t: 'rpc', id, metodo, datos }   metodo: sesion | publicar | suscribir | renegociar | cerrar
 *   { t: 'medios', mic, cam }
 *   { t: 'calidad', q }
 *   { t: 'consumo', bytes }
 *   { t: 'ping' }
 *
 * Mensajes del servidor:
 *   { t: 'bienvenida', id, iceServers, calidad, participantes }
 *   { t: 'estado', participantes }
 *   { t: 'rpc', id, ok, resultado | error }
 *   { t: 'cierre', msCambio }          fuera de horario
 *   { t: 'error', error }
 *   { t: 'pong' }
 */

const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const FUENTES = new Set(['microfono', 'camara', 'pantalla']);
const CALIDADES = new Set(['excelente', 'buena', 'mala', 'perdida', 'desconocida']);
const LATIDO_MS = 25000;

function crearSala({ server, cf, config, horario, consumo, limpiarNombre }) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
    const participantes = new Map(); // id -> participante
    let timerDifusion = null;

    // ---------- Conexión (upgrade) ----------
    const conexionesPorIp = new Map();
    setInterval(() => conexionesPorIp.clear(), 60000).unref();

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname !== '/ws') return socket.destroy();

        // Solo se aceptan conexiones desde la misma página (o ALLOWED_ORIGINS)
        const origen = req.headers.origin || '';
        const host = req.headers['x-forwarded-host'] || req.headers.host || '';
        let mismoOrigen = false;
        try { mismoOrigen = new URL(origen).host === host; } catch (e) { /* sin origen */ }
        if (!mismoOrigen && !config.origenesPermitidos.includes(origen)) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            return socket.destroy();
        }

        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const n = (conexionesPorIp.get(ip) || 0) + 1;
        conexionesPorIp.set(ip, n);
        if (n > 30) {
            socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
            return socket.destroy();
        }

        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    // ---------- Utilidades ----------
    function enviar(ws, msg) {
        if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    }

    function publico(p) {
        return {
            id: p.id,
            nombre: p.nombre,
            sessionId: p.sessionId,
            tracks: Object.assign({}, p.tracks),
            mic: p.mic,
            cam: p.cam,
            calidad: p.calidad
        };
    }

    function lista() {
        return Array.from(participantes.values()).filter((p) => p.unido).map(publico);
    }

    // Agrupa cambios seguidos en un solo mensaje
    function difundir() {
        if (timerDifusion) return;
        timerDifusion = setTimeout(() => {
            timerDifusion = null;
            const msg = { t: 'estado', participantes: lista() };
            participantes.forEach((p) => p.unido && enviar(p.ws, msg));
        }, 40);
    }

    function sacar(p) {
        if (!participantes.has(p.id)) return;
        participantes.delete(p.id);
        if (p.unido) {
            console.log(`[sala] Salió: ${p.nombre} (${p.id}) · quedan ${lista().length}`);
            difundir();
        }
    }

    // ---------- RPC hacia Cloudflare ----------
    const rpc = {
        async sesion(p) {
            if (!p.sessionId) {
                const r = await cf.nuevaSesion();
                p.sessionId = r.sessionId;
            }
            return { sessionId: p.sessionId };
        },

        // Publicar pistas propias: { sdp (offer), tracks: [{ mid, fuente }] }
        async publicar(p, d) {
            if (!p.sessionId) throw new Error('Sin sesión');
            const tracks = (d.tracks || []).filter((t) => FUENTES.has(t.fuente) && t.mid !== undefined);
            if (!tracks.length || typeof d.sdp !== 'string') throw new Error('Datos inválidos');

            const r = await cf.tracksNuevos(p.sessionId, {
                sessionDescription: { type: 'offer', sdp: d.sdp },
                tracks: tracks.map((t) => ({
                    location: 'local',
                    mid: String(t.mid),
                    trackName: `${p.id}-${t.fuente}`
                }))
            });

            const errores = (r.tracks || []).filter((t) => t.errorCode);
            (r.tracks || []).forEach((t) => {
                if (t.errorCode) return;
                const fuente = String(t.trackName || '').slice(p.id.length + 1);
                if (FUENTES.has(fuente)) p.tracks[fuente] = t.trackName;
            });
            difundir();
            return {
                sdp: r.sessionDescription && r.sessionDescription.sdp,
                tipo: r.sessionDescription && r.sessionDescription.type,
                errores: errores.map((t) => ({ trackName: t.trackName, error: t.errorDescription || t.errorCode }))
            };
        },

        // Recibir pistas de otros: { tracks: [{ participante, fuente }] }
        async suscribir(p, d) {
            if (!p.sessionId) throw new Error('Sin sesión');
            const pedidos = [];
            for (const t of d.tracks || []) {
                const otro = participantes.get(t.participante);
                if (!otro || otro === p || !otro.sessionId || !otro.tracks[t.fuente]) continue;
                pedidos.push({ participante: otro.id, fuente: t.fuente, sessionId: otro.sessionId, trackName: otro.tracks[t.fuente] });
            }
            if (!pedidos.length) return { tracks: [] };

            const r = await cf.tracksNuevos(p.sessionId, {
                tracks: pedidos.map((x) => ({ location: 'remote', sessionId: x.sessionId, trackName: x.trackName }))
            });

            const tracks = pedidos.map((x) => {
                const res = (r.tracks || []).find((t) => t.trackName === x.trackName && (!t.sessionId || t.sessionId === x.sessionId)) || {};
                return {
                    participante: x.participante,
                    fuente: x.fuente,
                    trackName: x.trackName,
                    mid: res.mid !== undefined ? String(res.mid) : null,
                    error: res.errorCode ? (res.errorDescription || res.errorCode) : (res.mid === undefined ? 'sin_mid' : null)
                };
            });
            return {
                renegociar: Boolean(r.requiresImmediateRenegotiation),
                sdp: r.sessionDescription && r.sessionDescription.sdp,
                tipo: r.sessionDescription && r.sessionDescription.type,
                tracks
            };
        },

        async renegociar(p, d) {
            if (!p.sessionId || typeof d.sdp !== 'string') throw new Error('Datos inválidos');
            const r = await cf.renegociar(p.sessionId, d.sdp);
            return { sdp: r.sessionDescription && r.sessionDescription.sdp, tipo: r.sessionDescription && r.sessionDescription.type };
        },

        // Cerrar pistas (propias o recibidas): { mids, sdp (offer), fuentes? }
        async cerrar(p, d) {
            if (!p.sessionId) throw new Error('Sin sesión');
            const mids = (d.mids || []).map(String).filter(Boolean);
            if (!mids.length) return {};
            const cuerpo = { tracks: mids.map((mid) => ({ mid })), force: typeof d.sdp !== 'string' };
            if (typeof d.sdp === 'string') cuerpo.sessionDescription = { type: 'offer', sdp: d.sdp };

            // Las pistas propias dejan de anunciarse aunque Cloudflare falle
            let cambio = false;
            (d.fuentes || []).forEach((f) => {
                if (FUENTES.has(f) && p.tracks[f]) {
                    delete p.tracks[f];
                    cambio = true;
                }
            });
            if (cambio) difundir();

            const r = await cf.cerrarTracks(p.sessionId, cuerpo);
            return {
                renegociar: Boolean(r.requiresImmediateRenegotiation),
                sdp: r.sessionDescription && r.sessionDescription.sdp,
                tipo: r.sessionDescription && r.sessionDescription.type
            };
        }
    };

    // ---------- Mensajes ----------
    async function alUnirse(p, msg) {
        if (p.unido) return;

        const h = horario.estado();
        if (!h.activo) {
            enviar(p.ws, { t: 'cierre', msCambio: h.msCambio });
            return p.ws.close(4001, 'fuera de horario');
        }
        if (!cf.configurado) {
            enviar(p.ws, { t: 'error', error: 'La sala no está configurada todavía (faltan CF_APP_ID y CF_APP_TOKEN).' });
            return p.ws.close(4002, 'sin configurar');
        }
        if (lista().length >= config.maxParticipantes) {
            enviar(p.ws, { t: 'error', error: `La sala está llena (máximo ${config.maxParticipantes} personas).`, llena: true });
            return p.ws.close(4003, 'sala llena');
        }

        p.nombre = limpiarNombre(msg.nombre) || 'Invitado';
        p.mic = msg.mic !== false;
        p.cam = msg.cam !== false;
        p.unido = true;

        let iceServers;
        try {
            iceServers = await cf.servidoresIce();
        } catch (e) {
            iceServers = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
        }

        console.log(`[sala] Entró: ${p.nombre} (${p.id}) · ahora ${lista().length}`);
        enviar(p.ws, {
            t: 'bienvenida',
            id: p.id,
            iceServers,
            calidad: config.calidad,
            participantes: lista()
        });
        difundir();
    }

    async function alRpc(p, msg) {
        const fn = rpc[msg.metodo];
        if (!p.unido || !fn || !Object.prototype.hasOwnProperty.call(rpc, msg.metodo)) {
            return enviar(p.ws, { t: 'rpc', id: msg.id, ok: false, error: 'Método no permitido' });
        }
        try {
            const resultado = await fn(p, msg.datos || {});
            enviar(p.ws, { t: 'rpc', id: msg.id, ok: true, resultado });
        } catch (error) {
            console.warn(`[rpc] ${msg.metodo} falló para ${p.id}:`, error.message);
            enviar(p.ws, { t: 'rpc', id: msg.id, ok: false, error: error.message, codigo: error.codigo || '' });
        }
    }

    function alMensaje(p, datos) {
        let msg;
        try { msg = JSON.parse(datos); } catch (e) { return; }
        if (!msg || typeof msg.t !== 'string') return;
        p.vivo = true;

        switch (msg.t) {
            case 'ping':
                return enviar(p.ws, { t: 'pong' });
            case 'unirse':
                return alUnirse(p, msg);
            case 'rpc':
                return alRpc(p, msg);
            case 'medios':
                if (!p.unido) return;
                p.mic = Boolean(msg.mic);
                p.cam = Boolean(msg.cam);
                return difundir();
            case 'calidad':
                if (!p.unido || !CALIDADES.has(msg.q) || p.calidad === msg.q) return;
                p.calidad = msg.q;
                return difundir();
            case 'consumo': {
                const bytes = Number(msg.bytes);
                if (p.unido && Number.isFinite(bytes) && bytes > 0 && bytes < 2e9) consumo.sumar(bytes);
                return;
            }
            default:
        }
    }

    wss.on('connection', (ws) => {
        const p = {
            id: crypto.randomBytes(6).toString('hex'),
            ws,
            nombre: '',
            unido: false,
            sessionId: null,
            tracks: {},
            mic: true,
            cam: true,
            calidad: 'desconocida',
            vivo: true
        };
        participantes.set(p.id, p);

        ws.on('message', (datos) => alMensaje(p, datos));
        ws.on('close', () => sacar(p));
        ws.on('error', () => sacar(p));
        ws.on('pong', () => { p.vivo = true; });
    });

    // Latido: corta conexiones muertas (Wi-Fi caído, equipo suspendido)
    const latido = setInterval(() => {
        participantes.forEach((p) => {
            if (!p.vivo) {
                try { p.ws.terminate(); } catch (e) { /* noop */ }
                return sacar(p);
            }
            p.vivo = false;
            try { p.ws.ping(); } catch (e) { /* noop */ }
        });
    }, LATIDO_MS);
    latido.unref();

    // Cierre automático al terminar el horario
    let timerHorario = null;
    function vigilarHorario() {
        clearTimeout(timerHorario);
        if (!horario.configurado) return;
        const h = horario.estado();
        if (!h.activo) {
            participantes.forEach((p) => {
                enviar(p.ws, { t: 'cierre', msCambio: h.msCambio });
                try { p.ws.close(4001, 'fuera de horario'); } catch (e) { /* noop */ }
            });
        }
        const espera = Math.min(h.msCambio || 3600000, 3600000) + 1000;
        timerHorario = setTimeout(vigilarHorario, espera);
        timerHorario.unref();
    }
    vigilarHorario();

    return {
        cantidad: () => lista().length,
        cerrarTodo() {
            clearInterval(latido);
            clearTimeout(timerHorario);
            participantes.forEach((p) => { try { p.ws.close(1001, 'reinicio'); } catch (e) { /* noop */ } });
            wss.close();
        }
    };
}

module.exports = { crearSala };

'use strict';

/**
 * Cliente mínimo de Cloudflare Realtime (SFU + TURN)
 * --------------------------------------------------------------
 * Plan gratuito: 1.000 GB de salida al mes (SFU y TURN comparten el cupo).
 * No se cobran minutos, solo los datos que Cloudflare envía a los navegadores.
 *
 * El token (CF_APP_TOKEN) NUNCA llega al navegador: el cliente le pide
 * todo al servidor por WebSocket y el servidor llama a Cloudflare.
 */

const BASE_POR_DEFECTO = 'https://rtc.live.cloudflare.com/v1';
const TIMEOUT_MS = 15000;

class ErrorCloudflare extends Error {
    constructor(mensaje, codigo, status) {
        super(mensaje);
        this.name = 'ErrorCloudflare';
        this.codigo = codigo || '';
        this.status = status || 0;
    }
}

function crearClienteCloudflare({ appId, appToken, turnKeyId, turnKeyToken, baseUrl }) {
    const base = (baseUrl || BASE_POR_DEFECTO).replace(/\/+$/, '');
    const configurado = Boolean(appId && appToken);
    const turnConfigurado = Boolean(turnKeyId && turnKeyToken);

    async function llamar(metodo, ruta, cuerpo, token) {
        const control = new AbortController();
        const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
        let resp;
        try {
            resp = await fetch(base + ruta, {
                method: metodo,
                headers: {
                    Authorization: `Bearer ${token || appToken}`,
                    'Content-Type': 'application/json'
                },
                body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
                signal: control.signal
            });
        } catch (error) {
            throw new ErrorCloudflare(
                error.name === 'AbortError' ? 'Cloudflare tardó demasiado en responder' : 'No se pudo contactar a Cloudflare',
                'red'
            );
        } finally {
            clearTimeout(timer);
        }

        const texto = await resp.text();
        let datos = {};
        try { datos = texto ? JSON.parse(texto) : {}; } catch (e) { /* respuesta no JSON */ }

        if (!resp.ok || datos.errorCode) {
            throw new ErrorCloudflare(
                datos.errorDescription || `Cloudflare respondió ${resp.status}`,
                datos.errorCode || `http_${resp.status}`,
                resp.status
            );
        }
        return datos;
    }

    const app = (ruta) => `/apps/${encodeURIComponent(appId)}${ruta}`;
    const ses = (id, ruta) => app(`/sessions/${encodeURIComponent(id)}${ruta}`);

    // ---------- ICE (STUN / TURN) ----------
    const STUN = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
    let cacheIce = null; // { servidores, vence }

    async function servidoresIce() {
        if (!turnConfigurado) return STUN;
        if (cacheIce && cacheIce.vence > Date.now()) return cacheIce.servidores;
        try {
            const ttl = 24 * 3600;
            const datos = await llamar(
                'POST',
                `/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate-ice-servers`,
                { ttl },
                turnKeyToken
            );
            // Los navegadores bloquean el puerto 53: se quita para no esperar timeouts
            const servidores = (datos.iceServers || []).map((s) => {
                const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u));
                return Object.assign({}, s, { urls });
            }).filter((s) => s.urls.length);
            // Se reutilizan durante 12 h (valen 24 h)
            cacheIce = { servidores, vence: Date.now() + (ttl / 2) * 1000 };
            return servidores;
        } catch (error) {
            console.warn('[cloudflare] No se pudieron generar credenciales TURN, se usa solo STUN:', error.message);
            return STUN;
        }
    }

    return {
        configurado,
        turnConfigurado,
        servidoresIce,
        nuevaSesion: () => llamar('POST', app('/sessions/new')),
        tracksNuevos: (sessionId, cuerpo) => llamar('POST', ses(sessionId, '/tracks/new'), cuerpo),
        renegociar: (sessionId, sdp) =>
            llamar('PUT', ses(sessionId, '/renegotiate'), { sessionDescription: { type: 'answer', sdp } }),
        cerrarTracks: (sessionId, cuerpo) => llamar('PUT', ses(sessionId, '/tracks/close'), cuerpo)
    };
}

module.exports = { crearClienteCloudflare, ErrorCloudflare };

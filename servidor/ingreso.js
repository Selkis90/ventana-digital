'use strict';

/**
 * Ventana Digital — acceso con código
 * --------------------------------------------------------------
 * 1. Quien quiere entrar escribe su nombre -> POST /api/ingreso/solicitar
 * 2. El servidor genera un código de 6 dígitos y se lo envía al anfitrión:
 *    - por Telegram (gratis) si están TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID
 *    - si no, por SMS con Twilio (TWILIO_* y OWNER_PHONE)
 * 3. Si el anfitrión aprueba, le da el código a esa persona.
 * 4. La persona escribe el código -> POST /api/ingreso/verificar
 * 5. Si es correcto, recibe el token de LiveKit y entra a la sala.
 *
 * Ambos canales usan fetch (Node 20+): no hace falta instalar paquetes.
 */

const crypto = require('crypto');
const express = require('express');

const VIGENCIA_MS = 5 * 60 * 1000;        // el código vence en 5 minutos
const MAX_INTENTOS = 5;                   // intentos de código por solicitud
const SOLICITUDES_POR_IP = 3;             // solicitudes por IP...
const VENTANA_IP_MS = 10 * 60 * 1000;     // ...cada 10 minutos
const SMS_POR_HORA = 30;                  // tope global para proteger tu saldo de Twilio

function crearRutasIngreso({ limpiarNombre, crearAcceso, livekitConfigurado }) {
    const twilioSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const twilioToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    const twilioDesde = (process.env.TWILIO_PHONE || '').trim();
    // Varios destinatarios separados por coma: "741462475,123456789"
    const lista = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    const telefonosAnfitrion = lista(process.env.OWNER_PHONE);
    const telegramToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const telegramChats = lista(process.env.TELEGRAM_CHAT_ID);

    const canal = telegramToken && telegramChats.length
        ? 'telegram'
        : (twilioSid && twilioToken && twilioDesde && telefonosAnfitrion.length ? 'sms' : null);
    const smsConfigurado = Boolean(canal);
    const destinos = canal === 'telegram' ? telegramChats : telefonosAnfitrion;

    if (canal) {
        console.log(
            `[ingreso] Los códigos se enviarán por ${canal === 'telegram' ? 'Telegram' : 'SMS'} ` +
            `a ${destinos.length} ${destinos.length === 1 ? 'persona' : 'personas'}`
        );
    } else {
        console.warn(
            '[ingreso] No hay canal para enviar el código. Configura TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID ' +
            '(o TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE y OWNER_PHONE). ' +
            'Nadie podrá entrar a la sala hasta que se configuren.'
        );
    }

    const router = express.Router();
    const solicitudes = new Map();   // solicitudId -> { hash, nombre, expira, intentos }
    const porIp = new Map();         // ip -> [timestamps]
    let smsRecientes = [];           // timestamps de la última hora

    const hashCodigo = (codigo) => crypto.createHash('sha256').update(codigo).digest();

    const limpieza = setInterval(() => {
        const ahora = Date.now();
        for (const [id, s] of solicitudes) if (s.expira <= ahora) solicitudes.delete(id);
        for (const [ip, lista] of porIp) {
            const vigentes = lista.filter((t) => ahora - t < VENTANA_IP_MS);
            if (vigentes.length) porIp.set(ip, vigentes);
            else porIp.delete(ip);
        }
    }, 60000);
    limpieza.unref();

    function excedeLimiteIp(ip) {
        const ahora = Date.now();
        const lista = (porIp.get(ip) || []).filter((t) => ahora - t < VENTANA_IP_MS);
        if (lista.length >= SOLICITUDES_POR_IP) {
            porIp.set(ip, lista);
            return true;
        }
        lista.push(ahora);
        porIp.set(ip, lista);
        return false;
    }

    function excedeLimiteGlobal() {
        const ahora = Date.now();
        smsRecientes = smsRecientes.filter((t) => ahora - t < 3600000);
        if (smsRecientes.length >= SMS_POR_HORA) return true;
        smsRecientes.push(ahora);
        return false;
    }

    const escaparHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    async function enviarTelegram(chatId, nombre, codigo) {
        const resp = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                parse_mode: 'HTML',
                // <code> permite copiar el código con un toque en Telegram
                text:
                    `🔐 <b>Ventana Digital</b>\n` +
                    `<b>${escaparHtml(nombre)}</b> quiere entrar a la videollamada.\n\n` +
                    `Código: <code>${codigo}</code>\n` +
                    `Vence en 5 min. Si no conoces a esta persona, no lo compartas.`
            }),
            signal: AbortSignal.timeout(15000)
        });
        if (!resp.ok) {
            const datos = await resp.json().catch(() => ({}));
            throw new Error(`Telegram ${resp.status}: ${datos.description || 'error desconocido'}`);
        }
    }

    // Envía a todos los anfitriones. Basta con que le llegue a uno.
    async function enviarCodigo(nombre, codigo) {
        const textoSms =
            `Ventana Digital: ${nombre} quiere entrar a la videollamada. ` +
            `Codigo: ${codigo}. Vence en 5 min. Si no lo conoces, no lo compartas.`;

        const resultados = await Promise.allSettled(
            destinos.map((d) => (canal === 'telegram' ? enviarTelegram(d, nombre, codigo) : enviarSms(d, textoSms)))
        );

        let enviados = 0;
        resultados.forEach((r, i) => {
            if (r.status === 'fulfilled') enviados += 1;
            else console.error(`[ingreso] Falló el envío al destinatario ${i + 1} (${destinos[i]}): ${r.reason.message}`);
        });
        if (!enviados) throw new Error('No se pudo enviar a ningún destinatario');
    }

    async function enviarSms(telefono, texto) {
        const resp = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSid)}/Messages.json`,
            {
                method: 'POST',
                headers: {
                    Authorization: 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ From: twilioDesde, To: telefono, Body: texto }),
                signal: AbortSignal.timeout(15000)
            }
        );
        if (!resp.ok) {
            const datos = await resp.json().catch(() => ({}));
            throw new Error(`Twilio ${resp.status}: ${datos.message || 'error desconocido'}`);
        }
    }

    // ---------------------------------------------------------
    // 1) Solicitar ingreso: envía el código al anfitrión
    // ---------------------------------------------------------
    router.post('/solicitar', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        if (!livekitConfigurado || !smsConfigurado) {
            return res.status(503).json({ error: 'El acceso a la sala no está configurado todavía.' });
        }

        const nombre = limpiarNombre((req.body || {}).nombre);
        if (!nombre) {
            return res.status(400).json({ error: 'Escribe tu nombre para entrar.' });
        }

        if (excedeLimiteIp(req.ip || 'desconocido')) {
            return res.status(429).json({ error: 'Ya pediste varios códigos. Espera unos minutos e inténtalo de nuevo.' });
        }
        if (excedeLimiteGlobal()) {
            return res.status(429).json({ error: 'Hay demasiadas solicitudes en este momento. Inténtalo más tarde.' });
        }

        const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        const solicitudId = crypto.randomUUID();

        try {
            await enviarCodigo(nombre, codigo);
        } catch (error) {
            console.error('[ingreso] No se pudo enviar el código:', error.message);
            return res.status(502).json({ error: 'No se pudo enviar el código al anfitrión. Inténtalo de nuevo.' });
        }

        solicitudes.set(solicitudId, {
            hash: hashCodigo(codigo),
            nombre,
            expira: Date.now() + VIGENCIA_MS,
            intentos: 0
        });

        console.log(`[ingreso] Código enviado para "${nombre}"`);
        return res.json({ solicitudId, venceEnSeg: VIGENCIA_MS / 1000 });
    });

    // ---------------------------------------------------------
    // 2) Verificar código: si es correcto, entrega el token
    // ---------------------------------------------------------
    router.post('/verificar', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        const body = req.body || {};
        const solicitudId = typeof body.solicitudId === 'string' ? body.solicitudId : '';
        const codigo = String(body.codigo || '').replace(/\D/g, '');
        const s = solicitudes.get(solicitudId);

        if (!s || s.expira <= Date.now()) {
            solicitudes.delete(solicitudId);
            return res.status(410).json({ error: 'El código venció. Solicita el acceso de nuevo.' });
        }

        s.intentos += 1;
        const correcto = codigo.length === 6 && crypto.timingSafeEqual(hashCodigo(codigo), s.hash);

        if (!correcto) {
            if (s.intentos >= MAX_INTENTOS) {
                solicitudes.delete(solicitudId);
                return res.status(403).json({ error: 'Demasiados intentos fallidos. Solicita el acceso de nuevo.' });
            }
            const quedan = MAX_INTENTOS - s.intentos;
            return res.status(401).json({
                error: `Código incorrecto. Te ${quedan === 1 ? 'queda 1 intento' : `quedan ${quedan} intentos`}.`
            });
        }

        solicitudes.delete(solicitudId); // cada código sirve una sola vez

        try {
            const acceso = await crearAcceso(s.nombre);
            console.log(`[ingreso] Acceso autorizado: ${acceso.identidad}`);
            return res.json(acceso);
        } catch (error) {
            console.error('[ingreso] Error generando token:', error);
            return res.status(500).json({ error: 'No se pudo generar el acceso a la sala.' });
        }
    });

    router.smsConfigurado = smsConfigurado;
    return router;
}

module.exports = { crearRutasIngreso };

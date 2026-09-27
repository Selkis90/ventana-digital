'use strict';

/**
 * Ventana Digital — servidor
 * --------------------------------------------------------------
 * 1. Sirve el cliente web (carpeta /cliente).
 * 2. Emite tokens de LiveKit de forma segura (POST /api/token).
 * 3. Expone configuración pública y un health check.
 *
 * LiveKit Cloud se encarga de audio, video, TURN/STUN y reconexión,
 * por eso este servidor NO necesita Twilio ni Socket.IO.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

// ============================================================
// CONFIGURACIÓN
// ============================================================

const CONFIG = Object.freeze({
    port: Number(process.env.PORT) || 3000,
    produccion: process.env.NODE_ENV === 'production',
    livekitUrl: (process.env.LIVEKIT_URL || '').trim(),
    livekitApiKey: (process.env.LIVEKIT_API_KEY || '').trim(),
    livekitApiSecret: (process.env.LIVEKIT_API_SECRET || '').trim(),
    salaPorDefecto: (process.env.DEFAULT_ROOM || 'sala-principal').trim(),
    tokenTtl: (process.env.TOKEN_TTL || '4h').trim(),
    origenesPermitidos: (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    version: require('./package.json').version
});

const livekitConfigurado = Boolean(
    CONFIG.livekitUrl && CONFIG.livekitApiKey && CONFIG.livekitApiSecret
);

if (!livekitConfigurado) {
    console.warn(
        '[config] Faltan variables LIVEKIT_URL, LIVEKIT_API_KEY o LIVEKIT_API_SECRET. ' +
        'El endpoint /api/token responderá 503 hasta que se configuren.'
    );
}

const clientePath = path.join(__dirname, '..', 'cliente');

// ============================================================
// APP
// ============================================================

const app = express();
const server = http.createServer(app);

// Render pone un proxy delante: necesario para la IP real y detectar HTTPS
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Cabeceras de seguridad
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
        'Permissions-Policy',
        'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), screen-wake-lock=(self)'
    );
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self' https://cdn.jsdelivr.net https://unpkg.com",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob: mediastream:",
            "connect-src 'self' https: wss:",
            "worker-src 'self' blob:",
            "frame-ancestors 'self'",
            "base-uri 'self'",
            "form-action 'self'"
        ].join('; ')
    );
    if (CONFIG.produccion) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// Redirigir a HTTPS en producción (cámara y micrófono lo exigen)
if (CONFIG.produccion) {
    app.use((req, res, next) => {
        if (req.secure || req.path === '/health') return next();
        return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    });
}

// CORS: solo mismo origen, salvo los dominios en ALLOWED_ORIGINS
app.use(
    '/api',
    cors({
        origin(origin, callback) {
            if (!origin) return callback(null, true);
            if (CONFIG.origenesPermitidos.includes(origin)) return callback(null, true);
            return callback(null, false);
        },
        methods: ['GET', 'POST', 'OPTIONS']
    })
);

app.use(express.json({ limit: '10kb' }));

// ============================================================
// RATE LIMIT SENCILLO EN MEMORIA
// ============================================================

function crearRateLimit({ ventanaMs, maximo }) {
    const registros = new Map();

    const limpieza = setInterval(() => {
        const ahora = Date.now();
        for (const [clave, datos] of registros) {
            if (datos.reinicio <= ahora) registros.delete(clave);
        }
    }, ventanaMs);
    limpieza.unref();

    return (req, res, next) => {
        const clave = req.ip || 'desconocido';
        const ahora = Date.now();
        let datos = registros.get(clave);

        if (!datos || datos.reinicio <= ahora) {
            datos = { cuenta: 0, reinicio: ahora + ventanaMs };
            registros.set(clave, datos);
        }

        datos.cuenta += 1;

        if (datos.cuenta > maximo) {
            res.setHeader('Retry-After', Math.ceil((datos.reinicio - ahora) / 1000));
            return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' });
        }
        return next();
    };
}

const limiteToken = crearRateLimit({ ventanaMs: 60000, maximo: 20 });

// ============================================================
// VALIDACIÓN
// ============================================================

const REGEX_SALA = /^[a-zA-Z0-9_-]{1,64}$/;

function limpiarNombre(valor) {
    if (typeof valor !== 'string') return '';
    return valor
        .normalize('NFC')
        .replace(/[\u0000-\u001F\u007F<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

function crearIdentidad(nombre) {
    const base = nombre
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'invitado';
    return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

// ============================================================
// RUTAS API
// ============================================================

app.get('/api/config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        livekitUrl: CONFIG.livekitUrl,
        salaPorDefecto: CONFIG.salaPorDefecto,
        disponible: livekitConfigurado
    });
});

async function generarToken(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (!livekitConfigurado) {
        return res.status(503).json({ error: 'El servidor de video no está configurado.' });
    }

    const body = req.body || {};
    const sala = String(body.sala ?? body.roomName ?? CONFIG.salaPorDefecto).trim();
    const nombre = limpiarNombre(body.nombre ?? body.participantName);

    if (!REGEX_SALA.test(sala)) {
        return res.status(400).json({ error: 'Nombre de sala inválido. Usa letras, números, guiones o guion bajo (máx. 64).' });
    }
    if (!nombre) {
        return res.status(400).json({ error: 'Escribe tu nombre para entrar.' });
    }

    try {
        const identidad = crearIdentidad(nombre);

        const at = new AccessToken(CONFIG.livekitApiKey, CONFIG.livekitApiSecret, {
            identity: identidad,
            name: nombre,
            ttl: CONFIG.tokenTtl
        });

        at.addGrant({
            roomJoin: true,
            room: sala,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true
        });

        const token = await at.toJwt();

        console.log(`[token] sala=${sala} identidad=${identidad}`);

        return res.json({ token, url: CONFIG.livekitUrl, sala, identidad, nombre });
    } catch (error) {
        console.error('[token] Error generando token:', error);
        return res.status(500).json({ error: 'No se pudo generar el acceso a la sala.' });
    }
}

app.post('/api/token', limiteToken, generarToken);
app.post('/get-token', limiteToken, generarToken); // compatibilidad

app.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        status: 'ok',
        version: CONFIG.version,
        livekit: livekitConfigurado,
        uptime: Math.round(process.uptime())
    });
});

app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

// ============================================================
// ARCHIVOS ESTÁTICOS DEL CLIENTE
// ============================================================

app.use(
    express.static(clientePath, {
        index: false,
        maxAge: CONFIG.produccion ? '1h' : 0,
        setHeaders(res, filePath) {
            if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        }
    })
);

app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientePath, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'JSON inválido' });
    }
    console.error('[error]', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
});

// ============================================================
// ARRANQUE Y APAGADO ORDENADO
// ============================================================

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(CONFIG.port, '0.0.0.0', () => {
    console.log('=========================================');
    console.log(` Ventana Digital v${CONFIG.version}`);
    console.log(` Puerto:  ${CONFIG.port}`);
    console.log(` Entorno: ${CONFIG.produccion ? 'producción' : 'desarrollo'}`);
    console.log(` LiveKit: ${livekitConfigurado ? CONFIG.livekitUrl : 'NO CONFIGURADO'}`);
    console.log('=========================================');
});

function apagar(senal) {
    console.log(`[${senal}] Cerrando servidor...`);
    server.close(() => {
        console.log('Servidor cerrado correctamente.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
process.on('unhandledRejection', (razon) => {
    console.error('[unhandledRejection]', razon);
});

module.exports = { app, server };

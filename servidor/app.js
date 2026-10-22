'use strict';

/**
 * Ventana Digital — servidor
 * --------------------------------------------------------------
 * 1. Sirve el cliente web (carpeta /cliente).
 * 2. Lleva la sala por WebSocket (/ws): quién está, qué publica cada uno.
 * 3. Habla con Cloudflare Realtime (SFU) en nombre del navegador.
 *    El audio y el video NO pasan por Render: van directo a Cloudflare.
 *
 * Costo: Cloudflare Realtime da 1.000 GB/mes gratis (sin límite de minutos)
 * y Render free alcanza para el servidor (solo mueve mensajes pequeños).
 */

const path = require('path');
const http = require('http');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const { crearClienteCloudflare } = require('./cloudflare');
const { crearSala } = require('./sala');
const { crearHorario } = require('./horario');

// ============================================================
// CONFIGURACIÓN
// ============================================================

const CALIDADES = ['alta', 'normal', 'baja'];
const calidadEnv = String(process.env.CALIDAD || 'normal').trim().toLowerCase();

const CONFIG = Object.freeze({
    port: Number(process.env.PORT) || 3000,
    produccion: process.env.NODE_ENV === 'production',
    cfAppId: (process.env.CF_APP_ID || '').trim(),
    cfAppToken: (process.env.CF_APP_TOKEN || '').trim(),
    cfTurnKeyId: (process.env.CF_TURN_KEY_ID || '').trim(),
    cfTurnKeyToken: (process.env.CF_TURN_KEY_TOKEN || '').trim(),
    cfApiUrl: (process.env.CF_API_URL || '').trim(), // solo para pruebas con simulador
    salaPorDefecto: (process.env.DEFAULT_ROOM || 'sala-principal').trim(),
    calidad: CALIDADES.includes(calidadEnv) ? calidadEnv : 'normal',
    maxParticipantes: Math.max(2, Number(process.env.MAX_PARTICIPANTES) || 6),
    horario: (process.env.HORARIO || '').trim(),
    zonaHoraria: (process.env.ZONA_HORARIA || 'America/Bogota').trim(),
    origenesPermitidos: (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    version: require('./package.json').version
});

const cf = crearClienteCloudflare({
    appId: CONFIG.cfAppId,
    appToken: CONFIG.cfAppToken,
    turnKeyId: CONFIG.cfTurnKeyId,
    turnKeyToken: CONFIG.cfTurnKeyToken,
    baseUrl: CONFIG.cfApiUrl
});

if (!cf.configurado) {
    console.warn(
        '[config] Faltan CF_APP_ID o CF_APP_TOKEN (Cloudflare Realtime). ' +
        'Nadie podrá entrar a la sala hasta que se configuren.'
    );
}

const horario = crearHorario(CONFIG.horario, CONFIG.zonaHoraria);

// ------------------------------------------------------------
// Consumo estimado del mes (lo que Cloudflare cobra = datos que
// reciben los navegadores). Se reinicia si Render reinicia el
// servidor; el dato exacto está en el panel de Cloudflare.
// ------------------------------------------------------------
const consumo = (() => {
    const mesActual = () => new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.zonaHoraria, year: 'numeric', month: '2-digit' }).format(new Date());
    let mes = mesActual();
    let bytes = 0;
    const desde = new Date().toISOString();
    return {
        sumar(n) {
            const m = mesActual();
            if (m !== mes) { mes = m; bytes = 0; }
            bytes += n;
        },
        resumen() {
            const m = mesActual();
            if (m !== mes) { mes = m; bytes = 0; }
            const gb = bytes / 1e9;
            return {
                mes,
                gbEstimados: Math.round(gb * 100) / 100,
                cupoGratisGb: 1000,
                porcentaje: Math.round((gb / 1000) * 1000) / 10,
                contandoDesde: desde
            };
        }
    };
})();

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
            "script-src 'self'",
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
        if (req.secure || req.path === '/health' || req.path === '/ws') return next();
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
        methods: ['GET', 'OPTIONS']
    })
);

app.use(express.json({ limit: '10kb' }));

// ============================================================
// VALIDACIÓN
// ============================================================

function limpiarNombre(valor) {
    if (typeof valor !== 'string') return '';
    return valor
        .normalize('NFC')
        .replace(/[\u0000-\u001F\u007F<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

// ============================================================
// RUTAS API
// ============================================================

app.get('/api/config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        salaPorDefecto: CONFIG.salaPorDefecto,
        disponible: cf.configurado,
        calidad: CONFIG.calidad,
        horario: Object.assign({ texto: horario.texto, zona: horario.zona }, horario.estado())
    });
});

app.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        status: 'ok',
        version: CONFIG.version,
        video: cf.configurado ? 'cloudflare' : 'sin configurar',
        turn: cf.turnConfigurado,
        participantes: sala.cantidad(),
        calidad: CONFIG.calidad,
        horario: horario.configurado ? Object.assign({ texto: horario.texto }, horario.estado()) : 'siempre',
        consumo: consumo.resumen(),
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
        // no-cache: el navegador siempre revisa si hay versión nueva (con ETag, así que
        // si no cambió responde 304 sin volver a descargar). Evita mezclar un index.html
        // nuevo con un camara.js viejo después de actualizar.
        setHeaders(res) {
            res.setHeader('Cache-Control', 'no-cache');
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

const sala = crearSala({ server, cf, config: CONFIG, horario, consumo, limpiarNombre });

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(CONFIG.port, '0.0.0.0', () => {
    console.log('=========================================');
    console.log(` Ventana Digital v${CONFIG.version}`);
    console.log(` Puerto:  ${CONFIG.port}`);
    console.log(` Entorno: ${CONFIG.produccion ? 'producción' : 'desarrollo'}`);
    console.log(` Video:   ${cf.configurado ? 'Cloudflare Realtime' + (cf.turnConfigurado ? ' + TURN' : '') : 'NO CONFIGURADO'}`);
    console.log(` Calidad: ${CONFIG.calidad} · Máx. ${CONFIG.maxParticipantes} personas`);
    console.log(` Horario: ${horario.configurado ? horario.texto + ' (' + horario.zona + ')' : 'siempre abierto'}`);
    console.log('=========================================');
});

function apagar(senal) {
    console.log(`[${senal}] Cerrando servidor...`);
    sala.cerrarTodo();
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

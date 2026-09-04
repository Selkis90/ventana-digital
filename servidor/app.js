'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000,
    allowEIO3: true
});

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], credentials: true }));
app.use(express.json());

app.post('/get-token', async (req, res) => {
    try {
        const { roomName, participantName } = req.body;

        if (!roomName || typeof roomName !== 'string') {
            return res.status(400).json({ error: 'roomName es obligatorio' });
        }

        if (!participantName || typeof participantName !== 'string') {
            return res.status(400).json({ error: 'participantName es obligatorio' });
        }

        if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
            return res.status(500).json({ error: 'Servidor LiveKit no configurado' });
        }

        const identity = participantName.trim().substring(0, 100);

        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity });
        at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });

        const token = await at.toJwt();

        console.log(`🎫 Token LiveKit generado para: ${identity}`);
        return res.json({ token, roomName, participantName: identity });
    } catch (error) {
        console.error('❌ Error generando token LiveKit:', error);
        return res.status(500).json({ error: 'No se pudo generar el token LiveKit' });
    }
});

// TURN Twilio (Mantenido por compatibilidad)
try {
    const turnRoutes = require('./turn-twilio');
    app.use('/', turnRoutes);
    console.log('✅ Rutas TURN Twilio cargadas');
} catch (error) {
    console.warn('⚠️ No se pudo cargar turn-twilio.js:', error.message);
}

// Archivos estáticos
app.use('/socket.io', express.static(path.join(__dirname, 'node_modules/socket.io/client-dist')));
const clientePath = path.join(__dirname, '../cliente');
app.use(express.static(clientePath));

app.get('/', (req, res) => {
    res.sendFile(path.join(clientePath, 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), clients: io.sockets.sockets.size, livekit: Boolean(LIVEKIT_API_KEY && LIVEKIT_API_SECRET) });
});

app.get('/status', (req, res) => {
    res.json({ status: 'online', version: '1.0.0', timestamp: new Date().toISOString(), connectedClients: io.sockets.sockets.size, uptime: process.uptime(), memory: process.memoryUsage(), services: { livekit: true, socketio: true, turn: true } });
});

app.get('/clientes', (req, res) => {
    const sockets = io.sockets.sockets;
    const clientesInfo = [];
    sockets.forEach((socket, id) => {
        clientesInfo.push({ id, ip: socket.handshake.address, connected: socket.connected, rooms: Array.from(socket.rooms) });
    });
    res.json({ total: clientesInfo.length, clientes: clientesInfo, timestamp: new Date().toISOString() });
});

app.post('/refresh-clients', (req, res) => {
    const lista = Array.from(io.sockets.sockets.keys());
    io.emit('clientes-conectados', lista);
    res.json({ status: 'ok', message: `Lista de ${lista.length} clientes actualizada`, clientes: lista });
});

app.post('/cleanup-clients', (req, res) => {
    const lista = Array.from(io.sockets.sockets.keys());
    io.emit('clientes-conectados', lista);
    res.json({ status: 'ok', message: 'Limpieza forzada', clientesActivos: lista.length, clientes: lista });
});

const socketManager = require('./socket/socket');
if (socketManager && typeof socketManager.inicializarSocket === 'function') {
    socketManager.inicializarSocket(io);
    console.log('✅ Socket.IO inicializado correctamente');
} else {
    console.error('❌ socket/socket.js no contiene inicializarSocket()');
}

server.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log('🚀 SERVIDOR INICIADO');
    console.log('=========================================');
    console.log(`🌐 Puerto: ${PORT}`);
    console.log(`🎥 LiveKit: ${LIVEKIT_API_KEY && LIVEKIT_API_SECRET ? 'CONFIGURADO' : 'NO CONFIGURADO'}`);
    console.log('🔌 Socket.IO: ACTIVO');
    console.log('=========================================');
});

module.exports = { app, server, io };

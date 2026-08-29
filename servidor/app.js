const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// ============================================
// 🔥 CONFIGURACIÓN DE SOCKET.IO
// ============================================
const io = new Server(server, {
    cors: { 
        origin: '*', 
        methods: ['GET', 'POST'] 
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000,
    allowEIO3: true,
});

const PORT = process.env.PORT || 3000;

// ============================================
// 🔥 MIDDLEWARE
// ============================================
app.use(cors({ 
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true 
}));
app.use(express.json());

// ============================================
// 🔥 RUTAS DE TWILIO TURN
// ============================================
const turnRoutes = require('./turn-twilio');
app.use('/', turnRoutes);

// ============================================
// 📄 SERVIR ARCHIVOS ESTÁTICOS
// ============================================
app.use('/socket.io', express.static(
    path.join(__dirname, 'node_modules/socket.io/client-dist')
));

app.use(express.static(path.join(__dirname, '../cliente')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../cliente/index.html'));
});

// ============================================
// 🔥 HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        clients: io.sockets.sockets.size
    });
});

app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        connectedClients: io.sockets.sockets.size,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// ============================================
// 🔥 SOCKET.IO
// ============================================
require('./socket/socket')(io);

// ============================================
// 🚀 INICIAR SERVIDOR
// ============================================
server.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
    console.log(`🔑 TURN Twilio: http://localhost:${PORT}/turn-credentials`);
    console.log(`🧪 Test: http://localhost:${PORT}/test-turn`);
    console.log(`💚 Health: http://localhost:${PORT}/health`);
    console.log('=========================================');
});

// Manejar errores del servidor
server.on('error', (error) => {
    console.error('❌ Error en el servidor:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
});

module.exports = { app, server, io };

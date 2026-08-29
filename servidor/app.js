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
// 🔥 RUTAS DE DIAGNÓSTICO (NUEVAS)
// ============================================

// 🔥 VER CLIENTES CONECTADOS
app.get('/clientes', (req, res) => {
    const sockets = io.sockets.sockets;
    const clientesInfo = [];
    
    sockets.forEach((socket, id) => {
        clientesInfo.push({
            id: id,
            ip: socket.handshake.address,
            connected: socket.connected,
            rooms: Array.from(socket.rooms)
        });
    });
    
    res.json({
        total: clientesInfo.length,
        clientes: clientesInfo,
        timestamp: new Date().toISOString()
    });
});

// 🔥 FORZAR ACTUALIZACIÓN DE CLIENTES
app.post('/refresh-clients', (req, res) => {
    const lista = Array.from(io.sockets.sockets.keys());
    console.log(`🔄 Forzando actualización: ${lista.length} clientes`);
    
    // Enviar a TODOS los clientes
    io.emit('clientes-conectados', lista);
    
    res.json({
        status: 'ok',
        message: `Lista de ${lista.length} clientes actualizada`,
        clientes: lista,
        timestamp: new Date().toISOString()
    });
});

// 🔥 LIMPIAR CLIENTES INACTIVOS
app.post('/cleanup-clients', (req, res) => {
    const sockets = io.sockets.sockets;
    let cleaned = 0;
    
    // Obtener todos los sockets activos
    const activeSockets = new Set();
    sockets.forEach((socket, id) => {
        activeSockets.add(id);
    });
    
    // No podemos eliminar directamente, pero podemos forzar actualización
    const lista = Array.from(activeSockets);
    io.emit('clientes-conectados', lista);
    
    res.json({
        status: 'ok',
        message: 'Limpieza forzada',
        clientesActivos: lista.length,
        clientes: lista,
        timestamp: new Date().toISOString()
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
    console.log(`📋 Clientes: http://localhost:${PORT}/clientes`);
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

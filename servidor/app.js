const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// ============================================
// 🔥 CONFIGURACIÓN DE SOCKET.IO CON CORS
// ============================================
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// ============================================
// 🔥 MIDDLEWARE
// ============================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// ============================================
// 🔥 RUTAS TURN
// ============================================

// Ruta principal de TURN
app.get('/turn', (req, res) => {
    const turnConfig = {
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun3.l.google.com:19302" },
            { urls: "stun:stun4.l.google.com:19302" },
            { urls: "stun:stun.services.mozilla.com" },
            {
                urls: [
                    "turn:openrelay.metered.ca:80",
                    "turn:openrelay.metered.ca:443",
                    "turn:openrelay.metered.ca:3478"
                ],
                username: "openrelayproject",
                credential: "openrelayproject"
            },
            {
                urls: [
                    "turn:global.turn.metered.ca:80?transport=udp",
                    "turn:global.turn.metered.ca:443?transport=tcp",
                    "turn:global.turn.metered.ca:3478?transport=udp"
                ],
                username: "b4a446edd2810f74fb74b06d",
                credential: "e025b9eb858a5142"
            },
            {
                urls: "turn:turn.anyfirewall.com:443?transport=tcp",
                username: "webrtc",
                credential: "webrtc"
            }
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    };
    
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    
    res.json(turnConfig);
});

// Ruta específica de credenciales TURN
app.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitud de credenciales TURN');
    
    const turnConfig = {
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun3.l.google.com:19302" },
            { urls: "stun:stun4.l.google.com:19302" },
            { urls: "stun:stun.services.mozilla.com" },
            {
                urls: [
                    "turn:openrelay.metered.ca:80",
                    "turn:openrelay.metered.ca:443",
                    "turn:openrelay.metered.ca:3478"
                ],
                username: "openrelayproject",
                credential: "openrelayproject"
            },
            {
                urls: [
                    "turn:global.turn.metered.ca:80?transport=udp",
                    "turn:global.turn.metered.ca:443?transport=tcp",
                    "turn:global.turn.metered.ca:3478?transport=udp"
                ],
                username: "b4a446edd2810f74fb74b06d",
                credential: "e025b9eb858a5142"
            },
            {
                urls: "turn:turn.anyfirewall.com:443?transport=tcp",
                username: "webrtc",
                credential: "webrtc"
            }
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    };
    
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    
    res.json(turnConfig);
});

// ============================================
// 📄 SERVIR ARCHIVOS ESTÁTICOS
// ============================================

// Servir el cliente de Socket.IO
app.use("/socket.io", express.static(
    path.join(__dirname, "node_modules/socket.io/client-dist")
));

// Servir los archivos del cliente
app.use(express.static(path.join(__dirname, "../cliente")));

// Ruta principal para servir index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, "../cliente/index.html"));
});

// ============================================
// 🔥 RUTAS DE ESTADO Y HEALTH
// ============================================

// Health check para Render
app.get("/health", (req, res) => {
    res.json({ 
        status: "ok", 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Estado del servidor
app.get("/status", (req, res) => {
    const clients = io.sockets.sockets;
    res.json({
        status: "online",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        connectedClients: clients.size,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// ============================================
// 🔥 SOCKET.IO - CONFIGURACIÓN
// ============================================

// Cargar la configuración de Socket.IO
require("./socket/socket")(io);

// ============================================
// 🚀 INICIAR SERVIDOR
// ============================================

server.listen(PORT, "0.0.0.0", () => {
    console.log('=========================================');
    console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
    console.log(`🌐 URL: http://0.0.0.0:${PORT}`);
    console.log(`🔑 TURN: http://0.0.0.0:${PORT}/turn-credentials`);
    console.log(`💚 Health: http://0.0.0.0:${PORT}/health`);
    console.log(`📊 Status: http://0.0.0.0:${PORT}/status`);
    console.log('=========================================');
});

// ============================================
// MANEJO DE ERRORES Y SEÑALES
// ============================================

process.on('uncaughtException', (err) => {
    console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
});

process.on('SIGTERM', () => {
    console.log('🛑 Recibida señal SIGTERM, cerrando servidor...');
    server.close(() => {
        console.log('✅ Servidor cerrado');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 Recibida señal SIGINT, cerrando servidor...');
    server.close(() => {
        console.log('✅ Servidor cerrado');
        process.exit(0);
    });
});

module.exports = { app, server, io };

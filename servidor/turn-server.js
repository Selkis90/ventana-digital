// ============================================
// SERVIDOR TURN - ventana-digital.onrender.com
// ============================================
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json());
app.use((req, res, next) => {
    console.log(`📡 ${req.method} ${req.url}`);
    next();
});

// ============================================
// RUTA PRINCIPAL
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'TURN Server',
        message: 'Servidor TURN para Ventana Digital',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        endpoints: {
            'turn-credentials': '/turn-credentials',
            'health': '/health'
        }
    });
});

// ============================================
// 🔥 CREDENCIALES TURN PARA WEBRTC (MEJORADO)
// ============================================
app.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitud de credenciales TURN');
    
    // Configuración TURN con servidores públicos confiables
    const turnConfig = {
        iceServers: [
            // STUN - Para conexiones directas
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun3.l.google.com:19302" },
            { urls: "stun:stun4.l.google.com:19302" },
            { urls: "stun:stun.services.mozilla.com" },
            
            // 🔥 TURN - OpenRelay (gratuito y confiable)
            {
                urls: [
                    "turn:openrelay.metered.ca:80",
                    "turn:openrelay.metered.ca:443",
                    "turn:openrelay.metered.ca:3478"
                ],
                username: "openrelayproject",
                credential: "openrelayproject"
            },
            
            // TURN - Metered.ca (más servidores)
            {
                urls: [
                    "turn:global.turn.metered.ca:80?transport=udp",
                    "turn:global.turn.metered.ca:443?transport=tcp",
                    "turn:global.turn.metered.ca:3478?transport=udp"
                ],
                username: "b4a446edd2810f74fb74b06d",
                credential: "e025b9eb858a5142"
            },
            
            // TURN de respaldo
            {
                urls: "turn:turn.anyfirewall.com:443?transport=tcp",
                username: "webrtc",
                credential: "webrtc"
            },
            {
                urls: "turn:turn.doublerainbow.net:3478",
                username: "guest",
                credential: "guest"
            }
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
    };
    
    // Agregar CORS para permitir desde cualquier origen
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    
    res.json(turnConfig);
});

// ============================================
// RUTA DE SALUD
// ============================================
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage()
    });
});

// ============================================
// MANEJO DE ERRORES
// ============================================
app.use((err, req, res, next) => {
    console.error('❌ Error en servidor:', err);
    res.status(500).json({
        error: 'Error interno del servidor',
        message: err.message
    });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log(`🚀 TURN Server iniciado en puerto ${PORT}`);
    console.log(`📡 Credenciales: /turn-credentials`);
    console.log(`🌐 https://ventana-digital.onrender.com`);
    console.log(`🔍 Health check: /health`);
    console.log('=================================');
});

// Exportar para pruebas
module.exports = app;

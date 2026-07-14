// ============================================
// SERVIDOR TURN - ventana-digital.onrender.com
// ============================================
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// ============================================
// RUTA PRINCIPAL
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'TURN Server',
        message: 'Servidor TURN para Ventana Digital',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// 🔥 CREDENCIALES TURN PARA WEBRTC
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
    
    res.json(turnConfig);
});

// ============================================
// RUTA DE SALUD
// ============================================
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
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
    console.log('=================================');
});

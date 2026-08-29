const express = require('express');
const router = express.Router();

console.log('🔑 Configurando TURN con Metered.ca (GRATUITO)...');

router.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitando credenciales TURN');
    
    try {
        // 🔥 METERED.CA - TURN GRATUITO QUE SÍ FUNCIONA
        const config = {
            iceServers: [
                // STUN de Google (para conexiones directas)
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302'
                    ]
                },
                // 🔥 TURN de Metered.ca (GRATUITO Y CONFIABLE)
                {
                    urls: [
                        'turn:openrelay.metered.ca:80',
                        'turn:openrelay.metered.ca:443',
                        'turn:openrelay.metered.ca:3478'
                    ],
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                }
            ],
            iceCandidatePoolSize: 10,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        };
        
        console.log('✅ Configuración TURN con Metered.ca generada');
        res.json(config);
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.json({
            iceServers: [
                { urls: ['stun:stun.l.google.com:19302'] }
            ]
        });
    }
});

router.get('/test-turn', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        message: 'TURN con Metered.ca (gratuito)'
    });
});

module.exports = router;

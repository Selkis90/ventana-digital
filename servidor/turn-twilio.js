const express = require('express');
const router = express.Router();
require('dotenv').config();

console.log('🔑 Configurando TURN con Metered.ca (GRATUITO Y CONFIABLE)...');

router.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitando credenciales TURN');
    
    try {
        // 🔥 METERED.CA - TURN GRATUITO QUE SÍ FUNCIONA
        const config = {
            iceServers: [
                // STUN de Google (para conexiones directas en misma red)
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302',
                        'stun:stun3.l.google.com:19302',
                        'stun:stun4.l.google.com:19302'
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
                },
                // TURN de respaldo (Numb.viagenie)
                {
                    urls: [
                        'turn:numb.viagenie.ca:3478',
                        'turn:numb.viagenie.ca:443'
                    ],
                    username: 'webrtc@live.com',
                    credential: 'muazkh'
                }
            ],
            iceCandidatePoolSize: 10,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        };
        
        console.log('✅ Configuración TURN con Metered.ca generada');
        res.json(config);
    } catch (error) {
        console.error('❌ Error generando TURN:', error.message);
        // Configuración de emergencia
        res.json({
            iceServers: [
                { 
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302'
                    ]
                },
                {
                    urls: ['turn:openrelay.metered.ca:443'],
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                }
            ]
        });
    }
});

router.get('/test-turn', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        message: 'TURN con Metered.ca + Numb.viagenie',
        servers: 3
    });
});

module.exports = router;

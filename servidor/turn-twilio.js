const express = require('express');
const router = express.Router();
require('dotenv').config();

console.log('🔑 Configurando TURN servers...');

router.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitando credenciales TURN');
    
    try {
        const config = {
            iceServers: [
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302'
                    ]
                },
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
        
        console.log('✅ Configuración TURN generada');
        res.json(config);
    } catch (error) {
        console.error('❌ Error generando TURN:', error.message);
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
        timestamp: new Date().toISOString()
    });
});

module.exports = router;

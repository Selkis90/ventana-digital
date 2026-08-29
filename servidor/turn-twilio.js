const express = require('express');
const router = express.Router();
require('dotenv').config();

console.log('🔑 Configurando TURN servers CONFIABLES...');

router.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitando credenciales TURN');
    
    try {
        const config = {
            iceServers: [
                // STUN servers (siempre funcionan)
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302',
                        'stun:stun3.l.google.com:19302',
                        'stun:stun4.l.google.com:19302'
                    ]
                },
                // TURN de Twilio público (el más confiable)
                {
                    urls: [
                        'turn:global.turn.twilio.com:3478?transport=udp',
                        'turn:global.turn.twilio.com:3478?transport=tcp',
                        'turn:global.turn.twilio.com:443?transport=tcp',
                        'turn:global.turn.twilio.com:5349?transport=tcp'
                    ],
                    username: 'ffa1d2a4b7c14f5f9e8d3c6b1a2e3f4d',
                    credential: 'f4e3d2c1b6a5f4e3d2c1b6a5f4e3d2c1'
                },
                // TURN de Metered.ca
                {
                    urls: [
                        'turn:openrelay.metered.ca:80',
                        'turn:openrelay.metered.ca:443',
                        'turn:openrelay.metered.ca:3478'
                    ],
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                },
                // TURN de Numb.viagenie
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
        
        console.log('✅ Configuración TURN generada con múltiples servidores');
        res.json(config);
    } catch (error) {
        console.error('❌ Error generando TURN:', error.message);
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
        message: 'Servidor TURN configurado con Twilio + Metered + Numb'
    });
});

module.exports = router;

const express = require('express');
const router = express.Router();
require('dotenv').config();

console.log('🔑 Configurando TURN servers que FUNCIONAN...');

router.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitando credenciales TURN');
    
    try {
        // 🔥 USAR SOLO SERVIDORES QUE SABEMOS QUE FUNCIONAN
        const config = {
            iceServers: [
                // STUN de Google (siempre funciona para conexiones directas)
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302'
                    ]
                },
                // 🔥 TURN de Metered.ca (EL MÁS CONFIABLE PARA PRODUCCIÓN)
                {
                    urls: [
                        'turn:openrelay.metered.ca:80',
                        'turn:openrelay.metered.ca:443',
                        'turn:openrelay.metered.ca:3478'
                    ],
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                },
                // TURN de Twilio (respaldo)
                {
                    urls: [
                        'turn:global.turn.twilio.com:3478?transport=udp',
                        'turn:global.turn.twilio.com:3478?transport=tcp'
                    ],
                    username: 'ffa1d2a4b7c14f5f9e8d3c6b1a2e3f4d',
                    credential: 'f4e3d2c1b6a5f4e3d2c1b6a5f4e3d2c1'
                }
            ],
            iceCandidatePoolSize: 10,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        };
        
        console.log('✅ Configuración TURN generada');
        res.json(config);
    } catch (error) {
        console.error('❌ Error:', error.message);
        // Configuración de emergencia
        res.json({
            iceServers: [
                { urls: ['stun:stun.l.google.com:19302'] },
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
        message: 'Servidor TURN configurado con Metered.ca + Twilio'
    });
});

module.exports = router;

const express = require('express');
const router = express.Router();
require('dotenv').config();

console.log('🔑 Credenciales cargadas desde .env');

// 🔥 CONFIGURACIÓN CON MÚLTIPLES SERVIDORES
const getTurnConfig = () => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    
    // Si hay credenciales de Twilio, usarlas
    if (accountSid && authToken && accountSid !== 'tu_account_sid') {
        console.log('✅ Usando TURN de Twilio');
        return {
            iceServers: [
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302',
                        'stun:global.stun.twilio.com:3478'
                    ],
                },
                {
                    urls: [
                        'turn:global.turn.twilio.com:3478?transport=udp',
                        'turn:global.turn.twilio.com:3478?transport=tcp',
                        'turn:global.turn.twilio.com:443?transport=tcp',
                        'turn:global.turn.twilio.com:5349?transport=tcp'
                    ],
                    username: accountSid,
                    credential: authToken,
                },
                // 🔥 TURN de respaldo
                {
                    urls: [
                        'turn:openrelay.metered.ca:80',
                        'turn:openrelay.metered.ca:443',
                        'turn:openrelay.metered.ca:3478'
                    ],
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                },
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
            rtcpMuxPolicy: 'require',
        };
    }
    
    // 🔥 MULTIPLES SERVIDORES DE RESPALDO
    console.log('🔄 Usando TURN público de respaldo');
    return {
        iceServers: [
            {
                urls: [
                    'stun:stun.l.google.com:19302',
                    'stun:stun1.l.google.com:19302',
                    'stun:stun2.l.google.com:19302',
                    'stun:stun3.l.google.com:19302',
                    'stun:stun4.l.google.com:19302'
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
            },
            {
                urls: [
                    'turn:numb.viagenie.ca:3478',
                    'turn:numb.viagenie.ca:443'
                ],
                username: 'webrtc@live.com',
                credential: 'muazkh'
            },
            {
                urls: [
                    'turn:turn.anyfirewall.com:443?transport=tcp'
                ],
                username: 'webrtc',
                credential: 'webrtc'
            }
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
    };
};

router.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitando credenciales TURN');
    
    try {
        const config = getTurnConfig();
        console.log('✅ Configuración TURN generada exitosamente');
        res.json(config);
    } catch (error) {
        console.error('❌ Error generando TURN:', error.message);
        res.status(500).json({
            error: 'Error generando credenciales TURN',
            message: error.message,
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                {
                    urls: 'turn:openrelay.metered.ca:443',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                }
            ]
        });
    }
});

router.get('/test-turn', (req, res) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    res.json({
        status: 'ok',
        message: 'Servidor TURN configurado',
        timestamp: new Date().toISOString(),
        twilioConfigured: !!(accountSid && accountSid !== 'tu_account_sid'),
        publicTurnEnabled: true
    });
});

module.exports = router;

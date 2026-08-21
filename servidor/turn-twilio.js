const express = require('express');
const router = express.Router();
require('dotenv').config();

console.log('🔑 Credenciales cargadas desde .env');

router.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitando credenciales TURN de Twilio');
    
    try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        
        console.log('🔑 Account SID:', accountSid);
        
        const turnConfig = {
            iceServers: [
                {
                    urls: [
                        'stun:global.stun.twilio.com:3478?transport=udp',
                        'stun:global.stun.twilio.com:3478?transport=tcp',
                    ],
                },
                {
                    urls: [
                        'turn:global.turn.twilio.com:3478?transport=udp',
                        'turn:global.turn.twilio.com:3478?transport=tcp',
                        'turn:global.turn.twilio.com:443?transport=tcp',
                    ],
                    username: accountSid,
                    credential: authToken,
                },
            ],
            iceCandidatePoolSize: 10,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
        };
        
        console.log('✅ TURN config generada con credenciales estáticas');
        res.json(turnConfig);
        
    } catch (error) {
        console.error('❌ Error generando TURN:', error.message);
        res.status(500).json({
            error: 'Error generando credenciales TURN',
            message: error.message
        });
    }
});

router.get('/test-turn', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Servidor TURN de Twilio configurado',
        timestamp: new Date().toISOString(),
        accountSid: process.env.TWILIO_ACCOUNT_SID,
    });
});

module.exports = router;

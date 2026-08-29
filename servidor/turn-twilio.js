const express = require('express');
const router = express.Router();
require('dotenv').config();

console.log('🔑 Configurando TURN de Twilio...');

router.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitando credenciales TURN');
    
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    
    console.log(`📋 Account SID: ${accountSid ? '✅ Configurado' : '❌ No configurado'}`);
    console.log(`📋 Auth Token: ${authToken ? '✅ Configurado' : '❌ No configurado'}`);
    
    // 🔥 USAR TWILIO SI ESTÁ CONFIGURADO
    if (accountSid && authToken && accountSid !== 'tu_account_sid') {
        console.log('✅ Usando TURN de Twilio');
        res.json({
            iceServers: [
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:global.stun.twilio.com:3478'
                    ]
                },
                {
                    urls: [
                        'turn:global.turn.twilio.com:3478?transport=udp',
                        'turn:global.turn.twilio.com:3478?transport=tcp',
                        'turn:global.turn.twilio.com:443?transport=tcp',
                        'turn:global.turn.twilio.com:5349?transport=tcp'
                    ],
                    username: accountSid,
                    credential: authToken
                }
            ],
            iceCandidatePoolSize: 10,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
    } else {
        console.log('⚠️ Twilio NO configurado, usando STUN público');
        res.json({
            iceServers: [
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302'
                    ]
                }
            ]
        });
    }
});

router.get('/test-turn', (req, res) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        twilioConfigured: !!(accountSid && accountSid !== 'tu_account_sid'),
        message: accountSid ? '✅ Twilio configurado' : '❌ Twilio NO configurado'
    });
});

module.exports = router;

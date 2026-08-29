const express = require('express');
const router = express.Router();
require('dotenv').config();

console.log('🔑 Configurando TURN de Twilio con puerto 443...');

router.get('/turn-credentials', (req, res) => {
    console.log('📡 Solicitando credenciales TURN');
    
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    
    console.log(`📋 Account SID: ${accountSid ? '✅ Configurado' : '❌ No configurado'}`);
    console.log(`📋 Auth Token: ${authToken ? '✅ Configurado' : '❌ No configurado'}`);
    
    // 🔥 USAR TWILIO CON PUERTO 443 (HTTPS - NO BLOQUEADO)
    if (accountSid && authToken && accountSid !== 'tu_account_sid') {
        console.log('✅ Usando TURN de Twilio (puerto 443)');
        res.json({
            iceServers: [
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302',
                        'stun:global.stun.twilio.com:3478'
                    ]
                },
                {
                    // 🔥 SOLO PUERTO 443 (HTTPS) - NO BLOQUEADO POR RENDER
                    urls: [
                        'turn:global.turn.twilio.com:443?transport=tcp',
                        'turn:global.turn.twilio.com:443?transport=udp'
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
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302'
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
        message: accountSid ? '✅ Twilio configurado (puerto 443)' : '❌ Twilio NO configurado'
    });
});

module.exports = router;

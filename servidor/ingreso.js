'use strict';

/**
 * Ventana Digital — acceso con código
 * --------------------------------------------------------------
 * 1. Quien quiere entrar escribe su nombre -> POST /api/ingreso/solicitar
 * 2. El servidor genera un código de 6 dígitos y se lo envía al anfitrión:
 *    - por Telegram (gratis) si están TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID
 *    - si no, por SMS con Twilio (TWILIO_* y OWNER_PHONE)
 * 3. Si el anfitrión aprueba, le da el código a esa persona.
 * 4. La persona escribe el código -> POST /api/ingreso/verificar
 * 5. Si es correcto, recibe el token de LiveKit y entra a la sala.
 *
 * Ambos canales usan fetch (Node 20+): no hace falta instalar paquetes.
 */

const crypto = require('crypto');
const express = require('express');

const VIGENCIA_MS = 5 * 60 * 1000;        // el código vence en 5 minutos
const MAX_INTENTOS = 5;                   // intentos de código por solicitud
const SOLICITUDES_POR_IP = 3;             // solicitudes por IP...
const VENTANA_IP_MS = 10 * 60 * 1000;     // ...cada 10 minutos
const SMS_POR_HORA = 30;                  // tope global para proteger tu saldo de Twilio

function crearRutasIngreso({ limpiarNombre, crearAcceso, livekitConfigurado }) {
    const twilioSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const twilioToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    const twilioDesde = (process.env.TWILIO_PHONE || '').trim();

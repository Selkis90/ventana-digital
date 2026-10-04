'use strict';

/**
 * Ventana Digital — servidor
 * --------------------------------------------------------------
 * 1. Sirve el cliente web (carpeta /cliente).
 * 2. Controla el ingreso a la sala con un código enviado por SMS
 *    al anfitrión (ver ingreso.js). Solo con ese código se emite
 *    el token de LiveKit.
 * 3. Expone configuración pública y un health check.
 *
 * LiveKit Cloud se encarga de audio, video, TURN/STUN y reconexión,
 * por eso este servidor NO necesita Socket.IO. Twilio solo se usa
 * para enviar el SMS con el código.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');
const { crearRutasIngreso } = require('./ingreso');

// ============================================================
// CONFIGURACIÓN

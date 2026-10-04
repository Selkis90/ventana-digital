/* ============================================================
   VENTANA DIGITAL — CLIENTE
   ------------------------------------------------------------
   Arquitectura:
   - Un solo estado (st) y una función sincronizar() idempotente
     que reconstruye la vista a partir del estado real de LiveKit.
     Así no hay "videos fantasma" ni audios duplicados.
   - Reconexión: LiveKit resuelve los cortes cortos por sí mismo;
     si la sala se cae del todo, reintentamos con backoff exponencial.
   - Sin polling, sin setInterval: todo se mueve por eventos.
   ============================================================ */

(function () {
    'use strict';

    // ============================================================
    // CONSTANTES
    // ============================================================

    const APP_VERSION = '2.0.0';
    const CDN_RESPALDO = 'https://unpkg.com/livekit-client@2.22.3/dist/livekit-client.umd.js';
    const MAX_REINTENTOS = 8;

    const esTactil = window.matchMedia('(pointer: coarse)').matches;
    const esMovil =
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS

    let LK = null; // window.LivekitClient cuando esté cargado

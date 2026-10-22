'use strict';

/**
 * Horario de funcionamiento (opcional)
 * --------------------------------------------------------------
 * HORARIO="lun-vie 07:30-17:30"               un tramo
 * HORARIO="lun-vie 07:30-17:30; sab 08:00-12:00"  varios tramos
 * Vacío = la sala funciona las 24 horas.
 *
 * Fuera del horario los equipos se desconectan solos y vuelven a entrar
 * a la hora de apertura. Así no se gastan datos de Cloudflare ni horas
 * de Render si alguien deja la pantalla prendida de noche.
 */

const DIAS = { dom: 0, lun: 1, mar: 2, mie: 3, mié: 3, jue: 4, vie: 5, sab: 6, sáb: 6 };
const NUM_DIA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function aMinutos(hhmm) {
    const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 24 || min > 59) return null;
    return h * 60 + min;
}

function parsearDias(texto) {
    const dias = new Set();
    for (const parte of texto.split(',')) {
        const [a, b] = parte.trim().split('-').map((d) => DIAS[d.trim().toLowerCase()]);
        if (a === undefined || (parte.includes('-') && b === undefined)) return null;
        if (b === undefined) {
            dias.add(a);
        } else {
            for (let d = a; ; d = (d + 1) % 7) {
                dias.add(d);
                if (d === b) break;
            }
        }
    }
    return dias;
}

function parsearHorario(texto) {
    const limpio = String(texto || '').trim();
    if (!limpio) return null;
    const tramos = [];
    for (const bloque of limpio.split(';').map((s) => s.trim()).filter(Boolean)) {
        const m = bloque.match(/^(\S+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        if (!m) throw new Error(`HORARIO inválido: "${bloque}". Ejemplo: lun-vie 07:30-17:30`);
        const dias = parsearDias(m[1]);
        const desde = aMinutos(m[2]);
        const hasta = aMinutos(m[3]);
        if (!dias || desde === null || hasta === null || hasta <= desde) {
            throw new Error(`HORARIO inválido: "${bloque}". Ejemplo: lun-vie 07:30-17:30`);
        }
        tramos.push({ dias, desde, hasta });
    }
    return tramos;
}

function crearHorario(texto, zona) {
    const tramos = parsearHorario(texto);
    const formato = new Intl.DateTimeFormat('en-US', {
        timeZone: zona,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    });

    function activoEn(fecha) {
        if (!tramos) return true;
        const partes = Object.fromEntries(formato.formatToParts(fecha).map((p) => [p.type, p.value]));
        const dia = NUM_DIA[partes.weekday];
        const minuto = Number(partes.hour) * 60 + Number(partes.minute);
        return tramos.some((t) => t.dias.has(dia) && minuto >= t.desde && minuto < t.hasta);
    }

    // { activo, msCambio }: si está abierto ahora y en cuántos ms cambia
    function estado(ahora = Date.now()) {
        if (!tramos) return { activo: true, msCambio: null };
        const activo = activoEn(new Date(ahora));
        const inicioMinuto = Math.floor(ahora / 60000) * 60000;
        for (let i = 1; i <= 8 * 24 * 60; i++) {
            const t = inicioMinuto + i * 60000;
            if (activoEn(new Date(t)) !== activo) return { activo, msCambio: t - ahora };
        }
        return { activo, msCambio: null };
    }

    return { configurado: Boolean(tramos), texto: String(texto || '').trim(), zona, estado };
}

module.exports = { crearHorario };

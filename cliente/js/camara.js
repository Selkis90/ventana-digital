'use strict';

// ✅ CONFIGURACIÓN
const LIVEKIT_URL = 'wss://ventana-digital-scr9uykx.livekit.cloud';
const ROOM_NAME = 'sala-principal';

// DOM Elements
const gridVideos = document.getElementById('grid-videos');
const estado = document.getElementById('estado');
const estadoIndicador = estado?.querySelector('.estado-indicador');
const estadoTexto = estado?.querySelector('.estado-texto');
const btnMicrofono = document.getElementById('btn-microfono');
const btnCamara = document.getElementById('btn-camara');
const btnSilenciar = document.getElementById('btn-silenciar');
const btnCompartir = document.getElementById('btn-compartir');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnReconectar = document.getElementById('btn-reconectar');
const btnDiagnostico = document.getElementById('btn-diagnostico');
const volumen = document.getElementById('volumen');
const volumenLabel = document.getElementById('volumen-label');
const miId = document.getElementById('mi-id');
const peerConectado = document.getElementById('peer-conectado');
const calidadRed = document.getElementById('calidad-red');
const loadingOverlay = document.getElementById('loading-overlay');

// Variables de estado
let room = null;
let conectando = false;
let reconectando = false;
let audioMuted = false;
let monitorTracksInterval = null;
let volumenActual = 1.0;

let reconexionTimeout = null;
let intentosReconexion = 0;
const MAX_INTENTOS_RECONEXION = 5;

const videoMap = new Map();
const audioMap = new Map();

let monitorInternet = null;
let internetStatus = true;
let reintentosReconexion = 0;
const MAX_REINTENTOS_RECONEXION = 10;

// ============================================================
// FUNCIONES DE UTILIDAD
// ============================================================

function actualizarEstado(texto, tipo) {
    tipo = tipo || 'conectando';
    if (!estado || !estadoTexto) return;
    estadoTexto.textContent = texto;
    estado.className = 'estado-' + tipo;
}

function generarIdentidad() {
    var aleatorio = Math.random().toString(36).substring(2, 8);
    return 'Usuario-' + aleatorio;
}

function ocultarLoading() {
    if (loadingOverlay) {
        loadingOverlay.classList.add('oculto');
    }
}

function mostrarLoading() {
    if (loadingOverlay) {
        loadingOverlay.classList.remove('oculto');
    }
}

// ============================================================
// ✅ OBTENER AUDIO CON MEJOR CONFIGURACIÓN
// ============================================================

async function obtenerAudioProfesional() {
    try {
        var constraints = {
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
                sampleSize: 24,
                channelCount: 1,
                googEchoCancellation: true,
                googAutoGainControl: true,
                googNoiseSuppression: true,
                googHighpassFilter: true,
                googAudioMirroring: false,
                googEchoCancellation2: true,
                googAutoGainControl2: true,
                googNoiseSuppression2: true,
                googVoiceDetection: true
            }
        };

        var stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        if (stream.getAudioTracks().length === 0) {
            throw new Error('No se obtuvieron pistas de audio');
        }

        var track = stream.getAudioTracks()[0];
        if (track && track.getCapabilities) {
            try {
                var capabilities = track.getCapabilities();
                console.log('📊 Capabilities de audio:', capabilities);
                if (capabilities && capabilities.autoGainControl) {
                    await track.applyConstraints({
                        autoGainControl: true,
                        noiseSuppression: true,
                        echoCancellation: true
                    });
                }
            } catch (e) {
                console.warn('⚠️ No se pudieron aplicar constraints adicionales:', e);
            }
        }

        console.log('🎤 Audio profesional obtenido');
        return stream;
    } catch (error) {
        console.warn('⚠️ Error con audio avanzado, usando fallback:', error);
        
        try {
            var stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            console.log('🎤 Audio básico obtenido');
            return stream;
        } catch (fallbackError) {
            console.error('❌ Error crítico obteniendo audio:', fallbackError);
            throw fallbackError;
        }
    }
}

// ============================================================
// ✅ FORZAR PUBLICACIÓN DE AUDIO CON VERIFICACIÓN - CORREGIDO
// ============================================================

async function publicarAudioConVerificacion() {
    console.log('🎤 Publicando audio con verificación...');
    
    if (!room) {
        console.error('❌ Room no disponible');
        return false;
    }
    
    try {
        var audioPublication = room.localParticipant.getTrack(LivekitClient.Track.Source.Microphone);
        
        if (!audioPublication) {
            audioPublication = room.localParticipant.getPublication(LivekitClient.Track.Source.Microphone);
        }
        
        if (audioPublication) {
            console.log('📡 Audio ya publicado, verificando estado...');
            if (audioPublication.isEnabled === false) {
                await room.localParticipant.setMicrophoneEnabled(true);
                console.log('✅ Audio habilitado');
            }
            
            if (audioPublication.track) {
                console.log('✅ Track de audio existente y válido');
                if (btnMicrofono) {
                    btnMicrofono.classList.add('activo');
                    btnMicrofono.classList.remove('inactivo');
                }
                return true;
            }
        }
        
        console.log('📡 Publicando nuevo track de audio...');
        var audioStream = await obtenerAudioProfesional();
        var audioTrack = audioStream.getAudioTracks()[0];
        
        if (!audioTrack) {
            console.error('❌ No se obtuvo track de audio');
            return false;
        }
        
        await room.localParticipant.publishTrack(audioTrack, {
            name: 'microfono',
            source: LivekitClient.Track.Source.Microphone,
            simulcast: false
        });
        
        console.log('✅ Audio publicado exitosamente');
        
        audioPublication = room.localParticipant.getTrack(LivekitClient.Track.Source.Microphone);
        if (!audioPublication) {
            audioPublication = room.localParticipant.getPublication(LivekitClient.Track.Source.Microphone);
        }
        
        if (audioPublication && audioPublication.track) {
            console.log('✅ Verificación de publicación exitosa');
            if (btnMicrofono) {
                btnMicrofono.classList.add('activo');
                btnMicrofono.classList.remove('inactivo');
            }
            return true;
        } else {
            console.error('❌ Falló la verificación de publicación');
            return false;
        }
        
    } catch (error) {
        console.error('❌ Error publicando audio:', error);
        
        try {
            console.log('📡 Intentando método alternativo...');
            await room.localParticipant.setMicrophoneEnabled(true);
            console.log('✅ Audio habilitado por método alternativo');
            if (btnMicrofono) {
                btnMicrofono.classList.add('activo');
                btnMicrofono.classList.remove('inactivo');
            }
            return true;
        } catch (e) {
            console.error('❌ Error en método alternativo:', e);
            return false;
        }
    }
}

// ============================================================
// ✅ FORZAR SUSCRIPCIÓN DE AUDIO PARA TODOS LOS PARTICIPANTES
// ============================================================

async function forzarSuscripcionAudio(participant) {
    if (!participant) return;
    
    console.log('🔊 Forzando suscripción de audio para:', participant.identity);
    
    try {
        var audioPublications = [];
        participant.trackPublications.forEach(function(pub) {
            if (pub.kind === 'audio') {
                audioPublications.push(pub);
            }
        });
        
        if (audioPublications.length === 0) {
            console.log('   ⚠️ No hay publicaciones de audio para', participant.identity);
            return;
        }
        
        console.log('   📡 Encontradas', audioPublications.length, 'publicaciones de audio');
        
        for (var i = 0; i < audioPublications.length; i++) {
            var pub = audioPublications[i];
            if (!pub.isSubscribed) {
                console.log('   🔄 Forzando suscripción a audio de', participant.identity, '...');
                try {
                    if (typeof pub.subscribe === 'function') {
                        await pub.subscribe();
                        console.log('   ✅ Suscripción forzada exitosa');
                    }
                } catch (error) {
                    console.warn('   ⚠️ Error forzando suscripción:', error);
                }
            } else {
                console.log('   ✅ Audio ya está suscrito para', participant.identity);
            }
            
            if (pub.isSubscribed && pub.track) {
                console.log('   🔊 Creando audio para', participant.identity, '...');
                agregarAudioRemotoConGanancia(pub.track, participant);
            }
        }
    } catch (error) {
        console.error('❌ Error forzando suscripción para', participant.identity, ':', error);
    }
}

// ============================================================
// ✅ MONITOREO DE TRACKS REMOTOS
// ============================================================

function iniciarMonitoreoTracks() {
    console.log('📡 Iniciando monitoreo de tracks remotos...');
    
    if (monitorTracksInterval) {
        clearInterval(monitorTracksInterval);
    }
    
    monitorTracksInterval = setInterval(function() {
        if (!room || room.state !== 'connected') return;
        
        var remoteParticipants = room.remoteParticipants;
        if (!remoteParticipants || remoteParticipants.size === 0) return;
        
        remoteParticipants.forEach(function(participant, identity) {
            participant.trackPublications.forEach(function(pub) {
                if (pub.kind === 'audio') {
                    if (!pub.isSubscribed) {
                        console.warn('⚠️ Track de audio de', identity, 'NO suscrito - Forzando...');
                        try {
                            if (typeof pub.subscribe === 'function') {
                                pub.subscribe().then(function() {
                                    console.log('✅ Suscripción forzada para', identity);
                                }).catch(function(error) {
                                    console.error('❌ Error forzando suscripción para', identity, ':', error);
                                });
                            }
                        } catch (error) {
                            console.error('❌ Error forzando suscripción para', identity, ':', error);
                        }
                    }
                    
                    if (pub.isSubscribed && pub.track) {
                        if (!audioMap.has(identity)) {
                            console.log('🔊 Creando audio faltante para', identity, '...');
                            agregarAudioRemotoConGanancia(pub.track, participant);
                        }
                    }
                }
            });
        });
        
        audioMap.forEach(function(audioInfo, identity) {
            if (audioInfo.isFallback && !audioInfo.element) {
                console.warn('⚠️ Audio en mapa sin elemento HTML para', identity, '- Recreando...');
                audioMap.delete(identity);
                var participant = room.remoteParticipants.get(identity);
                if (participant) {
                    participant.trackPublications.forEach(function(pub) {
                        if (pub.kind === 'audio' && pub.track) {
                            agregarAudioRemotoConGanancia(pub.track, participant);
                        }
                    });
                }
            }
        });
    }, 5000);
}

// ============================================================
// ✅ REPARACIÓN COMPLETA DE AUDIO
// ============================================================

async function reparacionCompletaAudio() {
    console.log('🔧 ====== INICIANDO REPARACIÓN COMPLETA DE AUDIO ======');
    
    if (!room) {
        console.error('❌ Room no disponible');
        return false;
    }
    
    console.log('📡 Estado del room:', room.state);
    console.log('👥 Participantes remotos:', room.remoteParticipants ? room.remoteParticipants.size : 0);
    
    console.log('📤 1. Reparando audio local...');
    await publicarAudioConVerificacion();
    
    console.log('👥 2. Verificando participantes remotos...');
    if (room.remoteParticipants && room.remoteParticipants.size > 0) {
        var participants = Array.from(room.remoteParticipants.values());
        for (var i = 0; i < participants.length; i++) {
            var participant = participants[i];
            var identity = participant.identity;
            console.log('   Procesando:', identity);
            
            var audioTrack = null;
            participant.trackPublications.forEach(function(pub) {
                if (pub.kind === 'audio') {
                    console.log('   📡 Audio encontrado: suscrito=', pub.isSubscribed);
                    
                    if (!pub.isSubscribed) {
                        console.log('   🔄 Forzando suscripción...');
                        try {
                            if (typeof pub.subscribe === 'function') {
                                (function(pubLocal) {
                                    pubLocal.subscribe().then(function() {
                                        console.log('   ✅ Suscripción forzada');
                                    }).catch(function(error) {
                                        console.error('   ❌ Error forzando suscripción:', error);
                                    });
                                })(pub);
                            }
                        } catch (error) {
                            console.error('   ❌ Error forzando suscripción:', error);
                        }
                    }
                    
                    if (pub.isSubscribed && pub.track) {
                        audioTrack = pub.track;
                    }
                }
            });
            
            if (audioTrack) {
                console.log('   🔊 Creando/recreando audio para', identity, '...');
                
                if (audioMap.has(identity)) {
                    var oldAudio = audioMap.get(identity);
                    if (oldAudio.element) {
                        oldAudio.element.remove();
                    }
                    audioMap.delete(identity);
                }
                
                agregarAudioRemotoConGanancia(audioTrack, participant);
                
                var newAudio = audioMap.get(identity);
                if (newAudio && newAudio.element) {
                    newAudio.element.volume = Math.min(volumenActual, 1.0);
                    newAudio.element.muted = false;
                    newAudio.element.play().catch(function() {});
                    console.log('   ✅ Audio reproducido para', identity);
                }
            } else {
                console.warn('   ⚠️ No se encontró track de audio para', identity);
            }
        }
    } else {
        console.warn('⚠️ No hay participantes remotos');
    }
    
    console.log('📻 3. Verificando audios en el DOM...');
    var audios = document.querySelectorAll('audio[data-identity]');
    console.log('   Total:', audios.length);
    audios.forEach(function(audio) {
        var identity = audio.dataset.identity || 'N/A';
        console.log('   🎵', identity, ': volumen=', audio.volume, ', muted=', audio.muted, ', paused=', audio.paused);
        if (audio.paused) {
            audio.play().catch(function() {});
            console.log('   ▶️ Reproducción forzada para', identity);
        }
    });
    
    console.log('🎵 4. Forzando reanudación de AudioContext...');
    await forzarReanudacionAudio();
    
    console.log('🎚️ 5. Actualizando volumen...');
    actualizarVolumen();
    
    console.log('✅ ====== REPARACIÓN COMPLETA FINALIZADA ======');
    return true;
}

// ============================================================
// ✅ FORZAR REANUDACIÓN DE AUDIO CONTEXT
// ============================================================

async function forzarReanudacionAudio() {
    console.log('🔊 Forzando reanudación de AudioContext...');
    
    var reanudados = 0;
    
    audioMap.forEach(function(audioInfo, identity) {
        if (!audioInfo.isFallback && audioInfo.context) {
            try {
                if (audioInfo.context.state === 'suspended') {
                    audioInfo.context.resume().then(function() {
                        reanudados++;
                        console.log('✅ AudioContext reanudado para:', identity);
                    }).catch(function(error) {
                        console.error('❌ Error reanudando AudioContext para', identity, ':', error);
                    });
                } else if (audioInfo.context.state === 'running') {
                    console.log('✅ AudioContext ya está running para:', identity);
                }
            } catch (error) {
                console.error('❌ Error reanudando AudioContext para', identity, ':', error);
            }
        }
    });
    
    document.querySelectorAll('audio[data-identity]').forEach(function(audio) {
        try {
            audio.volume = Math.min(volumenActual, 1.0);
            audio.muted = false;
            if (audio.paused) {
                audio.play().catch(function() {});
                console.log('▶️ Reproducción forzada para:', audio.dataset.identity);
            }
        } catch (e) {}
    });
    
    if (reanudados === 0 && audioMap.size === 0) {
        try {
            var backupContext = new (window.AudioContext || window.webkitAudioContext)();
            if (backupContext.state === 'suspended') {
                await backupContext.resume();
                console.log('✅ AudioContext de respaldo creado y reanudado');
            }
            backupContext.close().catch(function() {});
        } catch (e) {
            console.warn('⚠️ Error creando AudioContext de respaldo:', e);
        }
    }
    
    console.log('✅ Reanudados', reanudados, 'AudioContexts');
    return reanudados;
}

// ============================================================
// ✅ RESTAURAR AUDIO DESPUÉS DE RECONEXIÓN
// ============================================================

async function restaurarAudioDespuesReconexion() {
    console.log('🔄 Restaurando audio después de reconexión...');
    
    if (!room) {
        console.warn('⚠️ Room no disponible');
        return;
    }
    
    await forzarReanudacionAudio();
    await reparacionCompletaAudio();
    actualizarVolumen();
    console.log('✅ Audio restaurado completamente');
}

// ============================================================
// ✅ RECONEXIÓN POR PÉRDIDA DE INTERNET
// ============================================================

function iniciarMonitorInternet() {
    console.log('🌐 Iniciando monitor de internet...');
    
    window.addEventListener('online', function() {
        console.log('🌐 Internet CONECTADO');
        internetStatus = true;
        reintentosReconexion = 0;
        if (!room || room.state === 'disconnected') {
            console.log('🔄 Reconectando por recuperación de internet...');
            reconectarManual();
        }
    });
    
    window.addEventListener('offline', function() {
        console.warn('🌐 Internet DESCONECTADO');
        internetStatus = false;
        actualizarEstado('Sin Internet', 'error');
    });
    
    monitorInternet = setInterval(function() {
        if (navigator.onLine && (!room || room.state === 'disconnected')) {
            console.log('🔄 Detectada desconexión - Intentando reconectar...');
            fetch('/get-token', { 
                method: 'HEAD',
                signal: AbortSignal.timeout(5000)
            })
            .then(function(response) {
                if (response.ok) {
                    console.log('✅ Servidor accesible - Reconectando...');
                    reintentosReconexion = 0;
                    reconectarManual();
                }
            })
            .catch(function() {
                console.warn('⚠️ Servidor no accesible, esperando...');
                reintentosReconexion++;
                if (reintentosReconexion >= MAX_REINTENTOS_RECONEXION) {
                    console.error('❌ Demasiados intentos fallidos');
                    actualizarEstado('Error crítico - Recarga la página', 'error');
                    reintentosReconexion = 0;
                }
            });
        }
    }, 10000);
}

async function reconexionAutomatica() {
    if (conectando || reconectando) {
        console.log('⏳ Ya hay una reconexión en progreso');
        return;
    }
    
    console.log('🔄 Iniciando reconexión automática...');
    
    var intento = 0;
    var maxIntentos = 5;
    var delayBase = 1000;
    
    while (intento < maxIntentos) {
        if (!navigator.onLine) {
            console.log('🌐 Sin internet - Esperando...');
            await new Promise(function(resolve) { setTimeout(resolve, 5000); });
            intento++;
            continue;
        }
        
        try {
            console.log('🔄 Intento', intento + 1, '/', maxIntentos);
            var response = await fetch('/get-token', { 
                method: 'HEAD',
                signal: AbortSignal.timeout(5000)
            });
            
            if (response.ok) {
                await reconectarManual();
                console.log('✅ Reconexión automática exitosa');
                return true;
            }
        } catch (error) {
            console.warn('⚠️ Intento', intento + 1, 'fallido:', error.message);
        }
        
        var delay = delayBase * Math.pow(2, intento);
        console.log('⏳ Esperando', delay, 'ms antes del siguiente intento...');
        await new Promise(function(resolve) { setTimeout(resolve, delay); });
        intento++;
    }
    
    console.error('❌ Fallaron todos los intentos de reconexión');
    actualizarEstado('Error - Recarga manual', 'error');
    return false;
}

function guardarEstadoSala() {
    if (!room) return;
    try {
        var estado = {
            roomName: ROOM_NAME,
            identity: room.localParticipant ? room.localParticipant.identity : null,
            timestamp: Date.now()
        };
        sessionStorage.setItem('ventana_digital_estado', JSON.stringify(estado));
        console.log('💾 Estado guardado:', estado);
    } catch (error) {
        console.warn('⚠️ Error guardando estado:', error);
    }
}

function recuperarEstadoSala() {
    try {
        var data = sessionStorage.getItem('ventana_digital_estado');
        if (!data) return null;
        var estado = JSON.parse(data);
        var tiempoTranscurrido = Date.now() - estado.timestamp;
        if (tiempoTranscurrido > 300000) {
            sessionStorage.removeItem('ventana_digital_estado');
            return null;
        }
        console.log('💾 Estado recuperado:', estado);
        return estado;
    } catch (error) {
        console.warn('⚠️ Error recuperando estado:', error);
        return null;
    }
}

// ============================================================
// ✅ CONEXIÓN
// ============================================================

async function conectarLiveKit() {
    if (conectando) {
        console.log('⏳ Conexión en progreso...');
        return;
    }
    
    if (reconexionTimeout) {
        clearTimeout(reconexionTimeout);
        reconexionTimeout = null;
    }
    
    conectando = true;

    try {
        actualizarEstado('Conectando...', 'conectando');
        mostrarLoading();

        if (room) {
            try { 
                await room.disconnect(); 
            } catch (error) { 
                console.warn('Error desconectando:', error); 
            }
            room = null;
        }

        limpiarVideos();

        var participantName = generarIdentidad();

        var respuesta = await fetch('/get-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                roomName: ROOM_NAME, 
                participantName: participantName 
            })
        });

        if (!respuesta.ok) {
            throw new Error('HTTP ' + respuesta.status);
        }

        var data = await respuesta.json();
        if (!data.token) {
            throw new Error('No se recibió token');
        }

        room = new LivekitClient.Room({ 
            adaptiveStream: false,
            dynacast: true
        });
        
        registrarEventosLiveKit();
        
        await room.connect(LIVEKIT_URL, data.token, { 
            autoSubscribe: true 
        });

        if (miId) {
            miId.textContent = participantName;
        }

        await publicarAudioConVerificacion();

        try { 
            await room.localParticipant.setCameraEnabled(true);
            if (btnCamara) {
                btnCamara.classList.remove('inactivo');
                btnCamara.classList.add('activo');
            }
            console.log('✅ Cámara activada');
        } catch (error) { 
            console.warn('⚠️ Cámara no disponible:', error); 
            if (btnCamara) {
                btnCamara.classList.add('inactivo');
            }
        }

        if (room.remoteParticipants && room.remoteParticipants.size > 0) {
            var participants = Array.from(room.remoteParticipants.values());
            for (var i = 0; i < participants.length; i++) {
                var participant = participants[i];
                await forzarSuscripcionAudio(participant);
                participant.trackPublications.forEach(function(pub) {
                    if (pub.kind === 'video' && pub.isSubscribed && pub.track) {
                        agregarVideoRemoto(pub.track, participant);
                    }
                });
            }
        }

        conectando = false;
        reconectando = false;
        intentosReconexion = 0;

        actualizarEstado('Conectado', 'conectado');
        actualizarParticipanteRemoto();
        actualizarLayout();
        ocultarLoading();
        console.log('✅ Conexión exitosa');

    } catch (error) {
        console.error('❌ ERROR:', error);
        actualizarEstado('Error de conexión', 'error');
        conectando = false;
        ocultarLoading();
        
        if (intentosReconexion < MAX_INTENTOS_RECONEXION) {
            intentosReconexion++;
            var delay = intentosReconexion * 2000;
            console.log('🔄 Reconexión en', delay/1000, 's (intento', intentosReconexion, '/', MAX_INTENTOS_RECONEXION, ')');
            reconexionTimeout = setTimeout(function() {
                reconexionTimeout = null;
                conectarLiveKit();
            }, delay);
        }
    }
}

// ============================================================
// ✅ EVENTOS
// ============================================================

function registrarEventosLiveKit() {
    if (!room) return;

    room.on(LivekitClient.RoomEvent.ParticipantConnected, function(participant) {
        console.log('👤 Participante conectado:', participant.identity);
        
        (function(p) {
            forzarSuscripcionAudio(p).then(function() {
                p.trackPublications.forEach(function(pub) {
                    if (pub.kind === 'video' && pub.isSubscribed && pub.track) {
                        agregarVideoRemoto(pub.track, p);
                    }
                });
                actualizarLayout();
                actualizarParticipanteRemoto();
            }).catch(function(error) {
                console.error('❌ Error procesando participante:', error);
            });
        })(participant);
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, function(participant) {
        console.log('❌ Participante desconectado:', participant.identity);
        eliminarParticipante(participant);
        actualizarLayout();
        actualizarParticipanteRemoto();
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, function(track, publication, participant) {
        if (!participant) return;
        console.log('📡 Track suscrito:', track.kind, 'de', participant.identity);
        
        if (track.kind === LivekitClient.Track.Kind.Video) {
            agregarVideoRemoto(track, participant);
        } else if (track.kind === LivekitClient.Track.Kind.Audio) {
            console.log('🔊 Track de audio suscrito para:', participant.identity);
            agregarAudioRemotoConGanancia(track, participant);
            
            setTimeout(function() {
                var audioInfo = audioMap.get(participant.identity);
                if (audioInfo && audioInfo.element) {
                    audioInfo.element.volume = Math.min(volumenActual, 1.0);
                    audioInfo.element.muted = false;
                    audioInfo.element.play().catch(function() {});
                    console.log('🔊 Audio forzado a reproducir para:', participant.identity);
                }
            }, 500);
        }
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, function(track, publication, participant) {
        if (!participant) return;
        console.log('📤 Track unsubscribe:', track.kind, 'de', participant.identity);
        eliminarTrackRemoto(track, participant);
    });

    room.on(LivekitClient.RoomEvent.LocalTrackPublished, function(publication) {
        console.log('📤 Track local publicado:', publication.kind);
        if (publication.kind === LivekitClient.Track.Kind.Video) {
            mostrarVideoLocal(publication);
        }
    });

    room.on(LivekitClient.RoomEvent.Reconnecting, function() {
        reconectando = true;
        actualizarEstado('Reconectando...', 'conectando');
        console.log('🔄 LiveKit reconectando...');
    });

    room.on(LivekitClient.RoomEvent.Reconnected, function() {
        reconectando = false;
        intentosReconexion = 0;
        actualizarEstado('Conectado', 'conectado');
        console.log('✅ LiveKit reconectado');
        
        (function() {
            restaurarAudioDespuesReconexion().then(function() {
                actualizarLayout();
            }).catch(function(error) {
                console.error('❌ Error restaurando audio:', error);
            });
        })();
    });

    room.on(LivekitClient.RoomEvent.Disconnected, function(reason) {
        reconectando = false;
        console.warn('⚠️ Desconectado:', reason);
        guardarEstadoSala();
        
        if (reason === 'user' || reason === 'room_closed') {
            actualizarEstado('Desconectado', 'error');
            return;
        }

        if (navigator.onLine) {
            console.log('🌐 Internet disponible - Iniciando reconexión automática');
            actualizarEstado('Reconectando automáticamente...', 'conectando');
            (function() {
                reconexionAutomatica().catch(function(error) {
                    console.error('❌ Error en reconexión automática:', error);
                });
            })();
        } else {
            console.log('🌐 Sin internet - Esperando conexión');
            actualizarEstado('Esperando internet...', 'conectando');
            var esperarInternet = function() {
                if (!navigator.onLine) {
                    setTimeout(function() {
                        esperarInternet();
                    }, 1000);
                } else {
                    console.log('🌐 Internet recuperado - Reconectando...');
                    reconexionAutomatica().catch(function(error) {
                        console.error('❌ Error en reconexión automática:', error);
                    });
                }
            };
            esperarInternet();
        }
    });
}

// ============================================================
// ✅ VIDEO REMOTO
// ============================================================

function agregarVideoRemoto(track, participant) {
    if (!participant || !track) return;
    
    var identity = participant.identity;
    
    if (identity === (room ? room.localParticipant.identity : null)) {
        console.log('⏭️ Saltando video propio');
        return;
    }

    if (videoMap.has(identity)) {
        console.log('⏭️ Video ya existe para', identity);
        return;
    }

    var video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.controls = false;
    video.dataset.identity = identity;
    video.className = 'video-remoto';
    gridVideos.appendChild(video);
    videoMap.set(identity, video);
    console.log('📹 Video creado para:', identity);

    try {
        if (typeof track.attach === 'function') {
            track.attach(video);
        } else {
            var stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(function() {});
        }
    } catch (error) {
        console.warn('⚠️ Error adjuntando video:', error);
        try {
            var stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(function() {});
        } catch (e) {
            console.error('❌ Error en fallback de video:', e);
        }
    }
    
    actualizarLayout();
}

// ============================================================
// ✅ AUDIO REMOTO
// ============================================================

function agregarAudioRemotoConGanancia(track, participant) {
    if (!participant || !track) return;
    
    var identity = participant.identity;
    
    if (identity === (room ? room.localParticipant.identity : null)) {
        console.log('⏭️ 🚨 SALTANDO AUDIO PROPIO - EVITA ECO');
        return;
    }

    if (audioMap.has(identity)) {
        console.log('⏭️ Audio ya existe para', identity);
        return;
    }

    try {
        console.log('📻 Creando audio HTML5 para:', identity);
        
        var audioElement = document.createElement('audio');
        audioElement.autoplay = true;
        audioElement.playsInline = true;
        audioElement.dataset.identity = identity;
        audioElement.volume = Math.min(volumenActual, 1.0);
        audioElement.muted = false;
        audioElement.setAttribute('autoplay', '');
        audioElement.setAttribute('playsinline', '');
        document.body.appendChild(audioElement);
        
        if (typeof track.attach === 'function') {
            track.attach(audioElement);
            console.log('✅ Track adjuntado a HTML para:', identity);
        } else {
            var stream = new MediaStream();
            stream.addTrack(track.mediaStreamTrack);
            audioElement.srcObject = stream;
            audioElement.play().catch(function() {});
            console.log('✅ Stream adjuntado a HTML para:', identity);
        }
        
        var audioInfo = {
            element: audioElement,
            identity: identity,
            isFallback: true,
            track: track,
            connected: true
        };
        
        audioMap.set(identity, audioInfo);
        console.log('🔊 Audio HTML5 creado para:', identity, '(volumen:', audioElement.volume, ')');
        
        actualizarVolumen();
        window.audioMap = audioMap;
        window.room = room;
        window.volumenActual = volumenActual;
        
        setTimeout(function() {
            audioElement.volume = Math.min(volumenActual, 1.0);
            audioElement.muted = false;
            audioElement.play().catch(function() {});
            console.log('▶️ Reproducción forzada para:', identity);
        }, 300);
        
        return audioInfo;
        
    } catch (htmlError) {
        console.error('❌ Error creando audio HTML5:', htmlError);
        console.warn('⚠️ Usando Web Audio API como respaldo...');
        
        try {
            var audioContext = new (window.AudioContext || window.webkitAudioContext)();
            var gainNode = audioContext.createGain();
            var volumenAmplificado = volumenActual * 1.5;
            gainNode.gain.value = Math.min(volumenAmplificado, 2.0);
            
            var source = audioContext.createMediaStreamSource(
                new MediaStream([track.mediaStreamTrack])
            );
            
            source.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            var audioInfo = {
                context: audioContext,
                source: source,
                gainNode: gainNode,
                identity: identity,
                track: track,
                connected: true,
                isFallback: false
            };
            
            audioMap.set(identity, audioInfo);
            console.log('🔊 Web Audio creado (respaldo) para:', identity);
            
            if (audioContext.state === 'suspended') {
                audioContext.resume().then(function() {
                    console.log('🎵 AudioContext reanudado para', identity);
                }).catch(function(err) {
                    console.warn('⚠️ Error reanudando AudioContext para', identity, ':', err);
                });
            }
            
            actualizarVolumen();
            window.audioMap = audioMap;
            window.room = room;
            window.volumenActual = volumenActual;
            
            return audioInfo;
            
        } catch (webAudioError) {
            console.error('❌ Error en respaldo Web Audio:', webAudioError);
            return null;
        }
    }
}

// ============================================================
// ✅ CONTROL DE VOLUMEN
// ============================================================

function actualizarVolumen() {
    if (!volumen) return;
    
    volumenActual = Number(volumen.value);
    console.log('🎚️ Volumen ajustado a:', (volumenActual * 100).toFixed(0), '%');
    
    document.querySelectorAll('audio[data-identity]').forEach(function(audio) {
        audio.volume = Math.min(volumenActual, 1.0);
        audio.muted = false;
    });
    
    audioMap.forEach(function(audioInfo, identity) {
        if (audioInfo.isFallback && audioInfo.element) {
            return;
        } else if (audioInfo.gainNode) {
            var volumenAmplificado = volumenActual * 1.5;
            var valorFinal = Math.min(volumenAmplificado, 2.0);
            audioInfo.gainNode.gain.value = valorFinal;
            console.log('🔊', identity, '(Web Audio): gain =', (valorFinal * 100).toFixed(0), '%');
        }
    });
    
    if (volumenLabel) {
        volumenLabel.textContent = Math.round(volumenActual * 100) + '%';
    }
    
    window.volumenActual = volumenActual;
}

// ============================================================
// ELIMINAR TRACKS
// ============================================================

function eliminarTrackRemoto(track, participant) {
    if (!participant) return;
    var identity = participant.identity;

    if (track && track.kind === LivekitClient.Track.Kind.Video) {
        var video = videoMap.get(identity);
        if (video) {
            try {
                if (typeof track.detach === 'function') {
                    track.detach(video);
                }
            } catch (e) {}
            video.srcObject = null;
            video.remove();
            videoMap.delete(identity);
            console.log('🗑️ Video eliminado:', identity);
        }
    }

    if (track && track.kind === LivekitClient.Track.Kind.Audio) {
        var audioInfo = audioMap.get(identity);
        if (audioInfo) {
            try {
                if (audioInfo.source) {
                    audioInfo.source.disconnect();
                }
                if (audioInfo.gainNode) {
                    audioInfo.gainNode.disconnect();
                }
                if (audioInfo.context && audioInfo.context.state !== 'closed') {
                    audioInfo.context.close().catch(function() {});
                }
                if (audioInfo.element) {
                    if (typeof track.detach === 'function') {
                        track.detach(audioInfo.element);
                    }
                    audioInfo.element.srcObject = null;
                    audioInfo.element.remove();
                }
            } catch (e) {}
            
            audioMap.delete(identity);
            console.log('🗑️ Audio eliminado:', identity);
        }
    }

    actualizarLayout();
}

function eliminarParticipante(participant) {
    if (!participant) return;
    var identity = participant.identity;

    var video = videoMap.get(identity);
    if (video) {
        video.srcObject = null;
        video.remove();
        videoMap.delete(identity);
    }

    var audioInfo = audioMap.get(identity);
    if (audioInfo) {
        try {
            if (audioInfo.source) {
                audioInfo.source.disconnect();
            }
            if (audioInfo.gainNode) {
                audioInfo.gainNode.disconnect();
            }
            if (audioInfo.context && audioInfo.context.state !== 'closed') {
                audioInfo.context.close().catch(function() {});
            }
            if (audioInfo.element) {
                audioInfo.element.srcObject = null;
                audioInfo.element.remove();
            }
        } catch (e) {}
        audioMap.delete(identity);
    }
}

function agregarParticipante(participant) {
    if (!participant || !participant.trackPublications) return;

    participant.trackPublications.forEach(function(publication) {
        if (publication.isSubscribed && publication.track) {
            if (publication.track.kind === LivekitClient.Track.Kind.Video) {
                agregarVideoRemoto(publication.track, participant);
            } else if (publication.track.kind === LivekitClient.Track.Kind.Audio) {
                agregarAudioRemotoConGanancia(publication.track, participant);
            }
        }
    });
}

// ============================================================
// VIDEO LOCAL
// ============================================================

function mostrarVideoLocal(publication) {
    if (!publication || !publication.videoTrack) return;

    var video = document.getElementById('video-local');
    if (!video) {
        video = document.createElement('video');
        video.id = 'video-local';
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.className = 'video-local';
        gridVideos.prepend(video);
        console.log('📹 Video local creado');
    }

    try {
        if (typeof publication.videoTrack.attach === 'function') {
            publication.videoTrack.attach(video);
            console.log('✅ Video local adjuntado');
        } else {
            var stream = new MediaStream();
            stream.addTrack(publication.videoTrack.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(function() {});
            console.log('✅ Video local adjuntado (fallback)');
        }
    } catch (error) {
        console.warn('⚠️ Error adjuntando video local:', error);
        try {
            var stream = new MediaStream();
            stream.addTrack(publication.videoTrack.mediaStreamTrack);
            video.srcObject = stream;
            video.play().catch(function() {});
        } catch (e) {
            console.error('❌ Error en fallback de video local:', e);
        }
    }
    
    actualizarLayout();
}

// ============================================================
// LIMPIAR
// ============================================================

function limpiarVideos() {
    if (!gridVideos) return;
    
    gridVideos.querySelectorAll('video').forEach(function(video) {
        try {
            video.srcObject = null;
            video.remove();
        } catch (e) {}
    });
    
    audioMap.forEach(function(audioInfo, identity) {
        try {
            if (audioInfo.source) {
                audioInfo.source.disconnect();
            }
            if (audioInfo.gainNode) {
                audioInfo.gainNode.disconnect();
            }
            if (audioInfo.context && audioInfo.context.state !== 'closed') {
                audioInfo.context.close().catch(function() {});
            }
            if (audioInfo.element) {
                audioInfo.element.srcObject = null;
                audioInfo.element.remove();
            }
        } catch (e) {}
    });
    
    document.querySelectorAll('audio[data-identity]').forEach(function(audio) {
        try {
            audio.srcObject = null;
            audio.remove();
        } catch (e) {}
    });
    
    videoMap.clear();
    audioMap.clear();
    
    console.log('🧹 Videos y audios limpiados');
}

// ============================================================
// UI
// ============================================================

function actualizarParticipanteRemoto() {
    if (!peerConectado || !room) return;
    var cantidad = room.remoteParticipants ? room.remoteParticipants.size : 0;
    peerConectado.textContent = cantidad;
}

function actualizarLayout() {
    if (!gridVideos) return;
    
    var videos = gridVideos.querySelectorAll('video');
    var total = videos.length;
    
    if (total === 0) {
        gridVideos.style.gridTemplateColumns = '1fr';
        gridVideos.style.gridTemplateRows = '1fr';
        gridVideos.style.gap = '0';
        return;
    }

    if (total === 1) {
        gridVideos.style.gridTemplateColumns = '1fr';
        gridVideos.style.gridTemplateRows = '1fr';
        gridVideos.style.gap = '0';
        return;
    }

    if (total === 2) {
        gridVideos.style.gridTemplateColumns = 'repeat(2, 1fr)';
        gridVideos.style.gridTemplateRows = '1fr';
        gridVideos.style.gap = '2px';
        return;
    }

    if (total <= 4) {
        gridVideos.style.gridTemplateColumns = 'repeat(2, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(2, 1fr)';
        gridVideos.style.gap = '2px';
        return;
    }

    if (total <= 6) {
        gridVideos.style.gridTemplateColumns = 'repeat(3, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(2, 1fr)';
        gridVideos.style.gap = '2px';
        return;
    }

    if (total <= 9) {
        gridVideos.style.gridTemplateColumns = 'repeat(3, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(3, 1fr)';
        gridVideos.style.gap = '2px';
        return;
    }

    if (total <= 12) {
        gridVideos.style.gridTemplateColumns = 'repeat(4, 1fr)';
        gridVideos.style.gridTemplateRows = 'repeat(3, 1fr)';
        gridVideos.style.gap = '2px';
        return;
    }

    var columns = Math.min(Math.ceil(Math.sqrt(total * 1.5)), 6);
    gridVideos.style.gridTemplateColumns = 'repeat(' + columns + ', 1fr)';
    gridVideos.style.gridTemplateRows = 'repeat(' + Math.ceil(total / columns) + ', 1fr)';
    gridVideos.style.gap = '2px';
}

// ============================================================
// ✅ CONTROLES - BOTONES DE CÁMARA Y MICRÓFONO - VERSIÓN CORREGIDA
// ============================================================

// ✅ 1. BOTÓN MICRÓFONO - CORREGIDO
async function alternarMicrofono() {
    if (!room) {
        console.warn('⚠️ Room no disponible');
        return;
    }
    
    try {
        // Feedback visual de clic
        if (btnMicrofono) {
            btnMicrofono.style.transition = 'transform 0.15s ease';
            btnMicrofono.style.transform = 'scale(0.85)';
            setTimeout(function() {
                if (btnMicrofono) btnMicrofono.style.transform = 'scale(1)';
            }, 200);
        }
        
        // Obtener estado actual usando la propiedad correcta
        const isEnabled = room.localParticipant.isMicrophoneEnabled;
        console.log('🎤 Estado actual micrófono:', isEnabled);
        
        // Alternar estado
        await room.localParticipant.setMicrophoneEnabled(!isEnabled);
        
        // Obtener nuevo estado después de la operación
        const newState = room.localParticipant.isMicrophoneEnabled;
        console.log('🎤 Nuevo estado micrófono:', newState);
        
        // Actualizar UI - Usando las clases correctas del CSS
        if (btnMicrofono) {
            // Remover todas las clases de estado
            btnMicrofono.classList.remove('activo', 'inactivo');
            
            if (newState) {
                // Micrófono ACTIVADO - verde (clase 'activo')
                btnMicrofono.classList.add('activo');
                btnMicrofono.innerHTML = `
                    <svg viewBox="0 0 24 24">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="23"/>
                        <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                `;
                btnMicrofono.title = 'Desactivar micrófono';
                btnMicrofono.setAttribute('aria-label', 'Desactivar micrófono');
            } else {
                // Micrófono DESACTIVADO - rojo (clase 'inactivo')
                btnMicrofono.classList.add('inactivo');
                btnMicrofono.innerHTML = `
                    <svg viewBox="0 0 24 24">
                        <line x1="1" y1="1" x2="23" y2="23"/>
                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
                        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
                        <line x1="12" y1="19" x2="12" y2="23"/>
                        <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                `;
                btnMicrofono.title = 'Activar micrófono';
                btnMicrofono.setAttribute('aria-label', 'Activar micrófono');
            }
        }
        
        console.log(`🎤 Micrófono ${newState ? 'activado' : 'desactivado'}`);
        
    } catch (error) {
        console.error('❌ Error con micrófono:', error);
        // Revertir UI en caso de error
        if (btnMicrofono) {
            try {
                const isEnabled = room.localParticipant.isMicrophoneEnabled;
                btnMicrofono.classList.remove('activo', 'inactivo');
                btnMicrofono.classList.add(isEnabled ? 'activo' : 'inactivo');
            } catch (e) {
                console.warn('⚠️ No se pudo revertir UI de micrófono');
            }
        }
    }
}

// ✅ 2. BOTÓN CÁMARA - CORREGIDO
async function alternarCamara() {
    if (!room) {
        console.warn('⚠️ Room no disponible');
        return;
    }
    
    try {
        // Feedback visual de clic
        if (btnCamara) {
            btnCamara.style.transition = 'transform 0.15s ease';
            btnCamara.style.transform = 'scale(0.85)';
            setTimeout(function() {
                if (btnCamara) btnCamara.style.transform = 'scale(1)';
            }, 200);
        }
        
        // Obtener estado actual usando la propiedad correcta
        const isEnabled = room.localParticipant.isCameraEnabled;
        console.log('📷 Estado actual cámara:', isEnabled);
        
        // Alternar estado
        await room.localParticipant.setCameraEnabled(!isEnabled);
        
        // Obtener nuevo estado después de la operación
        const newState = room.localParticipant.isCameraEnabled;
        console.log('📷 Nuevo estado cámara:', newState);
        
        // Actualizar UI - Usando las clases correctas del CSS
        if (btnCamara) {
            // Remover todas las clases de estado
            btnCamara.classList.remove('activo', 'inactivo');
            
            if (newState) {
                // Cámara ACTIVADA - verde (clase 'activo')
                btnCamara.classList.add('activo');
                btnCamara.innerHTML = `
                    <svg viewBox="0 0 24 24">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                        <circle cx="12" cy="13" r="4"/>
                    </svg>
                `;
                btnCamara.title = 'Desactivar cámara';
                btnCamara.setAttribute('aria-label', 'Desactivar cámara');
            } else {
                // Cámara DESACTIVADA - rojo (clase 'inactivo')
                btnCamara.classList.add('inactivo');
                btnCamara.innerHTML = `
                    <svg viewBox="0 0 24 24">
                        <line x1="1" y1="1" x2="23" y2="23"/>
                        <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06a4 4 0 1 1-5.56-5.56"/>
                    </svg>
                `;
                btnCamara.title = 'Activar cámara';
                btnCamara.setAttribute('aria-label', 'Activar cámara');
            }
        }
        
        console.log(`📷 Cámara ${newState ? 'activada' : 'desactivada'}`);
        
    } catch (error) {
        console.error('❌ Error con cámara:', error);
        // Revertir UI en caso de error
        if (btnCamara) {
            try {
                const isEnabled = room.localParticipant.isCameraEnabled;
                btnCamara.classList.remove('activo', 'inactivo');
                btnCamara.classList.add(isEnabled ? 'activo' : 'inactivo');
            } catch (e) {
                console.warn('⚠️ No se pudo revertir UI de cámara');
            }
        }
    }
}

// ============================================================
// OTROS CONTROLES
// ============================================================

async function silenciarTemporalmente() {
    if (!room || audioMuted) return;
    
    audioMuted = true;
    if (btnSilenciar) {
        btnSilenciar.classList.add('activo');
    }
    
    try {
        await room.localParticipant.setMicrophoneEnabled(false);
        console.log('🔇 Silenciado temporalmente');
        
        setTimeout(async function() {
            try {
                await room.localParticipant.setMicrophoneEnabled(true);
                audioMuted = false;
                if (btnSilenciar) {
                    btnSilenciar.classList.remove('activo');
                }
                console.log('🎤 Micrófono reactivado');
            } catch (error) {
                console.error('❌ Error reactivando:', error);
                audioMuted = false;
                if (btnSilenciar) {
                    btnSilenciar.classList.remove('activo');
                }
            }
        }, 5000);
    } catch (error) {
        console.error('❌ Error silenciando:', error);
        audioMuted = false;
        if (btnSilenciar) {
            btnSilenciar.classList.remove('activo');
        }
    }
}

async function compartirPantalla() {
    if (!room) return;
    
    try {
        var stream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { cursor: 'always', frameRate: 30 } 
        });
        var track = stream.getVideoTracks()[0];
        if (track) {
            await room.localParticipant.publishTrack(track, {
                name: 'screen-share',
                source: LivekitClient.Track.Source.ScreenShare
            });
            console.log('🖥️ Pantalla compartida');
            track.onended = function() { console.log('🖥️ Compartición finalizada'); };
        }
    } catch (error) {
        if (error.name !== 'NotAllowedError' && error.name !== 'PermissionDeniedError') {
            console.error('❌ Error compartiendo:', error);
        }
    }
}

async function pantallaCompleta() {
    if (!gridVideos) return;
    
    try {
        if (!document.fullscreenElement) {
            await gridVideos.requestFullscreen();
        } else {
            await document.exitFullscreen();
        }
    } catch (error) {
        console.error('❌ Error pantalla completa:', error);
    }
}

async function reconectarManual() {
    if (conectando || reconectando) {
        console.log('⏳ Ya hay una reconexión en progreso');
        return;
    }
    
    reconectando = true;
    intentosReconexion = 0;
    
    if (reconexionTimeout) {
        clearTimeout(reconexionTimeout);
        reconexionTimeout = null;
    }
    
    actualizarEstado('Reconectando manual...', 'conectando');
    mostrarLoading();
    
    try {
        if (room) {
            try { await room.disconnect(); } catch (e) {}
            room = null;
        }
        limpiarVideos();
        await new Promise(function(resolve) { setTimeout(resolve, 500); });
        await conectarLiveKit();
    } catch (error) {
        console.error('❌ Error reconectando:', error);
        actualizarEstado('Error al reconectar', 'error');
        ocultarLoading();
    } finally {
        reconectando = false;
    }
}

// ============================================================
// ✅ DIAGNÓSTICO
// ============================================================

function diagnostico() {
    var info = '📊 DIAGNÓSTICO VENTANA DIGITAL PRO\n\n';
    info += '━'.repeat(50) + '\n\n';
    info += '🔗 LiveKit URL: ' + LIVEKIT_URL + '\n';
    info += '📁 Sala: ' + ROOM_NAME + '\n\n';
    
    if (room) {
        info += '📡 Estado: ' + (room.state || 'desconocido') + '\n';
        info += '🆔 Mi ID: ' + (room.localParticipant ? room.localParticipant.identity : 'N/A') + '\n';
        info += '👥 Participantes remotos: ' + (room.remoteParticipants ? room.remoteParticipants.size : 0) + '\n';
        info += '📹 Videos en pantalla: ' + gridVideos.querySelectorAll('video').length + '\n';
        info += '🔊 Audios remotos: ' + audioMap.size + '\n\n';
        
        info += '🔊 CONFIGURACIÓN ANTI-ECO:\n';
        info += '   ✅ Echo Cancellation: ACTIVADO\n';
        info += '   ✅ Noise Suppression: ACTIVADO\n';
        info += '   ✅ Auto Gain Control: ACTIVADO\n';
        info += '   ✅ Video local: MUTED\n';
        info += '   ✅ Audio propio: NO REPRODUCIDO\n\n';
        
        info += '🔊 DIAGNÓSTICO DE VOLUMEN:\n';
        info += '   🎚️ Volumen actual: ' + (volumenActual * 100).toFixed(0) + '%\n';
        
        var html5Count = 0;
        var webAudioCount = 0;
        audioMap.forEach(function(a) {
            if (a.isFallback && a.element) html5Count++;
            else if (a.gainNode) webAudioCount++;
        });
        info += '   📊 Audios HTML5: ' + html5Count + '\n';
        info += '   📊 Audios Web Audio: ' + webAudioCount + '\n\n';
        
        if (audioMap.size > 0) {
            info += '🔊 DETALLE DE AUDIOS:\n';
            audioMap.forEach(function(audioInfo, identity) {
                if (audioInfo.isFallback && audioInfo.element) {
                    var vol = audioInfo.element ? audioInfo.element.volume : 0;
                    var paused = audioInfo.element && audioInfo.element.paused ? '⏸️ pausado' : '▶️ reproduciendo';
                    info += '   📻 ' + identity + ': HTML5, volumen=' + (vol * 100).toFixed(0) + '%, ' + paused + '\n';
                } else if (audioInfo.gainNode) {
                    var gain = audioInfo.gainNode.gain.value;
                    var state = audioInfo.context ? audioInfo.context.state : 'unknown';
                    info += '   🔊 ' + identity + ': Web Audio, ganancia=' + (gain * 100).toFixed(0) + '%, estado=' + state + '\n';
                }
            });
        }
        
        var pub = room.localParticipant ? room.localParticipant.getTrack(LivekitClient.Track.Source.Microphone) : null;
        if (!pub) {
            pub = room.localParticipant ? room.localParticipant.getPublication(LivekitClient.Track.Source.Microphone) : null;
        }
        info += '\n📤 AUDIO LOCAL:\n';
        info += '   Publicado: ' + (!!pub) + '\n';
        info += '   Habilitado: ' + (pub ? pub.isEnabled : false) + '\n';
        info += '   Track existe: ' + (!!(pub && pub.track)) + '\n';
        
        info += '\n🌐 ESTADO DE INTERNET:\n';
        info += '   📶 Online: ' + (navigator.onLine ? 'SÍ' : 'NO') + '\n';
        info += '   🔄 Reconectando: ' + (reconectando ? 'SÍ' : 'NO') + '\n';
    } else {
        info += '❌ Room: NO CONECTADO\n';
    }
    
    info += '\n' + '━'.repeat(50) + '\n';
    info += '🌐 Navegador: ' + navigator.userAgent;
    
    console.log(info);
    alert(info);
}

// ============================================================
// EVENT LISTENERS
// ============================================================

if (btnMicrofono) btnMicrofono.addEventListener('click', alternarMicrofono);
if (btnCamara) btnCamara.addEventListener('click', alternarCamara);
if (btnSilenciar) btnSilenciar.addEventListener('click', silenciarTemporalmente);
if (btnCompartir) btnCompartir.addEventListener('click', compartirPantalla);
if (btnFullscreen) btnFullscreen.addEventListener('click', pantallaCompleta);
if (btnReconectar) btnReconectar.addEventListener('click', reconectarManual);
if (btnDiagnostico) btnDiagnostico.addEventListener('click', diagnostico);

if (volumen) {
    if (volumen.min === '') volumen.min = '0';
    if (volumen.max === '') volumen.max = '1';
    if (volumen.step === '') volumen.step = '0.01';
    if (volumen.value === '') volumen.value = '1.0';
    
    volumen.addEventListener('input', actualizarVolumen);
}

window.addEventListener('resize', actualizarLayout);
window.addEventListener('orientationchange', function() {
    setTimeout(actualizarLayout, 300);
});

document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
        actualizarLayout();
    }
});

document.addEventListener('click', function() {
    console.log('🖱️ Click detectado - Reanudando audio...');
    (function() {
        forzarReanudacionAudio().then(function() {
            return reparacionCompletaAudio();
        }).catch(function(error) {
            console.error('❌ Error en click handler:', error);
        });
    })();
}, { once: false });

// ============================================================
// ✅ EXPONER VARIABLES GLOBALES
// ============================================================

window.room = room;
window.audioMap = audioMap;
window.videoMap = videoMap;
window.volumenActual = volumenActual;
window.agregarAudioRemotoConGanancia = agregarAudioRemotoConGanancia;
window.forzarReanudacionAudio = forzarReanudacionAudio;
window.actualizarVolumen = actualizarVolumen;
window.forzarSuscripcionAudio = forzarSuscripcionAudio;
window.reparacionCompletaAudio = reparacionCompletaAudio;
window.publicarAudioConVerificacion = publicarAudioConVerificacion;
window.iniciarMonitoreoTracks = iniciarMonitoreoTracks;

// ============================================================
// INICIALIZACIÓN
// ============================================================

async function iniciarCamara() {
    console.log('🚀 Iniciando Ventana Digital Pro...');
    console.log('📋 Versión: 4.8.2 - Solo Botones Corregidos');
    console.log('🔊 Volumen por defecto: 100% (amplificado 150%)');
    console.log('💡 Haz clic en la página para activar el audio si es necesario');
    console.log('🌐 Monitor de internet activado');
    console.log('📡 Monitoreo de tracks activado');
    console.log('🔍 Variables expuestas globalmente para diagnóstico');
    
    iniciarMonitorInternet();
    
    if (volumen) {
        volumen.value = '1.0';
        if (volumenLabel) {
            volumenLabel.textContent = '100%';
        }
    }
    
    actualizarVolumen();
    actualizarLayout();
    await conectarLiveKit();
    
    iniciarMonitoreoTracks();
    
    setTimeout(function() {
        (function() {
            reparacionCompletaAudio().then(function() {
                console.log('✅ Reparación automática completada');
            }).catch(function(error) {
                console.error('❌ Error en reparación automática:', error);
            });
        })();
    }, 3000);
    
    window.room = room;
    window.audioMap = audioMap;
    window.videoMap = videoMap;
    window.volumenActual = volumenActual;
    window.agregarAudioRemotoConGanancia = agregarAudioRemotoConGanancia;
    window.forzarReanudacionAudio = forzarReanudacionAudio;
    window.actualizarVolumen = actualizarVolumen;
    window.forzarSuscripcionAudio = forzarSuscripcionAudio;
    window.reparacionCompletaAudio = reparacionCompletaAudio;
    window.publicarAudioConVerificacion = publicarAudioConVerificacion;
    window.iniciarMonitoreoTracks = iniciarMonitoreoTracks;
    
    setTimeout(function() {
        console.log('✅ Sistema listo - Presiona "Diagnóstico" para ver detalles');
        console.log('🔍 Variables globales disponibles: room, audioMap, videoMap, volumenActual');
        console.log('🔧 Funciones: reparacionCompletaAudio(), forzarSuscripcionAudio()');
        (function() {
            forzarReanudacionAudio().catch(function(error) {
                console.error('❌ Error reanudando audio inicial:', error);
            });
        })();
    }, 2000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarCamara, { once: true });
} else {
    iniciarCamara();
}

'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

require('dotenv').config();


// ============================================================
// CONFIGURACIÓN PRINCIPAL
// ============================================================

const app = express();

const server = http.createServer(app);

const PORT = process.env.PORT || 3000;


// ============================================================
// LIVEKIT
// ============================================================

const LIVEKIT_API_KEY =
    process.env.LIVEKIT_API_KEY;

const LIVEKIT_API_SECRET =
    process.env.LIVEKIT_API_SECRET;


// ============================================================
// VALIDAR CONFIGURACIÓN DE LIVEKIT
// ============================================================

if (!LIVEKIT_API_KEY) {

    console.error(
        '❌ Falta LIVEKIT_API_KEY en el archivo .env'
    );
}


if (!LIVEKIT_API_SECRET) {

    console.error(
        '❌ Falta LIVEKIT_API_SECRET en el archivo .env'
    );
}


// ============================================================
// SOCKET.IO
// ============================================================

const io = new Server(server, {

    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },

    transports: [
        'websocket',
        'polling'
    ],

    pingTimeout: 60000,

    pingInterval: 25000,

    connectTimeout: 45000,

    allowEIO3: true
});


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
    cors({
        origin: '*',
        methods: [
            'GET',
            'POST',
            'OPTIONS'
        ],
        credentials: true
    })
);


app.use(
    express.json()
);


// ============================================================
// INFORMACIÓN DEL SERVIDOR
// ============================================================

console.log('');
console.log('=========================================');
console.log('   VENTANA DIGITAL - SERVIDOR');
console.log('=========================================');
console.log(`📡 Puerto: ${PORT}`);
console.log('🎥 WebRTC: LiveKit');
console.log('🔌 Señalización auxiliar: Socket.IO');
console.log('=========================================');
console.log('');


// ============================================================
// TOKEN LIVEKIT
// ============================================================

app.post('/get-token', async (req, res) => {

    try {

        const {
            roomName,
            participantName
        } = req.body;


        // ----------------------------------------------------
        // VALIDAR ROOM
        // ----------------------------------------------------

        if (
            !roomName ||
            typeof roomName !== 'string'
        ) {

            return res.status(400).json({

                error: 'roomName es obligatorio'

            });
        }


        // ----------------------------------------------------
        // VALIDAR NOMBRE
        // ----------------------------------------------------

        if (
            !participantName ||
            typeof participantName !== 'string'
        ) {

            return res.status(400).json({

                error: 'participantName es obligatorio'

            });
        }


        // ----------------------------------------------------
        // VALIDAR CREDENCIALES
        // ----------------------------------------------------

        if (
            !LIVEKIT_API_KEY ||
            !LIVEKIT_API_SECRET
        ) {

            console.error(
                '❌ Credenciales LiveKit no configuradas'
            );


            return res.status(500).json({

                error:
                    'Servidor LiveKit no configurado'

            });
        }


        // ----------------------------------------------------
        // LIMPIAR IDENTIDAD
        // ----------------------------------------------------

        const identity =
            participantName
                .trim()
                .substring(0, 100);


        // ----------------------------------------------------
        // CREAR TOKEN
        // ----------------------------------------------------

        const at =
            new AccessToken(
                LIVEKIT_API_KEY,
                LIVEKIT_API_SECRET,
                {
                    identity
                }
            );


        // ----------------------------------------------------
        // PERMISOS
        // ----------------------------------------------------

        at.addGrant({

            roomJoin: true,

            room: roomName,

            canPublish: true,

            canSubscribe: true,

            canPublishData: true

        });


        // ----------------------------------------------------
        // GENERAR JWT
        // ----------------------------------------------------

        const token =
            await at.toJwt();


        console.log(
            `🎫 Token LiveKit generado para: ${identity}`
        );


        // ----------------------------------------------------
        // RESPUESTA
        // ----------------------------------------------------

        return res.json({

            token,

            roomName,

            participantName: identity

        });


    } catch (error) {

        console.error(
            '❌ Error generando token LiveKit:',
            error
        );


        return res.status(500).json({

            error:
                'No se pudo generar el token LiveKit',

            message:
                error.message

        });
    }

});


// ============================================================
// TURN TWILIO
// ============================================================
//
// IMPORTANTE:
//
// LiveKit maneja actualmente la conexión WebRTC.
//
// Estas rutas se mantienen porque pueden ser utilizadas
// por otras partes del proyecto o para diagnóstico.
//
// ============================================================

try {

    const turnRoutes =
        require('./turn-twilio');

    app.use(
        '/',
        turnRoutes
    );

    console.log(
        '✅ Rutas TURN Twilio cargadas'
    );

} catch (error) {

    console.warn(
        '⚠️ No se pudo cargar turn-twilio.js:',
        error.message
    );

}


// ============================================================
// SOCKET.IO CLIENT
// ============================================================

app.use(
    '/socket.io',
    express.static(
        path.join(
            __dirname,
            'node_modules/socket.io/client-dist'
        )
    )
);


// ============================================================
// ARCHIVOS ESTÁTICOS DEL CLIENTE
// ============================================================

const clientePath =
    path.join(
        __dirname,
        '../cliente'
    );


app.use(
    express.static(clientePath)
);


// ============================================================
// PÁGINA PRINCIPAL
// ============================================================

app.get(
    '/',
    (req, res) => {

        res.sendFile(
            path.join(
                clientePath,
                'index.html'
            )
        );

    }
);


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
    '/health',
    (req, res) => {

        res.json({

            status: 'ok',

            timestamp:
                new Date().toISOString(),

            uptime:
                process.uptime(),

            clients:
                io.sockets.sockets.size,

            livekit:
                Boolean(
                    LIVEKIT_API_KEY &&
                    LIVEKIT_API_SECRET
                )

        });

    }
);


// ============================================================
// STATUS
// ============================================================

app.get(
    '/status',
    (req, res) => {

        res.json({

            status: 'online',

            version: '1.0.0',

            timestamp:
                new Date().toISOString(),

            connectedClients:
                io.sockets.sockets.size,

            uptime:
                process.uptime(),

            memory:
                process.memoryUsage(),

            services: {

                livekit: true,

                socketio: true,

                turn: true

            }

        });

    }
);


// ============================================================
// CLIENTES CONECTADOS
// ============================================================

app.get(
    '/clientes',
    (req, res) => {

        const sockets =
            io.sockets.sockets;

        const clientesInfo = [];


        sockets.forEach(
            (socket, id) => {

                clientesInfo.push({

                    id,

                    ip:
                        socket.handshake.address,

                    connected:
                        socket.connected,

                    rooms:
                        Array.from(
                            socket.rooms
                        )

                });

            }
        );


        res.json({

            total:
                clientesInfo.length,

            clientes:
                clientesInfo,

            timestamp:
                new Date().toISOString()

        });

    }
);


// ============================================================
// FORZAR ACTUALIZACIÓN DE CLIENTES
// ============================================================

app.post(
    '/refresh-clients',
    (req, res) => {

        const lista =
            Array.from(
                io.sockets.sockets.keys()
            );


        console.log(
            `🔄 Forzando actualización: ${lista.length} clientes`
        );


        io.emit(
            'clientes-conectados',
            lista
        );


        io.emit(
            'clientes-actualizados',
            {

                clientes: lista,

                total:
                    lista.length

            }
        );


        res.json({

            status: 'ok',

            message:
                `Lista de ${lista.length} clientes actualizada`,

            clientes:
                lista,

            timestamp:
                new Date().toISOString()

        });

    }
);


// ============================================================
// LIMPIAR CLIENTES INACTIVOS
// ============================================================

app.post(
    '/cleanup-clients',
    (req, res) => {

        const sockets =
            io.sockets.sockets;


        const activeSockets =
            new Set();


        sockets.forEach(
            (socket, id) => {

                if (socket.connected) {

                    activeSockets.add(id);

                }

            }
        );


        const lista =
            Array.from(
                activeSockets
            );


        console.log(
            `🧹 Limpieza de clientes: ${lista.length} activos`
        );


        io.emit(
            'clientes-conectados',
            lista
        );


        io.emit(
            'clientes-actualizados',
            {

                clientes: lista,

                total:
                    lista.length

            }
        );


        res.json({

            status: 'ok',

            message:
                'Limpieza forzada',

            clientesActivos:
                lista.length,

            clientes:
                lista,

            timestamp:
                new Date().toISOString()

        });

    }
);


// ============================================================
// SOCKET.IO
// ============================================================
//
// IMPORTANTE:
//
// El socket.js que estamos utilizando exporta:
//
// {
//     inicializarSocket,
//     obtenerClientes,
//     obtenerEstado,
//     limpiarClientes
// }
//
// Por eso NO hacemos:
//
// require('./socket/socket')(io)
//
// ============================================================

const socketManager =
    require('./socket/socket');


if (
    socketManager &&
    typeof socketManager.inicializarSocket === 'function'
) {

    socketManager.inicializarSocket(io);

    console.log(
        '✅ Socket.IO inicializado correctamente'
    );

} else {

    console.error(
        '❌ socket/socket.js no contiene inicializarSocket()'
    );

}


// ============================================================
// MANEJO DE ERRORES EXPRESS
// ============================================================

app.use(
    (err, req, res, next) => {

        console.error(
            '❌ Error Express:',
            err
        );


        if (res.headersSent) {

            return next(err);

        }


        res.status(500).json({

            error:
                'Error interno del servidor',

            message:
                err.message

        });

    }
);


// ============================================================
// RUTA 404
// ============================================================

app.use(
    (req, res) => {

        res.status(404).json({

            error: 'Ruta no encontrada',

            path: req.originalUrl

        });

    }
);


// ============================================================
// INICIAR SERVIDOR
// ============================================================

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log('');
        console.log('=========================================');
        console.log('🚀 SERVIDOR INICIADO');
        console.log('=========================================');

        console.log(
            `🌐 Puerto: ${PORT}`
        );

        console.log(
            `🎥 LiveKit: ${
                LIVEKIT_API_KEY &&
                LIVEKIT_API_SECRET
                    ? 'CONFIGURADO'
                    : 'NO CONFIGURADO'
            }`
        );

        console.log(
            `🔌 Socket.IO: ACTIVO`
        );

        console.log(
            `🔑 TURN Twilio: http://localhost:${PORT}/turn-credentials`
        );

        console.log(
            `🧪 Test TURN: http://localhost:${PORT}/test-turn`
        );

        console.log(
            `💚 Health: http://localhost:${PORT}/health`
        );

        console.log(
            `📋 Clientes: http://localhost:${PORT}/clientes`
        );

        console.log('=========================================');
        console.log('');

    }
);


// ============================================================
// ERROR DEL SERVIDOR
// ============================================================

server.on(
    'error',
    (error) => {

        console.error(
            '❌ Error en el servidor:',
            error
        );

    }
);


// ============================================================
// ERROR NO CAPTURADO
// ============================================================

process.on(
    'uncaughtException',
    (error) => {

        console.error(
            '❌ Error no capturado:',
            error
        );

    }
);


// ============================================================
// PROMESA RECHAZADA
// ============================================================

process.on(
    'unhandledRejection',
    (reason) => {

        console.error(
            '❌ Promesa rechazada:',
            reason
        );

    }
);


// ============================================================
// EXPORTAR
// ============================================================

module.exports = {
    app,
    server,
    io
};

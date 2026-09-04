// ============================================================
// SOCKET.IO - VENTANA DIGITAL
// ============================================================
// LiveKit se encarga de:
// - Audio
// - Video
// - WebRTC
// - ICE
// - Reconexión de medios
//
// Socket.IO queda únicamente para:
// - Detectar clientes conectados
// - Informar estado
// - Identificar al orquestador
// - Funciones auxiliares de la aplicación
// ============================================================

const clientes = new Map();

let orquestadorId = null;


// ============================================================
// INICIALIZAR SOCKET.IO
// ============================================================

function inicializarSocket(io) {

    console.log("🔌 Inicializando Socket.IO...");


    // --------------------------------------------------------
    // NUEVA CONEXIÓN
    // --------------------------------------------------------

    io.on("connection", (socket) => {

        console.log(`🟢 Cliente conectado: ${socket.id}`);


        // ----------------------------------------------------
        // REGISTRAR CLIENTE
        // ----------------------------------------------------

        const cliente = {
            id: socket.id,
            conectado: new Date().toISOString()
        };

        clientes.set(socket.id, cliente);


        // ----------------------------------------------------
        // PRIMER CLIENTE = ORQUESTADOR
        // ----------------------------------------------------

        if (!orquestadorId) {

            orquestadorId = socket.id;

            console.log(`👑 Orquestador asignado: ${orquestadorId}`);

        }


        // ----------------------------------------------------
        // ENVIAR IDENTIDAD AL CLIENTE
        // ----------------------------------------------------

        socket.emit("identidad", {
            id: socket.id,
            orquestador: socket.id === orquestadorId
        });


        // ----------------------------------------------------
        // ACTUALIZAR LISTA DE CLIENTES
        // ----------------------------------------------------

        emitirClientes(io);


        // ----------------------------------------------------
        // SOLICITUD DE CLIENTES CONECTADOS
        // ----------------------------------------------------

        socket.on("clientes-conectados", () => {

            socket.emit("lista-clientes", obtenerClientes());

        });


        // ----------------------------------------------------
        // PING
        // ----------------------------------------------------

        socket.on("ping-servidor", () => {

            socket.emit("pong-servidor", {
                timestamp: Date.now()
            });

        });


        // También aceptamos "ping" por compatibilidad
        socket.on("ping", () => {

            socket.emit("pong", {
                timestamp: Date.now()
            });

        });


        // ----------------------------------------------------
        // DESCONEXIÓN
        // ----------------------------------------------------

        socket.on("disconnect", (reason) => {

            console.log(
                `🔴 Cliente desconectado: ${socket.id} - ${reason}`
            );


            clientes.delete(socket.id);


            // ------------------------------------------------
            // SI ERA EL ORQUESTADOR
            // ASIGNAR UNO NUEVO
            // ------------------------------------------------

            if (socket.id === orquestadorId) {

                orquestadorId = null;

                const siguiente = clientes.keys().next();

                if (!siguiente.done) {

                    orquestadorId = siguiente.value;

                    console.log(
                        `👑 Nuevo orquestador: ${orquestadorId}`
                    );


                    const nuevoOrquestador =
                        io.sockets.sockets.get(orquestadorId);

                    if (nuevoOrquestador) {

                        nuevoOrquestador.emit("identidad", {
                            id: orquestadorId,
                            orquestador: true
                        });

                    }

                } else {

                    console.log("ℹ️ No hay clientes para asignar como orquestador");

                }

            }


            // ------------------------------------------------
            // ACTUALIZAR CLIENTES
            // ------------------------------------------------

            emitirClientes(io);

        });

    });


    console.log("✅ Socket.IO listo");

}


// ============================================================
// OBTENER CLIENTES
// ============================================================

function obtenerClientes() {

    return Array.from(clientes.values()).map(cliente => ({

        id: cliente.id,
        conectado: cliente.conectado,
        orquestador: cliente.id === orquestadorId

    }));

}


// ============================================================
// EMITIR LISTA DE CLIENTES
// ============================================================

function emitirClientes(io) {

    const lista = obtenerClientes();


    io.emit("lista-clientes", lista);


    io.emit("clientes-actualizados", {

        clientes: lista,
        total: lista.length,
        orquestador: orquestadorId

    });


    console.log(
        `👥 Clientes conectados: ${lista.length}`
    );

}


// ============================================================
// OBTENER ESTADO
// ============================================================

function obtenerEstado() {

    return {

        total: clientes.size,

        clientes: obtenerClientes(),

        orquestador: orquestadorId

    };

}


// ============================================================
// LIMPIAR CLIENTES
// ============================================================

function limpiarClientes() {

    clientes.clear();

    orquestadorId = null;

    console.log("🧹 Lista de clientes limpiada");

}


// ============================================================
// EXPORTAR
// ============================================================

module.exports = {

    inicializarSocket,

    obtenerClientes,

    obtenerEstado,

    limpiarClientes

};

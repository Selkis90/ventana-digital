// ============================================
// SERVIDOR SOCKET.IO - VENTANA DIGITAL
// ============================================

// Almacenar clientes conectados
const clientes = {};

module.exports = function(io) {
    console.log("⚡ Servidor Socket.IO inicializado");

    io.on("connection", (socket) => {
        console.log("=================================");
        console.log("🔗 Nuevo cliente conectado");
        console.log("📌 ID:", socket.id);
        console.log("📡 IP:", socket.handshake.address);
        console.log("=================================");

        // ============================================
        // REGISTRAR CLIENTE
        // ============================================
        clientes[socket.id] = {
            id: socket.id,
            ip: socket.handshake.address,
            conectado: true,
            timestamp: new Date().toISOString()
        };

        // Enviar lista de clientes al nuevo cliente
        socket.emit("clientes-conectados", Object.keys(clientes));
        console.log(`📋 Clientes totales: ${Object.keys(clientes).length}`);

        // Notificar a TODOS los clientes sobre el nuevo
        io.emit("nuevo-cliente", {
            id: socket.id,
            total: Object.keys(clientes).length
        });

        // ============================================
        // MANEJAR SOLICITUD DE CLIENTES CONECTADOS
        // ============================================
        socket.on("clientes-conectados", (callback) => {
            const lista = Object.keys(clientes);
            console.log(`📋 Clientes conectados: ${lista.length}`);
            if (typeof callback === "function") {
                callback(lista);
            } else {
                socket.emit("clientes-conectados", lista);
            }
        });

        // ============================================
        // 🔥 MANEJAR OFERTA WEBRTC
        // ============================================
        socket.on("offer", (data) => {
            const { target, offer } = data;
            console.log(`📤 OFERTA de ${socket.id} para ${target}`);
            
            // Verificar que el target existe
            if (!clientes[target]) {
                console.log(`❌ Target ${target} no existe`);
                return;
            }
            
            // Reenviar la oferta al target
            io.to(target).emit("offer", {
                from: socket.id,
                offer: offer
            });
            console.log(`✅ Oferta reenviada a ${target}`);
        });

        // ============================================
        // 🔥 MANEJAR RESPUESTA WEBRTC
        // ============================================
        socket.on("answer", (data) => {
            const { target, answer } = data;
            console.log(`📤 RESPUESTA de ${socket.id} para ${target}`);
            
            if (!clientes[target]) {
                console.log(`❌ Target ${target} no existe`);
                return;
            }
            
            io.to(target).emit("answer", {
                from: socket.id,
                answer: answer
            });
            console.log(`✅ Respuesta reenviada a ${target}`);
        });

        // ============================================
        // 🔥 MANEJAR ICE CANDIDATE
        // ============================================
        socket.on("ice-candidate", (data) => {
            const { target, candidate } = data;
            console.log(`🧊 ICE CANDIDATE de ${socket.id} para ${target}`);
            
            if (!clientes[target]) {
                console.log(`❌ Target ${target} no existe`);
                return;
            }
            
            io.to(target).emit("ice-candidate", {
                from: socket.id,
                candidate: candidate
            });
            console.log(`✅ ICE candidate reenviado a ${target}`);
        });

        // ============================================
        // MANEJAR PING/PONG
        // ============================================
        socket.on("ping", (data) => {
            socket.emit("pong", {
                from: socket.id,
                message: "pong",
                timestamp: new Date().toISOString()
            });
        });

        // ============================================
        // MANEJAR DESCONEXIÓN
        // ============================================
        socket.on("disconnect", () => {
            console.log("=================================");
            console.log("❌ Cliente desconectado:", socket.id);
            console.log("=================================");
            
            // Eliminar cliente
            delete clientes[socket.id];
            
            // Notificar a todos los clientes
            io.emit("cliente-desconectado", {
                id: socket.id,
                total: Object.keys(clientes).length
            });
            
            console.log(`📋 Clientes restantes: ${Object.keys(clientes).length}`);
        });

        // ============================================
        // MANEJAR ERRORES
        // ============================================
        socket.on("error", (error) => {
            console.error(`❌ Error en socket ${socket.id}:`, error);
        });

    });

    // ============================================
    // ESTADÍSTICAS DEL SERVIDOR
    // ============================================
    setInterval(() => {
        console.log(`📊 Estado: ${Object.keys(clientes).length} clientes conectados`);
        if (Object.keys(clientes).length > 0) {
            console.log(`📋 IDs: ${Object.keys(clientes).join(", ")}`);
        }
    }, 30000);
};

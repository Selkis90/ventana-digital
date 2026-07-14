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

        // 🔥 ENVIAR LISTA DE CLIENTES AL NUEVO CLIENTE
        const listaClientes = Object.keys(clientes);
        socket.emit("clientes-conectados", listaClientes);
        console.log(`📋 Clientes totales: ${listaClientes.length}`);
        console.log(`📋 IDs: ${listaClientes.join(", ")}`);

        // 🔥 NOTIFICAR A TODOS LOS CLIENTES SOBRE EL NUEVO
        io.emit("nuevo-cliente", {
            id: socket.id,
            total: listaClientes.length
        });

        // ============================================
        // 📨 MANEJAR SOLICITUD DE CLIENTES CONECTADOS
        // ============================================
        socket.on("clientes-conectados", (callback) => {
            const lista = Object.keys(clientes);
            console.log(`📋 Clientes conectados (solicitado): ${lista.length}`);
            console.log(`📋 IDs: ${lista.join(", ")}`);
            
            // 🔥 RESPONDER CON LA LISTA ACTUALIZADA
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
                // 🔥 Notificar al emisor que el target no existe
                socket.emit("error", { 
                    message: `Target ${target} no existe`,
                    type: "offer"
                });
                return;
            }
            
            // 🔥 REENVIAR LA OFERTA AL TARGET
            io.to(target).emit("offer", {
                from: socket.id,
                offer: offer
            });
            console.log(`✅ Oferta REENVIADA a ${target}`);
        });

        // ============================================
        // 🔥 MANEJAR RESPUESTA WEBRTC
        // ============================================
        socket.on("answer", (data) => {
            const { target, answer } = data;
            console.log(`📤 RESPUESTA de ${socket.id} para ${target}`);
            
            if (!clientes[target]) {
                console.log(`❌ Target ${target} no existe`);
                socket.emit("error", { 
                    message: `Target ${target} no existe`,
                    type: "answer"
                });
                return;
            }
            
            // 🔥 REENVIAR LA RESPUESTA AL TARGET
            io.to(target).emit("answer", {
                from: socket.id,
                answer: answer
            });
            console.log(`✅ Respuesta REENVIADA a ${target}`);
        });

        // ============================================
        // 🔥 MANEJAR ICE CANDIDATE
        // ============================================
        socket.on("ice-candidate", (data) => {
            const { target, candidate } = data;
            console.log(`🧊 ICE CANDIDATE de ${socket.id} para ${target}`);
            
            if (!clientes[target]) {
                console.log(`❌ Target ${target} no existe`);
                // 🔥 Guardar en caché por si el target se conecta después
                if (!iceCandidatesCache[target]) {
                    iceCandidatesCache[target] = [];
                }
                iceCandidatesCache[target].push({
                    from: socket.id,
                    candidate: candidate
                });
                console.log(`📦 ICE candidate guardado en caché para ${target}`);
                return;
            }
            
            // 🔥 REENVIAR EL ICE CANDIDATE AL TARGET
            io.to(target).emit("ice-candidate", {
                from: socket.id,
                candidate: candidate
            });
            console.log(`✅ ICE REENVIADO a ${target}`);
        });

        // ============================================
        // MANEJAR PING/PONG
        // ============================================
        socket.on("ping", (data) => {
            console.log(`🏓 PING de ${socket.id}`);
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
            
            // 🔥 NOTIFICAR A TODOS LOS CLIENTES
            io.emit("cliente-desconectado", {
                id: socket.id,
                total: Object.keys(clientes).length
            });
            
            console.log(`📋 Clientes restantes: ${Object.keys(clientes).length}`);
            
            // 🔥 Limpiar caché de ICE candidates para este cliente
            if (iceCandidatesCache[socket.id]) {
                delete iceCandidatesCache[socket.id];
            }
        });

        // ============================================
        // MANEJAR ERRORES
        // ============================================
        socket.on("error", (error) => {
            console.error(`❌ Error en socket ${socket.id}:`, error);
        });

    });

    // ============================================
    // 📊 ESTADÍSTICAS DEL SERVIDOR
    // ============================================
    setInterval(() => {
        const total = Object.keys(clientes).length;
        console.log(`📊 Estado: ${total} clientes conectados`);
        if (total > 0) {
            console.log(`📋 IDs: ${Object.keys(clientes).join(", ")}`);
        }
    }, 30000);
};// ============================================
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

        // 🔥 ENVIAR LISTA DE CLIENTES AL NUEVO CLIENTE
        const listaClientes = Object.keys(clientes);
        socket.emit("clientes-conectados", listaClientes);
        console.log(`📋 Clientes totales: ${listaClientes.length}`);
        console.log(`📋 IDs: ${listaClientes.join(", ")}`);

        // 🔥 NOTIFICAR A TODOS LOS CLIENTES SOBRE EL NUEVO
        io.emit("nuevo-cliente", {
            id: socket.id,
            total: listaClientes.length
        });

        // ============================================
        // 📨 MANEJAR SOLICITUD DE CLIENTES CONECTADOS
        // ============================================
        socket.on("clientes-conectados", (callback) => {
            const lista = Object.keys(clientes);
            console.log(`📋 Clientes conectados (solicitado): ${lista.length}`);
            if (typeof callback === "function") {
                callback(lista);
            } else {
                socket.emit("clientes-conectados", lista);
            }
        });

        // ============================================
        // 🔥 MANEJAR OFERTA WEBRTC (CORREGIDO)
        // ============================================
        socket.on("offer", (data) => {
            const { target, offer } = data;
            console.log(`📤 OFERTA de ${socket.id} para ${target}`);
            
            // Verificar que el target existe
            if (!clientes[target]) {
                console.log(`❌ Target ${target} no existe`);
                return;
            }
            
            // 🔥 REENVIAR LA OFERTA AL TARGET
            io.to(target).emit("offer", {
                from: socket.id,
                offer: offer
            });
            console.log(`✅ Oferta REENVIADA a ${target}`);
        });

        // ============================================
        // 🔥 MANEJAR RESPUESTA WEBRTC (CORREGIDO)
        // ============================================
        socket.on("answer", (data) => {
            const { target, answer } = data;
            console.log(`📤 RESPUESTA de ${socket.id} para ${target}`);
            
            if (!clientes[target]) {
                console.log(`❌ Target ${target} no existe`);
                return;
            }
            
            // 🔥 REENVIAR LA RESPUESTA AL TARGET
            io.to(target).emit("answer", {
                from: socket.id,
                answer: answer
            });
            console.log(`✅ Respuesta REENVIADA a ${target}`);
        });

        // ============================================
        // 🔥 MANEJAR ICE CANDIDATE (CORREGIDO)
        // ============================================
        socket.on("ice-candidate", (data) => {
            const { target, candidate } = data;
            console.log(`🧊 ICE CANDIDATE de ${socket.id} para ${target}`);
            
            if (!clientes[target]) {
                console.log(`❌ Target ${target} no existe`);
                return;
            }
            
            // 🔥 REENVIAR EL ICE CANDIDATE AL TARGET
            io.to(target).emit("ice-candidate", {
                from: socket.id,
                candidate: candidate
            });
            console.log(`✅ ICE REENVIADO a ${target}`);
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
            
            // 🔥 NOTIFICAR A TODOS LOS CLIENTES
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
    // 📊 ESTADÍSTICAS DEL SERVIDOR
    // ============================================
    setInterval(() => {
        const total = Object.keys(clientes).length;
        console.log(`📊 Estado: ${total} clientes conectados`);
        if (total > 0) {
            console.log(`📋 IDs: ${Object.keys(clientes).join(", ")}`);
        }
    }, 30000);
};

module.exports = function(io) {

    console.log("############################################");
    console.log("### SOCKET.JS - SIGNALING SERVER ###");
    console.log("############################################");

    const clientes = {};

    io.on("connection", (socket) => {

        // Registrar cliente
        clientes[socket.id] = {
            id: socket.id,
            conectado: true,
            timestamp: new Date().toISOString()
        };

        const listaClientes = Object.keys(clientes);

        console.log("=================================");
        console.log("🔗 Nuevo cliente conectado:", socket.id);
        console.log("📊 Clientes conectados:", listaClientes.length);
        console.log("📋 Lista:", listaClientes);
        console.log("=================================");

        // ============================================
        // 1. ENVIAR LISTA DE CLIENTES AL NUEVO CLIENTE
        // ============================================
        socket.emit("clientes-conectados", listaClientes);

        // ============================================
        // 2. NOTIFICAR A LOS DEMÁS QUE LLEGÓ UN NUEVO CLIENTE
        // ============================================
        socket.broadcast.emit("nuevo-cliente", {
            id: socket.id,
            total: listaClientes.length
        });

        // ============================================
        // 3. MANEJAR SOLICITUD DE LISTA
        // ============================================
        socket.on("clientes-conectados", (callback) => {
            const lista = Object.keys(clientes);
            console.log("📋 Cliente", socket.id, "solicita lista");
            console.log("📋 Lista enviada:", lista);
            if (typeof callback === "function") {
                callback(lista);
            } else {
                socket.emit("clientes-conectados", lista);
            }
        });

        // ============================================
        // 4. 🔥 REENVIAR OFERTA WEBRTC
        // ============================================
        socket.on("offer", (data) => {
            const targetId = data.target;
            console.log(`📩 OFERTA de ${socket.id} para ${targetId}`);
            
            if (!clientes[targetId]) {
                console.log(`❌ Target ${targetId} no encontrado`);
                return;
            }

            // Reenviar la oferta SOLO al target
            io.to(targetId).emit("offer", {
                from: socket.id,
                offer: data.offer
            });
            console.log(`✅ Oferta reenviada a ${targetId}`);
        });

        // ============================================
        // 5. 🔥 REENVIAR RESPUESTA WEBRTC
        // ============================================
        socket.on("answer", (data) => {
            const targetId = data.target;
            console.log(`📩 RESPUESTA de ${socket.id} para ${targetId}`);
            
            if (!clientes[targetId]) {
                console.log(`❌ Target ${targetId} no encontrado`);
                return;
            }

            // Reenviar la respuesta SOLO al target
            io.to(targetId).emit("answer", {
                from: socket.id,
                answer: data.answer
            });
            console.log(`✅ Respuesta reenviada a ${targetId}`);
        });

        // ============================================
        // 6. 🔥 REENVIAR ICE CANDIDATES
        // ============================================
        socket.on("ice-candidate", (data) => {
            const targetId = data.target;
            console.log(`🧊 ICE CANDIDATE de ${socket.id} para ${targetId}`);
            
            if (!clientes[targetId]) {
                console.log(`❌ Target ${targetId} no encontrado`);
                return;
            }

            // Reenviar el ICE candidate SOLO al target
            io.to(targetId).emit("ice-candidate", {
                from: socket.id,
                candidate: data.candidate
            });
            console.log(`✅ ICE candidate reenviado a ${targetId}`);
        });

        // ============================================
        // 7. MANEJAR DESCONEXIÓN
        // ============================================
        socket.on("disconnect", () => {
            delete clientes[socket.id];
            const listaClientes = Object.keys(clientes);

            console.log("=================================");
            console.log("❌ Cliente desconectado:", socket.id);
            console.log("📊 Clientes conectados:", listaClientes.length);
            console.log("📋 Lista:", listaClientes);
            console.log("=================================");

            // Notificar a todos
            io.emit("cliente-desconectado", {
                id: socket.id,
                total: listaClientes.length
            });

            // Enviar lista actualizada a TODOS
            io.emit("clientes-conectados", listaClientes);
        });

        // Mensaje de bienvenida
        socket.emit("mensaje", {
            texto: "✅ Conectado al servidor de señalización",
            timestamp: new Date().toISOString()
        });

    });

    console.log("✅ Servidor de señalización WebRTC listo");
    console.log("📡 Esperando conexiones...");
};

module.exports = function(io) {

    console.log("############################################");
    console.log("### SOCKET.JS - SIGNALING SERVER V7 ###");
    console.log("############################################");

    const clientes = {};

    io.on("connection", (socket) => {

        console.log("=================================");
        console.log("🔗 Nuevo cliente conectado:", socket.id);
        console.log("📊 Clientes conectados:", Object.keys(clientes).length);
        console.log("=================================");

        // Registrar cliente
        clientes[socket.id] = {
            id: socket.id,
            conectado: true,
            timestamp: new Date().toISOString()
        };

        // ============================================
        // 1. ENVIAR LISTA DE CLIENTES AL NUEVO CLIENTE
        // ============================================
        const lista = Object.keys(clientes);
        socket.emit("clientes-conectados", lista);
        console.log("📋 Lista enviada al nuevo cliente:", lista);

        // ============================================
        // 2. NOTIFICAR A TODOS QUE LLEGÓ UN NUEVO CLIENTE
        // ============================================
        socket.broadcast.emit("nuevo-cliente", {
            id: socket.id,
            total: lista.length
        });

        // ============================================
        // 3. MANEJAR SOLICITUD DE LISTA
        // ============================================
        socket.on("clientes-conectados", (callback) => {
            const listaClientes = Object.keys(clientes);
            console.log("📋 Cliente", socket.id, "solicita lista");
            console.log("📋 Lista enviada:", listaClientes);
            if (typeof callback === "function") {
                callback(listaClientes);
            } else {
                socket.emit("clientes-conectados", listaClientes);
            }
        });

        // ============================================
        // 4. 🔥 REENVIAR OFERTA WEBRTC
        // ============================================
        socket.on("offer", (data) => {
            const targetId = data.target;
            console.log(`📩 OFERTA de ${socket.id} para ${targetId}`);
            console.log(`📩 Datos de oferta:`, data.offer ? "✅ Tiene oferta" : "❌ Sin oferta");
            
            if (!clientes[targetId]) {
                console.log(`❌ Target ${targetId} NO encontrado`);
                console.log(`📋 Clientes disponibles:`, Object.keys(clientes));
                return;
            }

            // Reenviar la oferta SOLO al target
            io.to(targetId).emit("offer", {
                from: socket.id,
                offer: data.offer
            });
            console.log(`✅ Oferta REENVIADA a ${targetId}`);
        });

        // ============================================
        // 5. 🔥 REENVIAR RESPUESTA WEBRTC
        // ============================================
        socket.on("answer", (data) => {
            const targetId = data.target;
            console.log(`📩 RESPUESTA de ${socket.id} para ${targetId}`);
            
            if (!clientes[targetId]) {
                console.log(`❌ Target ${targetId} NO encontrado`);
                console.log(`📋 Clientes disponibles:`, Object.keys(clientes));
                return;
            }

            io.to(targetId).emit("answer", {
                from: socket.id,
                answer: data.answer
            });
            console.log(`✅ Respuesta REENVIADA a ${targetId}`);
        });

        // ============================================
        // 6. 🔥 REENVIAR ICE CANDIDATES
        // ============================================
        socket.on("ice-candidate", (data) => {
            const targetId = data.target;
            console.log(`🧊 ICE CANDIDATE de ${socket.id} para ${targetId}`);
            
            if (!clientes[targetId]) {
                console.log(`❌ Target ${targetId} NO encontrado`);
                return;
            }

            io.to(targetId).emit("ice-candidate", {
                from: socket.id,
                candidate: data.candidate
            });
            console.log(`✅ ICE candidate REENVIADO a ${targetId}`);
        });

        // ============================================
        // 7. 🔥 ENVIAR RESPUESTA DE PRUEBA (PING)
        // ============================================
        socket.on("ping", (data) => {
            console.log(`🏓 PING de ${socket.id} para ${data.target}`);
            io.to(data.target).emit("pong", {
                from: socket.id,
                message: "pong"
            });
        });

        // ============================================
        // 8. MANEJAR DESCONEXIÓN
        // ============================================
        socket.on("disconnect", () => {
            delete clientes[socket.id];
            const listaClientes = Object.keys(clientes);

            console.log("=================================");
            console.log("❌ Cliente desconectado:", socket.id);
            console.log("📊 Clientes conectados:", listaClientes.length);
            console.log("📋 Lista:", listaClientes);
            console.log("=================================");

            io.emit("cliente-desconectado", {
                id: socket.id,
                total: listaClientes.length
            });

            io.emit("clientes-conectados", listaClientes);
        });

        // Mensaje de bienvenida
        socket.emit("mensaje", {
            texto: "✅ Conectado al servidor de señalización V7",
            timestamp: new Date().toISOString()
        });

    });

    console.log("✅ Servidor de señalización WebRTC V7 listo");
    console.log("📡 Esperando conexiones...");
};

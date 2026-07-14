module.exports = function(io) {

    console.log("############################################");
    console.log("### SOCKET.JS VERSION 5 - SIGNALING COMPLETA ###");
    console.log("############################################");

    // Usar objeto para mejor control
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
        console.log("🔗 Nuevo cliente conectado");
        console.log("📌 ID:", socket.id);
        console.log("📊 Clientes conectados:", listaClientes.length);
        console.log("📋 Lista:", listaClientes);
        console.log("=================================");

        // ============================================
        // 1. MANEJAR SOLICITUD DE LISTA DE CLIENTES
        // ============================================
        socket.on("clientes-conectados", (callback) => {
            const lista = Object.keys(clientes);
            console.log("📋 Cliente", socket.id, "solicita lista de clientes");
            console.log("📋 Lista enviada:", lista);
            
            if (typeof callback === "function") {
                callback(lista);
            } else {
                socket.emit("clientes-conectados", lista);
            }
        });

        // ============================================
        // 2. NOTIFICAR A TODOS QUE LLEGÓ UN NUEVO CLIENTE
        // ============================================
        socket.broadcast.emit("nuevo-cliente", {
            id: socket.id,
            total: Object.keys(clientes).length
        });

        // También enviar lista actualizada a TODOS
        io.emit("clientes-conectados", Object.keys(clientes));

        // ============================================
        // 3. MENSAJE DE BIENVENIDA
        // ============================================
        socket.emit("mensaje", {
            texto: "✅ Conectado correctamente al servidor",
            timestamp: new Date().toISOString()
        });

        // ============================================
        // 4. REENVIAR OFERTA WEBRTC
        // ============================================
        socket.on("offer", (data) => {
            console.log("📩 Oferta de", socket.id, "para", data.target);
            
            // Verificar que el target existe
            if (clientes[data.target]) {
                io.to(data.target).emit("offer", {
                    from: socket.id,
                    offer: data.offer
                });
                console.log("✅ Oferta reenviada a:", data.target);
            } else {
                console.log("❌ Target no encontrado:", data.target);
            }
        });

        // ============================================
        // 5. REENVIAR RESPUESTA WEBRTC
        // ============================================
        socket.on("answer", (data) => {
            console.log("📩 Respuesta de", socket.id, "para", data.target);
            
            if (clientes[data.target]) {
                io.to(data.target).emit("answer", {
                    from: socket.id,
                    answer: data.answer
                });
                console.log("✅ Respuesta reenviada a:", data.target);
            } else {
                console.log("❌ Target no encontrado:", data.target);
            }
        });

        // ============================================
        // 6. REENVIAR ICE CANDIDATES
        // ============================================
        socket.on("ice-candidate", (data) => {
            console.log("🧊 ICE candidate de", socket.id, "para", data.target);
            
            if (clientes[data.target]) {
                io.to(data.target).emit("ice-candidate", {
                    from: socket.id,
                    candidate: data.candidate
                });
                console.log("✅ ICE candidate reenviado a:", data.target);
            } else {
                console.log("❌ Target no encontrado:", data.target);
            }
        });

        // ============================================
        // 7. MANEJAR DESCONEXIÓN
        // ============================================
        socket.on("disconnect", () => {
            // Eliminar cliente
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

    });

    // ============================================
    // 8. LOG DE INICIO DEL SERVIDOR
    // ============================================
    console.log("✅ Servidor de señalización WebRTC iniciado");
    console.log("📡 Esperando conexiones de clientes...");
};

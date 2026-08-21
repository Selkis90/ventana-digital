module.exports = (io) => {
    const clientes = new Map();

    io.on('connection', (socket) => {
        console.log(`✅ Cliente conectado: ${socket.id}`);
        
        clientes.set(socket.id, {
            id: socket.id,
            connectedAt: new Date().toISOString(),
            ip: socket.handshake.address
        });

        // Enviar lista de clientes actual al nuevo cliente
        const listaClientes = Array.from(clientes.keys());
        socket.emit('clientes-conectados', listaClientes);
        console.log(`📋 Enviando lista de ${listaClientes.length} clientes a ${socket.id}`);

        // Notificar a los demás que hay un nuevo cliente
        socket.broadcast.emit('nuevo-cliente', { 
            id: socket.id,
            timestamp: new Date().toISOString()
        });

        // ============================================
        // 🔥 EVENTOS WEBRTC
        // ============================================
        
        // Oferta: un cliente envía una oferta a otro
        socket.on('offer', (data) => {
            console.log(`📤 Oferta de ${socket.id} para ${data.target}`);
            if (clientes.has(data.target)) {
                io.to(data.target).emit('offer', {
                    from: socket.id,
                    offer: data.offer,
                    timestamp: new Date().toISOString()
                });
                console.log(`✅ Oferta reenviada a ${data.target}`);
            } else {
                console.warn(`⚠️ Cliente ${data.target} no encontrado`);
            }
        });

        // Respuesta: un cliente responde a una oferta
        socket.on('answer', (data) => {
            console.log(`📤 Respuesta de ${socket.id} para ${data.target}`);
            if (clientes.has(data.target)) {
                io.to(data.target).emit('answer', {
                    from: socket.id,
                    answer: data.answer,
                    timestamp: new Date().toISOString()
                });
                console.log(`✅ Respuesta reenviada a ${data.target}`);
            } else {
                console.warn(`⚠️ Cliente ${data.target} no encontrado`);
            }
        });

        // ICE Candidate: intercambio de candidatos
        socket.on('ice-candidate', (data) => {
            console.log(`🧊 ICE candidate de ${socket.id} para ${data.target}`);
            if (clientes.has(data.target)) {
                io.to(data.target).emit('ice-candidate', {
                    from: socket.id,
                    candidate: data.candidate,
                    timestamp: new Date().toISOString()
                });
                console.log(`✅ ICE candidate reenviado a ${data.target}`);
            } else {
                console.warn(`⚠️ Cliente ${data.target} no encontrado`);
            }
        });

        // Solicitar lista actualizada de clientes
        socket.on('clientes-conectados', () => {
            const lista = Array.from(clientes.keys());
            socket.emit('clientes-conectados', lista);
            console.log(`📋 Reenviando lista de ${lista.length} clientes a ${socket.id}`);
        });

        // Desconexión
        socket.on('disconnect', () => {
            console.log(`❌ Cliente desconectado: ${socket.id}`);
            clientes.delete(socket.id);
            
            // Notificar a los demás que un cliente se fue
            io.emit('cliente-desconectado', { 
                id: socket.id,
                timestamp: new Date().toISOString()
            });
            
            // Enviar lista actualizada a todos
            const lista = Array.from(clientes.keys());
            io.emit('clientes-conectados', lista);
            console.log(`📋 Lista actualizada: ${lista.length} clientes`);
        });
    });

    console.log('📡 Socket.IO configurado correctamente');
    return { clientes };
};

module.exports = (io) => {
    const clientes = new Map();

    io.on('connection', (socket) => {
        console.log(`✅ Cliente conectado: ${socket.id}`);
        console.log(`📊 Total clientes: ${io.sockets.sockets.size}`);
        
        // 🔥 LIMPIAR conexiones duplicadas del mismo IP
        const clientIP = socket.handshake.address;
        const existingClients = Array.from(clientes.keys());
        
        existingClients.forEach(id => {
            const client = clientes.get(id);
            if (client && client.ip === clientIP && id !== socket.id) {
                console.log(`🧹 Eliminando conexión duplicada de IP ${clientIP}: ${id}`);
                io.to(id).emit('cliente-desconectado', { id: id, reason: 'duplicate' });
                io.sockets.sockets.get(id)?.disconnect(true);
                clientes.delete(id);
            }
        });
        
        clientes.set(socket.id, {
            id: socket.id,
            connectedAt: new Date().toISOString(),
            ip: socket.handshake.address
        });

        // Enviar lista actualizada
        const listaClientes = Array.from(clientes.keys());
        socket.emit('clientes-conectados', listaClientes);
        console.log(`📋 Enviando lista de ${listaClientes.length} clientes a ${socket.id}`);
        
        // Notificar a los demás
        socket.broadcast.emit('nuevo-cliente', { 
            id: socket.id,
            timestamp: new Date().toISOString()
        });

        // ============================================
        // 🔥 EVENTOS WEBRTC
        // ============================================
        
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
                socket.emit('cliente-desconectado', { 
                    id: data.target,
                    reason: 'target_not_found'
                });
            }
        });

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

        socket.on('clientes-conectados', () => {
            // 🔥 LIMPIAR CLIENTES INACTIVOS
            const sockets = io.sockets.sockets;
            clientes.forEach((client, id) => {
                if (!sockets.has(id)) {
                    console.log(`🧹 Eliminando cliente inactivo: ${id}`);
                    clientes.delete(id);
                }
            });
            
            const lista = Array.from(clientes.keys());
            socket.emit('clientes-conectados', lista);
            console.log(`📋 Reenviando lista de ${lista.length} clientes a ${socket.id}`);
        });

        socket.on('ping', () => {
            socket.emit('pong');
        });

        socket.on('disconnect', () => {
            console.log(`❌ Cliente desconectado: ${socket.id}`);
            clientes.delete(socket.id);
            
            // Notificar a los demás
            io.emit('cliente-desconectado', { 
                id: socket.id,
                timestamp: new Date().toISOString()
            });
            
            // Enviar lista actualizada
            const lista = Array.from(clientes.keys());
            io.emit('clientes-conectados', lista);
            console.log(`📋 Lista actualizada: ${lista.length} clientes`);
        });
    });

    console.log('📡 Socket.IO configurado correctamente');
    return { clientes };
};

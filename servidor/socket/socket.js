// ============================================
// SOCKET.IO - MANEJADORES DE EVENTOS
// ============================================

module.exports = (io) => {
    // Estado de clientes conectados
    const clientes = new Map();

    io.on('connection', (socket) => {
        console.log(`✅ Cliente conectado: ${socket.id}`);
        
        // Guardar información del cliente
        clientes.set(socket.id, {
            id: socket.id,
            connectedAt: new Date().toISOString(),
            ip: socket.handshake.address
        });

        // ============================================
        // 📋 LISTA DE CLIENTES
        // ============================================
        
        // Enviar lista actualizada al cliente que se conectó
        const listaClientes = Array.from(clientes.keys());
        socket.emit('clientes-conectados', listaClientes);
        console.log(`📋 Enviando lista de ${listaClientes.length} clientes a ${socket.id}`);

        // Notificar a todos los demás sobre el nuevo cliente
        socket.broadcast.emit('nuevo-cliente', { 
            id: socket.id,
            timestamp: new Date().toISOString()
        });

        // ============================================
        // 🔗 WEBRTC SIGNALING
        // ============================================

        // 📤 Oferta
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
                console.warn(`⚠️ Target ${data.target} no conectado`);
            }
        });

        // 📤 Respuesta
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
                console.warn(`⚠️ Target ${data.target} no conectado`);
            }
        });

        // 🧊 ICE Candidate
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
                console.warn(`⚠️ Target ${data.target} no conectado`);
            }
        });

        // 📋 Solicitar lista de clientes
        socket.on('clientes-conectados', () => {
            const lista = Array.from(clientes.keys());
            console.log(`📋 Enviando lista de ${lista.length} clientes a ${socket.id}`);
            socket.emit('clientes-conectados', lista);
        });

        // 🏓 Ping/Pong
        socket.on('ping', (data) => {
            socket.emit('pong', {
                from: socket.id,
                message: 'pong',
                timestamp: new Date().toISOString()
            });
        });

        // ============================================
        // ❌ DESCONEXIÓN
        // ============================================
        
        socket.on('disconnect', () => {
            console.log(`❌ Cliente desconectado: ${socket.id}`);
            clientes.delete(socket.id);

            // Notificar a todos sobre la desconexión
            io.emit('cliente-desconectado', { 
                id: socket.id,
                timestamp: new Date().toISOString()
            });

            // Enviar lista actualizada
            const lista = Array.from(clientes.keys());
            io.emit('clientes-conectados', lista);
            console.log(`📋 Lista actualizada: ${lista.length} clientes`);
        });

        // ============================================
        // 📊 ESTADÍSTICAS
        // ============================================
        
        // Enviar estado de conexiones
        socket.on('get-stats', () => {
            socket.emit('stats', {
                totalClients: clientes.size,
                clients: Array.from(clientes.keys()),
                timestamp: new Date().toISOString()
            });
        });
    });

    // ============================================
    // 🔄 EVENTOS GLOBALES
    // ============================================
    
    console.log('📡 Socket.IO configurado correctamente');

    // Retornar el mapa de clientes para uso externo
    return { clientes };
};

module.exports = (io) => {
    const clientes = new Map();

    io.on('connection', (socket) => {
        console.log(`✅ Cliente conectado: ${socket.id}`);
        console.log(`📊 Total sockets en servidor: ${io.sockets.sockets.size}`);
        
        // Guardar cliente
        clientes.set(socket.id, {
            id: socket.id,
            connectedAt: new Date().toISOString(),
            ip: socket.handshake.address
        });

        // 🔥 ENVIAR LISTA COMPLETA A TODOS LOS CLIENTES
        const listaClientes = Array.from(clientes.keys());
        console.log(`📋 Enviando lista de ${listaClientes.length} clientes a TODOS`);
        
        // Enviar a TODOS los clientes conectados
        io.emit('clientes-conectados', listaClientes);
        
        // Notificar a los demás que hay un nuevo cliente
        socket.broadcast.emit('nuevo-cliente', { 
            id: socket.id,
            timestamp: new Date().toISOString()
        });

        // ============================================
        // 🔥 EVENTOS WEBRTC
        // ============================================
        
        socket.on('offer', (data) => {
            console.log(`📤 Oferta de ${socket.id} para ${data.target}`);
            console.log(`📊 Clientes disponibles: ${Array.from(clientes.keys()).join(', ')}`);
            
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
            // Limpiar clientes inactivos
            const sockets = io.sockets.sockets;
            const toDelete = [];
            
            clientes.forEach((client, id) => {
                if (!sockets.has(id)) {
                    toDelete.push(id);
                }
            });
            
            toDelete.forEach(id => {
                console.log(`🧹 Eliminando cliente inactivo: ${id}`);
                clientes.delete(id);
            });
            
            // 🔥 ENVIAR LISTA A TODOS LOS CLIENTES
            const lista = Array.from(clientes.keys());
            console.log(`📋 Enviando lista de ${lista.length} clientes a TODOS`);
            io.emit('clientes-conectados', lista);
        });

        socket.on('ping', () => {
            socket.emit('pong');
        });

        socket.on('disconnect', () => {
            console.log(`❌ Cliente desconectado: ${socket.id}`);
            clientes.delete(socket.id);
            
            // 🔥 ENVIAR LISTA ACTUALIZADA A TODOS
            const lista = Array.from(clientes.keys());
            console.log(`📋 Lista actualizada: ${lista.length} clientes`);
            
            io.emit('cliente-desconectado', { 
                id: socket.id,
                timestamp: new Date().toISOString()
            });
            
            io.emit('clientes-conectados', lista);
        });
    });

    console.log('📡 Socket.IO configurado correctamente');
    return { clientes };
};

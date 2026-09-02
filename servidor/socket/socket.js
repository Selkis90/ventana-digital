module.exports = (io) => {
    const clientes = new Map();

    io.on('connection', (socket) => {
        console.log(`✅ Cliente conectado: ${socket.id}`);
        console.log(`📊 Total sockets en servidor: ${io.sockets.sockets.size}`);
        
        clientes.set(socket.id, {
            id: socket.id,
            connectedAt: new Date().toISOString(),
            ip: socket.handshake.address
        });

        const listaClientes = Array.from(clientes.keys());

        // 🔥 LO MÁS IMPORTANTE: Decirle a cada cliente quién es el ORQUESTADOR (El primero)
        const orquestadorId = listaClientes[0];
        io.emit('actualizar-orquestador', { orquestadorId: orquestadorId });
        io.emit('clientes-conectados', listaClientes);
        
        socket.broadcast.emit('nuevo-cliente', { 
            id: socket.id,
            timestamp: new Date().toISOString()
        });

        socket.on('offer', (data) => {
            if (clientes.has(data.target)) {
                io.to(data.target).emit('offer', { from: socket.id, offer: data.offer });
            }
        });

        socket.on('answer', (data) => {
            if (clientes.has(data.target)) {
                io.to(data.target).emit('answer', { from: socket.id, answer: data.answer });
            }
        });

        socket.on('ice-candidate', (data) => {
            if (clientes.has(data.target)) {
                io.to(data.target).emit('ice-candidate', { from: socket.id, candidate: data.candidate });
            }
        });

        socket.on('clientes-conectados', () => {
            const sockets = io.sockets.sockets;
            const toDelete = [];
            
            clientes.forEach((client, id) => {
                if (!sockets.has(id)) toDelete.push(id);
            });
            
            toDelete.forEach(id => clientes.delete(id));
            
            const lista = Array.from(clientes.keys());
            // Actualizar orquestador si el primero se fue
            const nuevoOrquestador = lista[0];
            io.emit('actualizar-orquestador', { orquestadorId: nuevoOrquestador });
            io.emit('clientes-conectados', lista);
        });

        socket.on('ping', () => {
            socket.emit('pong');
        });

        socket.on('disconnect', () => {
            clientes.delete(socket.id);
            const lista = Array.from(clientes.keys());
            
            // 🔥 Si el orquestador se fue, el siguiente toma su lugar
            const nuevoOrquestador = lista[0];
            io.emit('actualizar-orquestador', { orquestadorId: nuevoOrquestador });
            io.emit('cliente-desconectado', { id: socket.id });
            io.emit('clientes-conectados', lista);
        });
    });

    console.log('📡 Socket.IO configurado correctamente');
    return { clientes };
};

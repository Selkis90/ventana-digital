module.exports = function(io) {

    console.log("############################################");
    console.log("### SOCKET.JS VERSION 4 - SIGNALING ###");
    console.log("############################################");

    const clientes = [];

    io.on("connection", (socket) => {

        clientes.push(socket.id);

        console.log("=================================");
        console.log("Nuevo cliente conectado");
        console.log("ID:", socket.id);
        console.log("Clientes conectados:", clientes.length);
        console.log("Lista:", clientes);
        console.log("=================================");

        socket.emit("mensaje", {
            texto: "Conectado correctamente al servidor"
        });

        // Avisar a todos que llegó un nuevo cliente
        io.emit("nuevo-cliente", {
            id: socket.id,
            total: clientes.length
        });

        // Enviar la lista de clientes cuando la pidan
        socket.on("clientes-conectados", (callback) => {
            if (typeof callback === "function") {
                callback(clientes);
            }
        });

        // Reenviar OFFER
        socket.on("offer", (data) => {

            io.to(data.target).emit("offer", {
                from: socket.id,
                offer: data.offer
            });

        });

        // Reenviar ANSWER
        socket.on("answer", (data) => {

            io.to(data.target).emit("answer", {
                from: socket.id,
                answer: data.answer
            });

        });

        // Reenviar ICE
        socket.on("ice-candidate", (data) => {

            io.to(data.target).emit("ice-candidate", {
                from: socket.id,
                candidate: data.candidate
            });

        });

        socket.on("disconnect", () => {

            const indice = clientes.indexOf(socket.id);

            if (indice !== -1) {
                clientes.splice(indice, 1);
            }

            console.log("=================================");
            console.log("Cliente desconectado:", socket.id);
            console.log("Clientes conectados:", clientes.length);
            console.log("Lista:", clientes);
            console.log("=================================");

            io.emit("cliente-desconectado", {
                id: socket.id,
                total: clientes.length
            });

        });

    });

};

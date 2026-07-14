module.exports = function(io){

    console.log("############################################");
    console.log("### SOCKET.JS VERSION 3 - EMPAREJAMIENTO ###");
    console.log("############################################");

    const clientes = [];

    io.on("connection", (socket)=>{

        clientes.push(socket.id);

        console.log("=================================");
        console.log("Nuevo cliente conectado");
        console.log("ID:", socket.id);
        console.log("Clientes conectados:", clientes.length);
        console.log("Lista:", clientes);
        console.log("=================================");

        socket.emit("mensaje",{
            texto:"Conectado correctamente al servidor"
        });

        // Si hay exactamente 2 clientes, avisarles
        if(clientes.length === 2){

            console.log("***************");
            console.log("EQUIPO ENCONTRADO");
            console.log("***************");

            io.emit("equipo-encontrado");
        }

        socket.on("disconnect",()=>{

            const indice = clientes.indexOf(socket.id);

            if(indice !== -1){
                clientes.splice(indice,1);
            }

            console.log("=================================");
            console.log("Cliente desconectado:",socket.id);
            console.log("Clientes conectados:",clientes.length);
            console.log("Lista:",clientes);
            console.log("=================================");

        });

    });

};

module.exports = function(io){

    io.on("connection", (socket)=>{

        console.log("=================================");
        console.log("Nuevo cliente conectado");
        console.log("ID:", socket.id);
        console.log("=================================");

        socket.emit("mensaje",{
            texto:"Conectado correctamente al servidor"
        });

        socket.on("disconnect",()=>{

            console.log("Cliente desconectado:",socket.id);

        });

    });

};

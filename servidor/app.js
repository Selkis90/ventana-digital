const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;


// Servir el cliente de Socket.IO
app.use("/socket.io", express.static(
    path.join(__dirname, "node_modules/socket.io/client-dist")
));


// Servir los archivos del cliente
app.use(express.static(path.join(__dirname, "../cliente")));

// Cargar la configuración de Socket.IO
require("./socket/socket")(io);

// Iniciar el servidor
server.listen(PORT, () => {
    console.log(`Servidor iniciado en: http://localhost:${PORT}`);
});

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;  // ← CAMBIADO

// Servir el cliente de Socket.IO
app.use("/socket.io", express.static(
    path.join(__dirname, "node_modules/socket.io/client-dist")
));

// Servir los archivos del cliente
app.use(express.static(path.join(__dirname, "../cliente")));

// Ruta de health check para Render  // ← NUEVO
app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Cargar la configuración de Socket.IO
require("./socket/socket")(io);

// Iniciar el servidor
server.listen(PORT, "0.0.0.0", () => {  // ← CAMBIADO
    console.log(`Servidor iniciado en: http://0.0.0.0:${PORT}`);
});

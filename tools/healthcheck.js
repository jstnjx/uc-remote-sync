import net from "node:net";
const port = Number(process.env.UC_INTEGRATION_HTTP_PORT || 11082);
const socket = net.createConnection({ host: "127.0.0.1", port });
const timer = setTimeout(() => { socket.destroy(); process.exit(1); }, 3000);
socket.once("connect", () => { clearTimeout(timer); socket.end(); process.exit(0); });
socket.once("error", () => { clearTimeout(timer); process.exit(1); });

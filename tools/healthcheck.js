import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

// -----------------------------------------------------------------------------
// Container health check
// -----------------------------------------------------------------------------

const agentPort = Number(process.env.REMOTE_SYNC_AGENT_PORT || 11081);
const integrationPort = Number(process.env.UC_INTEGRATION_HTTP_PORT || 11082);

function requestHealth() {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port: agentPort, path: "/healthz", timeout: 2500 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          resolve(response.statusCode === 200 && body.status === "ok");
        } catch {
          resolve(false);
        }
      });
    });
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", () => resolve(false));
  });
}

function integrationAvailable() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: integrationPort });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2500);
    socket.once("connect", () => { clearTimeout(timer); socket.end(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

const configured = fs.existsSync(path.join(process.env.UC_CONFIG_HOME || "config", "remote-sync.json"));
if (await requestHealth()) process.exit(0);
if (!configured && await integrationAvailable()) process.exit(0);
process.exit(1);

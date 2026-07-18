import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";

// -----------------------------------------------------------------------------
// Protocol constants
// -----------------------------------------------------------------------------

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

// -----------------------------------------------------------------------------
// Frame encoding
// -----------------------------------------------------------------------------

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function frame(opcode, payload = Buffer.alloc(0), mask = false) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  const length = payload.length;
  let headerLength = 2;
  if (length >= 126 && length <= 0xffff) headerLength += 2;
  else if (length > 0xffff) headerLength += 8;
  if (mask) headerLength += 4;
  const output = Buffer.allocUnsafe(headerLength + length);
  let offset = 0;
  output[offset++] = 0x80 | opcode;
  if (length < 126) output[offset++] = (mask ? 0x80 : 0) | length;
  else if (length <= 0xffff) {
    output[offset++] = (mask ? 0x80 : 0) | 126;
    output.writeUInt16BE(length, offset); offset += 2;
  } else {
    output[offset++] = (mask ? 0x80 : 0) | 127;
    output.writeBigUInt64BE(BigInt(length), offset); offset += 8;
  }
  let maskKey;
  if (mask) {
    maskKey = crypto.randomBytes(4);
    maskKey.copy(output, offset); offset += 4;
  }
  if (!mask) payload.copy(output, offset);
  else for (let i = 0; i < length; i += 1) output[offset + i] = payload[i] ^ maskKey[i % 4];
  return output;
}

// -----------------------------------------------------------------------------
// WebSocket peer
// -----------------------------------------------------------------------------

export class WebSocketPeer extends EventEmitter {
  static OPEN = OPEN;
  static CLOSED = CLOSED;

  constructor(socket, { maskOutgoing = false, initialData = Buffer.alloc(0), maxPayload = 16 * 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.maskOutgoing = maskOutgoing;
    this.maxPayload = maxPayload;
    this.readyState = OPEN;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.remoteAddress = socket.remoteAddress;
    socket.on("data", (chunk) => this.#data(chunk));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", () => { this.readyState = CLOSED; this.emit("close"); });
    socket.on("end", () => { if (this.readyState !== CLOSED) socket.destroy(); });
    if (initialData.length) setImmediate(() => this.#data(initialData));
  }

  send(data, callback = undefined) {
    if (this.readyState !== OPEN) {
      const error = new Error("WebSocket is not open");
      callback?.(error);
      if (!callback) throw error;
      return;
    }
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    this.socket.write(frame(0x1, payload, this.maskOutgoing), callback);
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.readyState === OPEN) this.socket.write(frame(0x9, payload, this.maskOutgoing));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    const reasonBytes = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0); reasonBytes.copy(payload, 2);
    this.socket.write(frame(0x8, payload, this.maskOutgoing), () => this.socket.end());
    setTimeout(() => this.socket.destroy(), 2000).unref?.();
  }

  terminate() { this.socket.destroy(); }

  #protocolError(message) {
    this.emit("error", new Error(message));
    this.close(1002, "Protocol error");
  }

  #data(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (rsv) return this.#protocolError("Unsupported WebSocket extensions");
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset); offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset); offset += 8;
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this.#protocolError("WebSocket frame too large");
        length = Number(big);
      }
      if (length > this.maxPayload) return this.#protocolError("WebSocket payload exceeds limit");
      let maskKey;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4); offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      if (opcode >= 0x8 && (!fin || length > 125)) return this.#protocolError("Invalid control frame");
      if (opcode === 0x8) {
        if (this.readyState === OPEN) this.socket.write(frame(0x8, payload, this.maskOutgoing));
        this.readyState = CLOSING;
        this.socket.end();
        continue;
      }
      if (opcode === 0x9) { this.socket.write(frame(0xA, payload, this.maskOutgoing)); continue; }
      if (opcode === 0xA) { this.emit("pong", payload); continue; }
      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) return this.#protocolError("Unexpected continuation frame");
        this.fragments.push(payload);
        if (fin) {
          const complete = Buffer.concat(this.fragments);
          const originalOpcode = this.fragmentOpcode;
          this.fragments = []; this.fragmentOpcode = null;
          if (originalOpcode === 0x1) this.emit("message", complete);
        }
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x2) return this.#protocolError(`Unsupported opcode ${opcode}`);
      if (!fin) { this.fragmentOpcode = opcode; this.fragments = [payload]; continue; }
      this.emit("message", payload);
    }
  }
}

// -----------------------------------------------------------------------------
// Server upgrades
// -----------------------------------------------------------------------------

export function rejectWebSocketUpgrade(socket, status = 400, reason = "Bad Request") {
  if (!socket || socket.destroyed) return;
  const body = `${reason}\n`;
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body
  ].join("\r\n"));
}

export function acceptWebSocketUpgrade(request, socket, head = Buffer.alloc(0)) {
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  if (!key || version !== "13" || String(request.headers.upgrade || "").toLowerCase() !== "websocket") {
    rejectWebSocketUpgrade(socket, 400, "Bad Request");
    return null;
  }
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(String(key))}`,
    "\r\n"
  ].join("\r\n"));
  return new WebSocketPeer(socket, { maskOutgoing: false, initialData: head });
}

export function createWebSocketHttpServer({ host = "0.0.0.0", port, onConnection }) {
  const server = http.createServer((request, response) => {
    response.writeHead(426, { "Content-Type": "text/plain", Upgrade: "websocket" });
    response.end("WebSocket endpoint\n");
  });
  server.on("upgrade", (request, socket, head) => {
    const peer = acceptWebSocketUpgrade(request, socket, head);
    if (peer) onConnection(peer, request);
  });
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        const error = (err) => { server.off("listening", listening); reject(err); };
        const listening = () => { server.off("error", error); resolve(); };
        server.once("error", error); server.once("listening", listening); server.listen(port, host);
      });
    },
    async close() { await new Promise((resolve) => server.close(resolve)); }
  };
}

// -----------------------------------------------------------------------------
// Client connection
// -----------------------------------------------------------------------------

export async function connectWebSocket(urlValue, { headers = {}, timeoutMs = 9000, rejectUnauthorized = true } = {}) {
  const url = new URL(urlValue);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error(`Unsupported WebSocket scheme ${url.protocol}`);
  const secure = url.protocol === "wss:";
  const port = Number(url.port || (secure ? 443 : 80));
  const key = crypto.randomBytes(16).toString("base64");
  const requestPath = `${url.pathname || "/"}${url.search}`;
  const lines = [
    `GET ${requestPath} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13"
  ];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  lines.push("\r\n");
  const socket = secure
    ? tls.connect({ host: url.hostname, port, servername: url.hostname, rejectUnauthorized })
    : net.connect({ host: url.hostname, port });
  return new Promise((resolve, reject) => {
    let settled = false;
    let incoming = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error("WebSocket connection timed out")), timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); reject(error);
    };
    socket.once("error", fail);
    socket.once(secure ? "secureConnect" : "connect", () => socket.write(lines.join("\r\n")));
    const onData = (chunk) => {
      incoming = Buffer.concat([incoming, chunk]);
      const marker = incoming.indexOf("\r\n\r\n");
      if (marker < 0) return;
      socket.off("data", onData);
      const headerText = incoming.subarray(0, marker).toString("latin1");
      const rest = incoming.subarray(marker + 4);
      const headerLines = headerText.split("\r\n");
      const status = Number(headerLines[0].split(" ")[1]);
      const responseHeaders = {};
      for (const line of headerLines.slice(1)) {
        const index = line.indexOf(":");
        if (index > 0) responseHeaders[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      if (status !== 101) return fail(new Error(`WebSocket upgrade failed with status ${status}`));
      if (responseHeaders["sec-websocket-accept"] !== acceptKey(key)) return fail(new Error("Invalid WebSocket accept key"));
      settled = true; clearTimeout(timer); socket.off("error", fail);
      const peer = new WebSocketPeer(socket, { maskOutgoing: true, initialData: rest });
      resolve(peer);
    };
    socket.on("data", onData);
  });
}

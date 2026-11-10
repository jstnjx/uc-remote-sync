import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recentLogs } from "../shared/logger.js";
import { logger } from "../shared/logger.js";
import { dashboardPage } from "./page.js";

const log = logger("web");
const REMOTE_UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "remote-ui");
// Remote UI preview runtime. Only these files are served.
const REMOTE_UI_FILES = Object.freeze({
  "remote-ui-web.js": "text/javascript; charset=utf-8",
  "remote-ui-web.css": "text/css; charset=utf-8",
  "background.svg": "image/svg+xml"
});
const RESOURCE_TYPES = new Set(["Icon", "Image", "BackgroundImage", "Background", "Sound"]);
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

// -----------------------------------------------------------------------------
// Web dashboard
//
// Served by the agent server on port 11081 at /ui, on the Remote itself as well as in Docker / Node.js deployments.
// Sign-in uses the Web Configurator PIN of the remote this instance manages (checked with the Core's own login),
// sessions are random tokens in an HttpOnly, SameSite=Strict cookie, and every state-changing request must carry the
// X-Remote-Sync-UI header so a cross-site form cannot trigger it.
// -----------------------------------------------------------------------------

const SESSION_COOKIE = "remote_sync_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const SATELLITE_ACTIONS = new Set(["sync", "preview", "enable", "disable", "rediscover", "rotate", "unpair", "remove", "update"]);

function send(response, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  response.writeHead(status, {
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers
  });
  response.end(payload);
}

function json(response, status, value, headers = {}) {
  send(response, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8", ...headers });
}

async function readJsonBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 }); }
}

function cookies(request) {
  const result = {};
  for (const part of String(request.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

export function createUiHandler(service, { now = () => Date.now() } = {}) {
  const sessions = new Map();
  const failures = new Map();

  const sessionFor = (request) => {
    const token = cookies(request)[SESSION_COOKIE];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session || session.expiresAt < now()) { sessions.delete(token); return null; }
    return { token, ...session };
  };

  const limited = (address) => {
    const entry = failures.get(address);
    return Boolean(entry && entry.resetAt > now() && entry.count >= MAX_LOGIN_FAILURES);
  };

  const fail = (address) => {
    const entry = failures.get(address);
    if (!entry || entry.resetAt < now()) failures.set(address, { count: 1, resetAt: now() + LOGIN_WINDOW_MS });
    else entry.count += 1;
  };

  const SYNC_KEYS = ["sections", "interval_seconds", "auto_sync", "prune", "use_standby_inhibitor", "verify_existing_resource_hashes", "auto_update_satellites", "settings_categories"];
  const GENERAL_KEYS = ["node_name", "agent_public_url", "dock_tokens", "clear_dock_tokens", "mac_override", "broadcast_overrides"];
  const pick = (body, keys) => Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));

  async function api(request, response, url) {
    const method = request.method;
    const path = url.pathname.replace(/^\/ui\/api/, "");
    const role = service.config?.role;

    // Available for every role
    if (method === "GET" && path === "/status") {
      const payload = { ...service.statusPayload(), wake_on_wlan: await service.wakeOnWlanState(), setup_finished: await service.setupFinished?.() ?? null, provisioning: service.provisioningStatus() };
      // Fallback token for Primaries on 0.8.x, shown on an unpaired Satellite's dashboard (signed-in sessions only).
      if (role === "child" && !service.config.pairing?.paired_master_id) payload.pairing_token = service.config.agent_token;
      json(response, 200, payload);
      return;
    }
    if (method === "GET" && path === "/logs") {
      json(response, 200, { lines: recentLogs({ after: Number(url.searchParams.get("after") || 0) }) });
      return;
    }
    if (method === "POST" && path === "/wake-on-wlan") {
      json(response, 200, await service.enableWakeOnWlan());
      return;
    }
    if (method === "GET" && path === "/settings") {
      json(response, 200, service.generalSettings());
      return;
    }
    if (method === "PUT" && path === "/settings") {
      const body = await readJsonBody(request);
      const general = pick(body, GENERAL_KEYS);
      const sync = pick(body, SYNC_KEYS);
      if (Object.keys(sync).length && role !== "master") { json(response, 409, { error: "Synchronization settings exist only on a Primary" }); return; }
      // Synchronization settings first: both calls save, and the general update re-reads the saved config.
      if (Object.keys(sync).length) await service.updateSyncSettings(sync);
      const result = Object.keys(general).length ? await service.updateGeneralSettings(general) : { success: true };
      json(response, 200, { ...result, settings: service.generalSettings() });
      return;
    }
    if (method === "POST" && path === "/role") {
      const body = await readJsonBody(request);
      log.info(`Dashboard role selection: ${body.role}`);
      json(response, 200, await service.assignRole(String(body.role || ""), { name: body.name || null }));
      return;
    }
    if (method === "POST" && path === "/role/reset") {
      json(response, 200, await service.resetRole());
      return;
    }

    if (role !== "master") {
      json(response, 409, { error: role === "unassigned" ? "Choose a role first." : "This page is read-only on a Satellite. Manage synchronization on the Primary." });
      return;
    }
    if (method === "GET" && path === "/satellites") {
      json(response, 200, { satellites: await service.listSatellites(url.searchParams.get("refresh") === "true") });
      return;
    }
    if (method === "GET" && path === "/discover") {
      json(response, 200, { satellites: await service.discoverSatellites() });
      return;
    }
    if (method === "POST" && path === "/satellites") {
      const body = await readJsonBody(request);
      const result = await service.addSatelliteByPin({
        address: body.address,
        pin: body.pin,
        name: body.name || null,
        install: body.install !== false,
        httpPort: body.http_port || null,
        agentPort: body.agent_port || null
      });
      json(response, result.success ? 200 : 422, result);
      return;
    }
    if (method === "POST" && path === "/satellites/token") {
      const body = await readJsonBody(request);
      const result = await service.addSatelliteByToken({ address: body.address, port: body.port || null, token: body.token, name: body.name || null });
      json(response, result.success ? 200 : 422, result);
      return;
    }
    const action = path.match(/^\/satellites\/([^/]+)\/actions\/([^/]+)$/);
    if (method === "POST" && action) {
      const peerId = decodeURIComponent(action[1]);
      const name = decodeURIComponent(action[2]);
      if (!SATELLITE_ACTIONS.has(name)) { json(response, 400, { error: `Unsupported action ${name}` }); return; }
      log.info(`Dashboard action ${name} for ${peerId}`);
      json(response, 200, await service.manageSatellite(peerId, name));
      return;
    }
    if (method === "POST" && path === "/sync") {
      const body = await readJsonBody(request);
      json(response, 200, await service.syncNow(true, { dryRun: body.dry_run === true, peerId: body.peer_id || null, reason: body.dry_run ? "dashboard preview" : "dashboard" }));
      return;
    }
    if (method === "GET" && path === "/simulator") {
      json(response, 200, service.simulatorModel());
      return;
    }
    const resource = path.match(/^\/resource\/([^/]+)\/([^/]+)$/);
    if (method === "GET" && resource) {
      const type = decodeURIComponent(resource[1]);
      const id = decodeURIComponent(resource[2]);
      if (!RESOURCE_TYPES.has(type)) { json(response, 400, { error: "Unsupported resource type" }); return; }
      try {
        const payload = await service.primaryResource(type, id);
        const extension = String(id).split(".").pop().toLowerCase();
        send(response, 200, payload, { "Content-Type": IMAGE_TYPES[extension] || "application/octet-stream", "Cache-Control": "private, max-age=300" });
      } catch (error) {
        json(response, 404, { error: error.message });
      }
      return;
    }
    if (method === "GET" && path === "/preview") {
      json(response, 200, service.status.last_preview_details || null);
      return;
    }
    json(response, 404, { error: "Not found" });
  }

  return async function handle(request, response, url) {
    try {
      if (url.pathname === "/") {
        send(response, 302, "", { Location: "/ui" });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/ui/remote-ui/")) {
        const name = url.pathname.slice("/ui/remote-ui/".length);
        const type = REMOTE_UI_FILES[name];
        if (!type) { json(response, 404, { error: "Not found" }); return; }
        try {
          // Versioned URLs (?v=<content hash>) can be cached forever; anything else is revalidated.
          const cache = url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "no-cache";
          send(response, 200, await fs.promises.readFile(path.join(REMOTE_UI_DIR, name)), { "Content-Type": type, "Cache-Control": cache });
        } catch { json(response, 404, { error: "Not found" }); }
        return;
      }
      if (request.method === "GET" && (url.pathname === "/ui" || url.pathname === "/ui/")) {
        send(response, 200, dashboardPage(), {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        });
        return;
      }
      if (!url.pathname.startsWith("/ui/api/")) { json(response, 404, { error: "Not found" }); return; }

      if (request.method !== "GET" && request.headers["x-remote-sync-ui"] !== "1") {
        json(response, 403, { error: "Missing dashboard request header" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/ui/api/session") {
        const session = sessionFor(request);
        json(response, 200, {
          authenticated: Boolean(session),
          configured: Boolean(service.config),
          role: service.config?.role === "master" ? "primary" : service.config?.role === "child" ? "satellite" : service.config ? "unassigned" : null,
          node_name: service.config?.node_name || null
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/ui/api/login") {
        const address = String(request.socket.remoteAddress || "unknown");
        if (limited(address)) { json(response, 429, { error: "Too many failed attempts. Try again in a few minutes." }, { "Retry-After": "300" }); return; }
        const body = await readJsonBody(request);
        let valid = false;
        try { valid = await service.verifyUiPin(String(body.pin || "")); }
        catch (error) { json(response, 502, { error: `The remote could not verify the PIN: ${error.message}` }); return; }
        if (!valid) { fail(address); json(response, 401, { error: "Wrong PIN" }); return; }
        failures.delete(address);
        const token = crypto.randomBytes(32).toString("base64url");
        sessions.set(token, { createdAt: now(), expiresAt: now() + SESSION_TTL_MS, address });
        for (const [key, value] of sessions) if (value.expiresAt < now()) sessions.delete(key);
        json(response, 200, { authenticated: true }, {
          "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`
        });
        return;
      }

      const session = sessionFor(request);
      if (!session) { json(response, 401, { error: "Sign in required" }); return; }

      if (request.method === "POST" && url.pathname === "/ui/api/logout") {
        sessions.delete(session.token);
        json(response, 200, { authenticated: false }, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=0` });
        return;
      }
      if (!service.config) { json(response, 409, { error: "Remote Sync is not configured yet" }); return; }
      await api(request, response, url);
    } catch (error) {
      log.warn("Dashboard request failed:", error.message);
      json(response, error.statusCode || 400, { error: error.message });
    }
  };
}

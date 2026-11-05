import { format } from "node:util";

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

const MAX_BUFFERED_LINES = 500;
const buffer = [];
const subscribers = new Set();
let sequence = 0;

function enabled(namespace) {
  const spec = process.env.DEBUG || "";
  return spec === "*" || spec.split(",").some((part) => {
    const pattern = part.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return pattern && new RegExp(`^${pattern}$`).test(namespace);
  });
}

function remember(entry) {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFERED_LINES) buffer.splice(0, buffer.length - MAX_BUFFERED_LINES);
  for (const subscriber of subscribers) {
    try { subscriber(entry); } catch {}
  }
}

// Recent log lines for the web dashboard (info and above, plus enabled debug namespaces).
export function recentLogs({ after = 0, limit = MAX_BUFFERED_LINES } = {}) {
  return buffer.filter((entry) => entry.seq > after).slice(-limit);
}

export function subscribeLogs(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function logger(name) {
  const namespace = `remote-sync:${name}`;
  const write = (level, args) => {
    if (level === "debug" && !enabled(namespace)) return;
    const method = level === "debug" ? "log" : level === "warn" ? "warn" : level === "error" ? "error" : "log";
    const time = new Date().toISOString();
    console[method](`${time} ${level.toUpperCase()} ${namespace}`, ...args);
    let message;
    try { message = format(...args.map((arg) => (arg instanceof Error ? arg.message : arg))); }
    catch { message = args.map(String).join(" "); }
    remember({ seq: ++sequence, time, level, namespace, message: message.slice(0, 2000) });
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args)
  };
}

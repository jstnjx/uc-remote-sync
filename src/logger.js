function enabled(namespace) {
  const spec = process.env.DEBUG || "";
  return spec === "*" || spec.split(",").some((part) => {
    const pattern = part.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return pattern && new RegExp(`^${pattern}$`).test(namespace);
  });
}

export function logger(name) {
  const namespace = `remote-sync:${name}`;
  const write = (level, args) => {
    if (level === "debug" && !enabled(namespace)) return;
    const method = level === "debug" ? "log" : level === "warn" ? "warn" : level === "error" ? "error" : "log";
    console[method](`${new Date().toISOString()} ${level.toUpperCase()} ${namespace}`, ...args);
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args)
  };
}

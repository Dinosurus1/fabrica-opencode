/**
 * Servidor de la consola: sirve `dist/`, protege `/api/*` con una sesión propia
 * y proxya hacia OpenCode. La contraseña sale de FACTORY_UI_PASSWORD o, como
 * respaldo local, de service.json. No imprime secretos.
 *
 * Fase 0: login, rate limit, cabeceras de seguridad, /healthz y arranque del
 * upstream. Fase 1: PWA y acceso remoto con auth (Tailscale Serve delante).
 * Fase 2: estado del repo de solo lectura para /status y el traspaso.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const port = Number(process.env.FACTORY_UI_PORT ?? 4173);
const host = process.env.FACTORY_UI_HOST ?? "127.0.0.1";
const target = new URL(process.env.OPENCODE_URL ?? "http://127.0.0.1:49374");
const sessionTtlSeconds = Number(process.env.FACTORY_UI_SESSION_TTL ?? 7 * 24 * 3600);
const cookieName = "factory_session";
const allowedHosts = (process.env.FACTORY_UI_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function readPassword() {
  if (process.env.OPENCODE_PASSWORD) return process.env.OPENCODE_PASSWORD;
  try {
    const raw = readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.password === "string" ? parsed.password : undefined;
  } catch {
    return undefined;
  }
}

const openCodePassword = readPassword();
const authorization = openCodePassword
  ? `Basic ${Buffer.from(`opencode:${openCodePassword}`).toString("base64")}`
  : undefined;
const uiPassword = process.env.FACTORY_UI_PASSWORD ?? openCodePassword;
const authRequired = Boolean(uiPassword) || process.env.FACTORY_UI_REQUIRE_AUTH === "1";

if (authRequired && !uiPassword) {
  console.error(
    "FACTORY_UI_REQUIRE_AUTH=1 pero no hay contraseña. Define FACTORY_UI_PASSWORD o service.json.",
  );
  process.exit(1);
}
if (!authRequired && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(
    "La consola no tiene contraseña y FACTORY_UI_HOST no es loopback. Configura FACTORY_UI_PASSWORD.",
  );
  process.exit(1);
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function securityHeaders(extra = {}) {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy":
      "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...extra,
  };
}

function sendJson(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(body);
}

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "text/plain; charset=utf-8",
    ...extra,
  });
  res.end(text);
}

function isTrustedProxy(req) {
  const ip = req.socket.remoteAddress;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function clientIp(req) {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (isTrustedProxy(req)) {
    // El proxy de confianza (Tailscale Serve) añade la IP al final.
    const forwarded = String(req.headers["x-forwarded-for"] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (forwarded.length > 0) return forwarded[forwarded.length - 1];
  }
  return socketIp;
}

function rateLimiter(limit, windowMs) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    if (buckets.size > 5_000) {
      for (const [bucketKey, bucket] of buckets) {
        if (now - bucket.startedAt >= windowMs) buckets.delete(bucketKey);
      }
    }
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      return { ok: true, retryAfter: 0 };
    }
    bucket.count += 1;
    if (bucket.count <= limit) return { ok: true, retryAfter: 0 };
    return { ok: false, retryAfter: Math.ceil((bucket.startedAt + windowMs - now) / 1000) };
  };
}

const loginLimit = rateLimiter(10, 5 * 60_000);
const mutateLimit = rateLimiter(120, 60_000);
const startLimit = rateLimiter(3, 60_000);

function parseCookies(header) {
  const result = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    try {
      result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Cookie malformada: se ignora en lugar de tumbar el proceso.
    }
  }
  return result;
}

let sessionVersion = Date.now();

function sign(expiresAt, version) {
  if (!uiPassword) throw new Error("Sin contraseña de consola no se pueden firmar sesiones.");
  return createHmac("sha256", uiPassword)
    .update(`factory-ui:${expiresAt}:${version}`)
    .digest("base64url");
}

function issueToken() {
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(300, sessionTtlSeconds);
  return `${expiresAt}.${sessionVersion}.${sign(expiresAt, sessionVersion)}`;
}

function verifyToken(token) {
  if (!token) return false;
  const [expiresRaw, versionRaw, signature] = token.split(".");
  const expiresAt = Number(expiresRaw);
  const version = Number(versionRaw);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;
  if (!Number.isFinite(version) || version !== sessionVersion) return false;
  const expected = Buffer.from(sign(expiresAt, version));
  const received = Buffer.from(signature ?? "");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function isAuthenticated(req) {
  if (!authRequired) return true;
  return verifyToken(parseCookies(req.headers.cookie)[cookieName]);
}

function secureCookie(req) {
  return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https";
}

function sessionCookie(req, token, maxAge) {
  return [
    `${cookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secureCookie(req) ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Cuerpo demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hostnameOf(hostHeader) {
  const raw = String(hostHeader ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("[")) return raw.slice(1, raw.indexOf("]")).toLowerCase();
  return raw.split(":")[0].toLowerCase();
}

function requestHost(req) {
  return String(
    (isTrustedProxy(req) ? req.headers["x-forwarded-host"] : undefined) ?? req.headers.host ?? "",
  );
}

function allowedHost(hostHeader) {
  const hostname = hostnameOf(hostHeader);
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") return true;
  if (allowedHosts.includes(hostname)) return true;
  // Tailscale Serve termina TLS y reenvía con el nombre *.ts.net.
  return authRequired && hostname.endsWith(".ts.net");
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(String(origin)).hostname.toLowerCase();
    // Tailscale Serve puede conservar o cambiar el puerto; comparamos hostname.
    if (originHost === hostnameOf(requestHost(req))) return true;
    if (authRequired && originHost.endsWith(".ts.net")) return true;
    return allowedHosts.includes(originHost);
  } catch {
    return false;
  }
}

function serveStatic(req, res) {
  let url;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }
  let requested;
  try {
    requested = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }
  const candidate = normalize(join(dist, requested === "/" ? "index.html" : requested));
  const safe =
    candidate === dist || candidate.startsWith(`${dist}${sep}`)
      ? candidate
      : join(dist, "index.html");
  const file = existsSync(safe) && statSync(safe).isFile() ? safe : join(dist, "index.html");

  if (!existsSync(file)) {
    sendText(res, 503, "La consola no está compilada. Ejecuta `npm run build` en ui/.");
    return;
  }

  const type = mime[extname(file)] ?? "application/octet-stream";
  const noStore = ["index.html", "sw.js", "manifest.webmanifest", "offline.html"].includes(
    extname(file) === ".html" ? "index.html" : file.split("/").pop(),
  );
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": type,
    "cache-control": noStore
      ? "no-store"
      : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(res);
}

function proxy(req, res) {
  const headers = { ...req.headers, host: target.host };
  delete headers.authorization;
  delete headers.cookie;
  if (authorization) headers.authorization = authorization;

  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, { ...response.headers, ...securityHeaders() });
      response.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 502, {
      error: "upstream_unavailable",
      message: `OpenCode no responde en ${target.origin}`,
      detail: error.message,
    });
  });

  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });

  req.pipe(upstream);
}

/**
 * Estado de solo lectura del repositorio para `/status` y el traspaso.
 * Ejecuta git sin shell y devuelve solo rama, último commit y archivos con
 * cambios; no incluye remotos, configuración ni credenciales.
 */
function repoStatus(directory) {
  if (typeof directory !== "string" || !directory.startsWith("/")) {
    return { ok: false, error: "directorio inválido" };
  }
  let root;
  try {
    root = realpathSync(directory);
  } catch {
    return { ok: false, error: "el directorio no existe" };
  }
  const run = (args) =>
    spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
  const top = run(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !String(top.stdout ?? "").trim()) {
    return { ok: false, error: "no es un repositorio git" };
  }
  const repository = String(top.stdout).trim();
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = run(["log", "-1", "--format=%h %s"]);
  const status = run(["status", "--porcelain=v1"]);
  const files = String(status.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    ok: true,
    root: repository,
    branch: String(branch.stdout ?? "").trim() || "(detached)",
    last_commit: String(commit.stdout ?? "").trim(),
    dirty: files.slice(0, 40),
    clean: files.length === 0,
    truncated: files.length > 40,
  };
}

async function upstreamStatus() {
  try {
    const response = await fetch(new URL("/info", target.origin), {
      headers: authorization ? { authorization } : {},
      signal: AbortSignal.timeout(2500),
    });
    let version;
    try {
      const body = await response.json();
      version = body?.version;
    } catch {
      // /info puede no existir en versiones antiguas; el estado HTTP basta.
    }
    return { ok: response.ok, status: response.status, version };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

function openCodeBinary() {
  if (process.env.FACTORY_OPENCODE_BIN) return process.env.FACTORY_OPENCODE_BIN;
  const local = join(homedir(), ".opencode", "bin", "opencode");
  return existsSync(local) ? local : "opencode";
}

let starting = null;
async function startUpstream() {
  const current = await upstreamStatus();
  if (current.ok) return { started: false, ...current };
  if (starting) return starting;
  starting = (async () => {
    const child = spawn(openCodeBinary(), ["serve", "--service"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.on("error", (error) => {
      console.warn(`No se pudo ejecutar ${openCodeBinary()}: ${error.message}`);
    });
    child.unref();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      const status = await upstreamStatus();
      if (status.ok) return { started: true, ...status };
    }
    return { started: true, ok: false, timeout: true };
  })().finally(() => {
    starting = null;
  });
  return starting;
}

async function handleAuth(req, res, url) {
  if (url.pathname === "/auth/session" && req.method === "GET") {
    sendJson(res, 200, {
      authenticated: isAuthenticated(req),
      auth_required: authRequired,
    });
    return true;
  }

  if (url.pathname === "/auth/login" && req.method === "POST") {
    if (!authRequired) {
      sendJson(res, 200, { ok: true, auth_required: false }, { "set-cookie": sessionCookie(req, "", 0) });
      return true;
    }
    const limit = loginLimit(clientIp(req));
    if (!limit.ok) {
      sendJson(res, 429, { error: "rate_limited", retry_after: limit.retryAfter }, {
        "retry-after": String(limit.retryAfter),
      });
      return true;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid_body" });
      return true;
    }
    const candidate = typeof body?.password === "string" ? body.password : "";
    if (!safeEqual(candidate, uiPassword)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      sendJson(res, 401, { error: "invalid_credentials" });
      return true;
    }
    sendJson(res, 200, { ok: true, auth_required: true }, {
      "set-cookie": sessionCookie(req, issueToken(), Math.max(300, sessionTtlSeconds)),
    });
    return true;
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    if (req.headers["x-factory-ui"] !== "1" || !originAllowed(req)) {
      sendJson(res, 403, { error: "forbidden" });
      return true;
    }
    if (isAuthenticated(req)) sessionVersion += 1;
    sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie(req, "", 0) });
    return true;
  }

  return false;
}

async function handleRequest(req, res) {
  const hostHeader = requestHost(req);
  if (!allowedHost(hostHeader)) {
    sendText(res, 403, "Host no permitido");
    return;
  }

  let url;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }

  if (await handleAuth(req, res, url)) return;

  if (url.pathname === "/healthz") {
    const upstream = await upstreamStatus();
    const authed = isAuthenticated(req);
    sendJson(res, upstream.ok ? 200 : 503, {
      ok: upstream.ok,
      ui: "ok",
      auth_required: authRequired,
      upstream: {
        ok: upstream.ok,
        status: upstream.status,
        version: authed ? upstream.version ?? null : null,
      },
      checked_at: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { error: "unauthenticated" });
      return;
    }

    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET");
    if (mutating) {
      if (req.headers["x-factory-ui"] !== "1" || !originAllowed(req)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      const limit = mutateLimit(clientIp(req));
      if (!limit.ok) {
        sendJson(res, 429, { error: "rate_limited", retry_after: limit.retryAfter }, {
          "retry-after": String(limit.retryAfter),
        });
        return;
      }
    }

    if (url.pathname === "/api/system/start" && req.method === "POST") {
      const limit = startLimit(clientIp(req));
      if (!limit.ok) {
        sendJson(res, 429, { error: "rate_limited", retry_after: limit.retryAfter }, {
          "retry-after": String(limit.retryAfter),
        });
        return;
      }
      const result = await startUpstream();
      sendJson(res, result.ok ? 200 : 503, result);
      return;
    }

    if (url.pathname === "/api/repo/status" && req.method === "GET") {
      sendJson(res, 200, repoStatus(url.searchParams.get("directory") ?? ""));
      return;
    }

    proxy(req, res);
    return;
  }

  serveStatic(req, res);
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    console.error("[factory-console] error no controlado", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_error" });
    } else {
      res.destroy();
    }
  });
});

server.requestTimeout = 0;
server.headersTimeout = 65_000;

server.listen(port, host, () => {
  console.log(`Factory Console en http://${host}:${port}`);
  console.log(`Proxy OpenCode: ${target.origin}${authorization ? " (auth configurada)" : " (sin auth)"}`);
  console.log(`Auth de consola: ${authRequired ? "activada" : "desactivada (solo loopback)"}`);
  // Si OpenCode no está levantado, la consola lo arranca al abrirse.
  startUpstream()
    .then((result) => {
      if (result.started) console.log(result.ok ? "OpenCode arrancado" : "OpenCode no arrancó a tiempo");
    })
    .catch((error) => console.warn(`No se pudo comprobar OpenCode: ${error.message}`));
});

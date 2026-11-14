import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const port = Number(process.env.FACTORY_UI_PORT ?? 4173);
const host = process.env.FACTORY_UI_HOST ?? "127.0.0.1";
const target = new URL(process.env.OPENCODE_URL ?? "http://127.0.0.1:49374");

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

const password = readPassword();
const authorization = password
  ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  : undefined;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  let url;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
  const requested = decodeURIComponent(url.pathname);
  const candidate = normalize(join(dist, requested === "/" ? "index.html" : requested));
  const safe = candidate.startsWith(dist) ? candidate : join(dist, "index.html");
  const file = existsSync(safe) && statSync(safe).isFile() ? safe : join(dist, "index.html");

  if (!existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("La consola no está compilada. Ejecuta `npm run build` en ui/.");
    return;
  }

  const type = mime[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
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
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`OpenCode no responde en ${target.origin}: ${error.message}`);
  });

  // El stream de eventos es de larga duración: al cerrar la pestaña hay que
  // cerrar también la conexión con OpenCode para no dejar streams huérfanos.
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });

  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const hostHeader = String(req.headers.host ?? "");
  const allowedHost =
    hostHeader === `127.0.0.1:${port}` ||
    hostHeader === `localhost:${port}` ||
    (host !== "127.0.0.1" && hostHeader.endsWith(`:${port}`));
  if (!allowedHost) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Host no permitido");
    return;
  }

  if (req.url?.startsWith("/api/")) {
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET");
    if (mutating && req.headers["x-factory-ui"] !== "1") {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Cabecera x-factory-ui requerida");
      return;
    }
    proxy(req, res);
    return;
  }
  serveStatic(req, res);
});

// SSE (`/api/event`) mantiene la petición abierta; el timeout por defecto de
// Node (5 min) cortaría el stream en mitad de una conversación.
server.requestTimeout = 0;
server.headersTimeout = 65_000;

server.listen(port, host, () => {
  console.log(`Factory Console en http://${host}:${port}`);
  console.log(`Proxy OpenCode: ${target.origin}${authorization ? " (auth configurada)" : " (sin auth)"}`);
});

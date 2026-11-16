import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function readPassword(): string | undefined {
  if (process.env.OPENCODE_PASSWORD) return process.env.OPENCODE_PASSWORD;
  try {
    const raw = readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8");
    const parsed = JSON.parse(raw) as { password?: unknown };
    return typeof parsed.password === "string" ? parsed.password : undefined;
  } catch {
    return undefined;
  }
}

const password = readPassword();
const authorization = password
  ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  : undefined;

const target = process.env.OPENCODE_URL ?? "http://127.0.0.1:49374";

if (!password) {
  console.warn(
    "[factory-console] No encontré OPENCODE_PASSWORD ni service.json; el proxy puede recibir 401.",
  );
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // El optimizador de Vite no resuelve bien este paquete ESM en dev.
    exclude: ["@tanstack/react-virtual"],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        headers: authorization ? { authorization } : undefined,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});

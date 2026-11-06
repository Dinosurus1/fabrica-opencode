/**
 * Utilidades de ejecución para las tools de la fábrica.
 *
 * Qué hace: ejecuta un comando con timeout, captura salida acotada, elimina ANSI
 * y redacta patrones obvios de secretos antes de devolver texto al modelo.
 *
 * Qué accede: lanza procesos hijos con el shell del usuario, en el directorio
 * indicado. Por eso las tools que lo usan deben llamar antes a
 * `ctx.permission.assert` con la acción `shell`.
 */

import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
  durationMs: number;
}

const MAX_CAPTURE = 64 * 1024;

function appendCapped(current: string, chunk: Buffer): string {
  if (current.length >= MAX_CAPTURE) return current;
  const next = current + chunk.toString("utf8");
  if (next.length <= MAX_CAPTURE) return next;
  return `${next.slice(0, MAX_CAPTURE / 2)}\n…[salida recortada]…\n${next.slice(-MAX_CAPTURE / 2)}`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function redact(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1***@")
    .replace(/(mysql:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1***@")
    .replace(/(redis:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1***@")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-***")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, "gh***")
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, "AKIA***")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "xox***")
    .replace(
      /((?:password|passwd|contraseña|secret|token|api[_-]?key)\s*[:=]\s*)["']?[^\s"']{4,}/gi,
      "$1***",
    );
}

export function tail(text: string, max = 2_000): string {
  const clean = redact(stripAnsi(text)).trim();
  return clean.length <= max ? clean : `…${clean.slice(-max)}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // El proceso ya terminó.
        }
      }
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: string | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        error,
        durationMs: Date.now() - started,
      });
    };

    child.on("error", (error) => finish(null, null, error.message));
    child.on("close", (code, signal) => finish(code, signal, null));
  });
}

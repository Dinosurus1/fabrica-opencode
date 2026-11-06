/**
 * Tipos compartidos por las tools de la fábrica. No accede a nada.
 */

export interface ToolDef {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (
    input: Record<string, unknown>,
    context: {
      sessionID: string;
      agent: string;
      messageID: string;
      id: string;
      signal?: AbortSignal;
    },
  ) => Promise<{ content: string }>;
}

export function ok(value: unknown): { content: string } {
  return { content: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

export function fail(message: string): { content: string } {
  return { content: `Error: ${message}` };
}

/**
 * Detector conservador de secretos. No es infalible: evita guardar patrones
 * obvios (claves privadas, tokens de proveedores, asignaciones de password...).
 */
export function looksLikeSecret(text: string): boolean {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /\b(?:password|passwd|contraseña|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Utilidades puras de rutas para el plan por fases.
 *
 * Qué hacen: normalizan globs, detectan solapamiento entre archivos asignados,
 * identifican archivos compartidos y estiman si una tarea toca superficie
 * sensible. No acceden a disco ni a la base de datos.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

export function worktreeRoot(projectName: string): string {
  return join(homedir(), ".local", "share", "opencode", "worktrees", slugify(projectName));
}

export function isSafeBranchName(value: string): boolean {
  const branch = value.trim();
  if (!branch || branch.startsWith("-")) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return false;
  if (["main", "master", "develop", "HEAD"].includes(branch)) return false;
  if (branch.startsWith("refs/") || branch.startsWith("origin/") || branch.startsWith("factory/integration/")) {
    return false;
  }
  return true;
}

export const SHARED_PATTERNS = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "tsconfig.json",
  "tsconfig.*.json",
  "jsconfig.json",
  "vite.config.*",
  "vitest.config.*",
  "jest.config.*",
  "playwright.config.*",
  "cypress.config.*",
  "eslint.config.*",
  ".eslintrc*",
  ".prettierrc*",
  "prettier.config.*",
  "docker-compose*.yml",
  "docker-compose*.yaml",
  "compose*.yml",
  "compose*.yaml",
  "Dockerfile",
  "Dockerfile.*",
  ".github/workflows/**",
  "migrations/**",
  "alembic/**",
  "prisma/schema.prisma",
  "opencode.json",
  "opencode.jsonc",
  "AGENTS.md",
  "README.md",
  "SECURITY.md",
  "plugins/factory/migrations/**",
] as const;

const SENSITIVE_FLAGS = new Set([
  "auth",
  "authorization",
  "permissions",
  "roles",
  "session",
  "sessions",
  "jwt",
  "oauth",
  "password",
  "secrets",
  "crypto",
  "payments",
  "payment",
  "billing",
  "checkout",
  "refunds",
  "sql",
  "migration",
  "migrations",
  "files",
  "upload",
  "download",
  "delete",
]);

const SENSITIVE_TEXT =
  /\b(auth|authorization|autenticaci[oó]n|autorizaci[oó]n|login|logout|signin|signup|password|contrase[nñ]a|session|sesi[oó]n|jwt|oauth|permission|permiso|role|rol|security|seguridad|payment|pago|checkout|billing|facturaci[oó]n|refund|reembolso|secret|secreto|crypto|criptograf|upload|subida|download|descarga|delete|borrado|sql|migration|migraci[oó]n)\b/i;

export function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

export function normalizeGlob(value: string): string {
  return normalizePath(value) || "**";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convierte un glob simple a RegExp.
 * `**` cruza directorios; `*` y `?` no cruzan `/`.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlob(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(pattern: string, file: string): boolean {
  const normalized = normalizePath(file);
  if (!normalized) return false;
  return globToRegExp(pattern).test(normalized);
}

export function staticPrefix(pattern: string): string {
  const normalized = normalizeGlob(pattern);
  const wildcard = normalized.search(/[?*]/);
  const prefix = wildcard >= 0 ? normalized.slice(0, wildcard) : normalized;
  return prefix.replace(/\/$/, "");
}

/**
 * Solapamiento conservador: si dos patrones pueden tocar el mismo archivo,
 * devuelve true. Es preferible serializar de más que pisar archivos.
 */
export function globsOverlap(left: string, right: string): boolean {
  const a = normalizeGlob(left);
  const b = normalizeGlob(right);
  if (a === b) return true;
  const prefixA = staticPrefix(a);
  const prefixB = staticPrefix(b);
  if (!prefixA || !prefixB) return true;
  if (prefixA === prefixB) return true;
  return prefixA.startsWith(`${prefixB}/`) || prefixB.startsWith(`${prefixA}/`);
}

export function anyGlobsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => globsOverlap(a, b)));
}

export function isSharedFile(file: string): boolean {
  return SHARED_PATTERNS.some((pattern) => matchesGlob(pattern, file));
}

export function isSharedTask(files: readonly string[]): boolean {
  return files.some((file) => isSharedFile(file));
}

export function sensitiveFlags(flags: readonly string[]): string[] {
  return flags.map((flag) => flag.toLowerCase()).filter((flag) => SENSITIVE_FLAGS.has(flag));
}

export function isSensitiveTask(input: {
  title?: string;
  description?: string;
  filesOwned?: readonly string[];
  riskFlags?: readonly string[];
}): boolean {
  if (sensitiveFlags(input.riskFlags ?? []).length > 0) return true;
  const files = input.filesOwned ?? [];
  if (files.some((file) => SENSITIVE_TEXT.test(file))) return true;
  return SENSITIVE_TEXT.test(`${input.title ?? ""}\n${input.description ?? ""}`);
}

export function filesOutsideOwned(files: readonly string[], owned: readonly string[]): string[] {
  const patterns = owned.map(normalizeGlob);
  return files
    .map(normalizePath)
    .filter((file) => file && !patterns.some((pattern) => matchesGlob(pattern, file)));
}

export function countGlobs(files: readonly string[]): number {
  return new Set(files.map(normalizeGlob).filter(Boolean)).size;
}

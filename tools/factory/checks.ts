/**
 * Tool run_checks.
 *
 * Qué hace: ejecuta los comandos de lint/typecheck/test (y opcionalmente install
 * o build) del perfil del proyecto, en orden, con timeout. Devuelve un resultado
 * estructurado y acotado: estado, duración, hallazgos archivo:línea y resumen.
 *
 * Qué accede: la tabla `factory_projects` y el sistema de archivos/procesos del
 * proyecto. Ejecuta comandos con el shell del usuario, por lo que SIEMPRE llama
 * antes a `ctx.permission.assert` con la acción `shell`.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FactoryDb, ProjectRef } from "./db.js";
import { redact, runCommand, stripAnsi, tail } from "./exec.js";
import { fail, looksLikeSecret, ok, type ToolDef } from "./types.js";

export interface ChecksToolsDeps {
  db: FactoryDb;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
  permission: { assert: (input: Record<string, unknown>) => Promise<void> };
}

const CHECK_NAMES = ["install", "lint", "typecheck", "test", "build"] as const;
type CheckName = (typeof CHECK_NAMES)[number];

const DEFAULT_CHECKS: CheckName[] = ["lint", "typecheck", "test"];

export interface Finding {
  file: string;
  line: number | null;
  column: number | null;
  message: string;
}

interface CheckResult {
  name: CheckName;
  command: string;
  status: "passed" | "failed" | "timeout" | "skipped" | "error";
  exitCode: number | null;
  durationMs: number;
  summary: string;
  findings: Finding[];
  outputTail: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeFile(file: string, root: string): string | null {
  let clean = file.replace(/^["']|["']$/g, "").trim();
  if (!clean) return null;
  if (clean.startsWith("file://")) {
    try {
      clean = decodeURIComponent(new URL(clean).pathname);
    } catch {
      return null;
    }
  }
  // node:, http:, internal/... no son archivos del proyecto.
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  if (clean.startsWith("internal/")) return null;
  const absolute = isAbsolute(clean) ? clean : resolve(root, clean);
  if (!inside(root, absolute)) return null;
  return relative(root, absolute) || clean;
}

export function extractFindings(output: string, root: string): Finding[] {
  const clean = stripAnsi(output);
  const lines = clean.split(/\r?\n/);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  let lastError = "";

  const add = (file: string | null, line: number | null, column: number | null, message: string) => {
    const normalized = file ? normalizeFile(file, root) : "salida";
    if (!normalized) return;
    const text = redact(message).replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text) return;
    const key = `${normalized}:${line ?? ""}:${column ?? ""}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file: normalized, line, column, message: text });
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (
      /^(?:AssertionError|Error|ERROR|error|Exception|panic|fatal)\b/i.test(line) ||
      /error TS\d+/i.test(line)
    ) {
      lastError = line;
    }

    // Stack frames de Node: "at fn (file:///ruta:6:10)" o "at /ruta:6:10".
    const stackWithParen = line.match(/^at\s+.*?\((.+?):(\d+):(\d+)\)$/);
    if (stackWithParen) {
      add(
        stackWithParen[1],
        Number(stackWithParen[2]),
        Number(stackWithParen[3]),
        lastError || "stack trace",
      );
      continue;
    }
    const stackPlain = line.match(/^at\s+(.+?):(\d+):(\d+)$/);
    if (stackPlain) {
      add(stackPlain[1], Number(stackPlain[2]), Number(stackPlain[3]), lastError || "stack trace");
      continue;
    }

    // node:test señala el test fallido como "test at archivo:línea:col".
    const testAt = line.match(/^test at (.+?):(\d+):(\d+)$/);
    if (testAt) {
      add(testAt[1], Number(testAt[2]), Number(testAt[3]), lastError || "test fallido");
      continue;
    }

    // TypeScript: "src/file.ts(12,34): error TS2322: ...".
    const ts = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/i);
    if (ts) {
      add(ts[1], Number(ts[2]), Number(ts[3]), `${ts[4]} ${ts[5]}: ${ts[6]}`);
      continue;
    }

    // PHP: "Parse error: ... in /ruta/archivo.php on line 12".
    const php = line.match(/\bin (.+?) on line (\d+)/i);
    if (php) {
      add(php[1], Number(php[2]), null, line);
      continue;
    }

    // tsc, eslint, ruff, gcc: "archivo:línea:col: mensaje" o "archivo:línea: mensaje".
    const withPosition = line.match(
      /^((?:[A-Za-z]:)?[^\s:][^:]*?):(\d+)(?::(\d+))?(?:\s*[-:]\s*|\s+)(.+)$/,
    );
    if (withPosition) {
      const file = withPosition[1];
      const fileLike =
        /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|php|css|scss|json|ya?ml|md|vue|svelte)$/i.test(file) ||
        file.includes("/");
      const noise = /^(?:test at|at)\s/i.test(file) || (file.includes(" ") && !file.includes("/"));
      if (fileLike && !noise && !/^https?:\/\//i.test(file)) {
        add(
          file,
          Number(withPosition[2]),
          withPosition[3] ? Number(withPosition[3]) : null,
          withPosition[4],
        );
        continue;
      }
    }

    const failure = line.match(/^FAIL\s+(\S+)/);
    if (failure) {
      add(failure[1], null, null, "fallo reportado por el runner");
      continue;
    }

    if (/^(?:AssertionError|Error|ERROR|error|Exception|panic|fatal)\b/i.test(line)) {
      add(null, null, null, line);
    }
  }

  // Los hallazgos con archivo concreto son más útiles que el error genérico.
  findings.sort((left, right) => Number(left.file === "salida") - Number(right.file === "salida"));
  return findings.slice(0, 20);
}

function summarize(
  output: string,
  findings: Finding[],
  status: CheckResult["status"],
  exitCode: number | null,
  durationMs: number,
  timedOut: boolean,
  error: string | null,
): string {
  if (status === "skipped") return "sin comando configurado";
  if (status === "timeout") return `timeout tras ${durationMs} ms`;
  if (status === "error") return error ?? "error al lanzar el comando";
  if (status === "passed") {
    const last = stripAnsi(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-2)
      .join(" · ");
    return `pasó (exit 0, ${durationMs} ms)${last ? ` · ${redact(last).slice(0, 240)}` : ""}`;
  }
  if (findings.length > 0) {
    const preferred =
      findings.find(
        (finding) => !/^(?:test fallido|stack trace|fallo reportado por el runner)$/i.test(finding.message),
      ) ?? findings[0]!;
    return `falló (exit ${exitCode ?? "?"}) · ${preferred.file}${preferred.line ? `:${preferred.line}` : ""} — ${preferred.message}`;
  }
  const last = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" · ");
  return `falló (exit ${exitCode ?? "?"})${timedOut ? " · timeout" : ""}${last ? ` · ${redact(last).slice(0, 300)}` : ""}`;
}

export function createChecksTools(deps: ChecksToolsDeps): ToolDef[] {
  return [
    {
      name: "run_checks",
      description:
        "Ejecuta lint/typecheck/test (y opcionalmente install/build) del perfil. Devuelve JSON compacto con estado, hallazgos archivo:línea y resumen.",
      input: {
        type: "object",
        properties: {
          checks: {
            type: "array",
            items: { type: "string", enum: CHECK_NAMES },
            description: "Comprobaciones a ejecutar. Default: lint, typecheck, test.",
            default: DEFAULT_CHECKS,
          },
          commands: {
            type: "object",
            properties: {
              install: { type: "string" },
              lint: { type: "string" },
              typecheck: { type: "string" },
              test: { type: "string" },
              build: { type: "string" },
            },
            additionalProperties: false,
            description: "Comandos candidatos para onboarding; se mezclan con el perfil.",
          },
          timeout_ms: {
            type: "integer",
            minimum: 5_000,
            maximum: 600_000,
            default: 120_000,
            description: "Timeout por comprobación (ms).",
          },
        },
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const profile = await deps.db.getProfile(project.projectId);

        const override: Record<string, string> = {};
        if (input.commands !== undefined) {
          if (!isPlainObject(input.commands)) return fail("commands debe ser un objeto.");
          for (const [key, value] of Object.entries(input.commands)) {
            if (typeof value !== "string" || !value.trim()) {
              return fail(`El comando "${key}" debe ser una cadena no vacía.`);
            }
            override[key] = value.trim();
          }
        }

        const commands: Record<string, string> = {
          ...(profile?.commands ?? {}),
          ...override,
        };
        for (const [key, value] of Object.entries(commands)) {
          if (looksLikeSecret(value)) {
            return fail(
              `El comando "${key}" parece contener un secreto. Corrige el perfil o usa variables de entorno antes de ejecutarlo.`,
            );
          }
        }
        if (Object.keys(commands).length === 0) {
          return fail(
            "No hay comandos en el perfil ni en commands. Ejecuta project_detect y guarda el perfil con project_profile_set.",
          );
        }

        const requestedRaw = Array.isArray(input.checks) ? input.checks : DEFAULT_CHECKS;
        const requested: CheckName[] = [];
        for (const value of requestedRaw) {
          if (typeof value !== "string" || !(CHECK_NAMES as readonly string[]).includes(value)) {
            return fail(`Comprobación inválida: ${String(value)}. Valores: ${CHECK_NAMES.join(", ")}.`);
          }
          if (!requested.includes(value as CheckName)) requested.push(value as CheckName);
        }
        if (requested.length === 0) return fail("Indica al menos una comprobación.");

        const timeoutMs =
          typeof input.timeout_ms === "number"
            ? Math.min(Math.max(Math.round(input.timeout_ms), 5_000), 600_000)
            : 120_000;

        const results: CheckResult[] = [];
        for (const name of requested) {
          const command = commands[name];
          if (!command) {
            results.push({
              name,
              command: "",
              status: "skipped",
              exitCode: null,
              durationMs: 0,
              summary: "sin comando configurado en el perfil",
              findings: [],
              outputTail: "",
            });
            continue;
          }

          await deps.permission.assert({
            sessionID: String(context.sessionID),
            agent: context.agent,
            source: {
              type: "tool",
              messageID: String(context.messageID),
              id: String(context.id),
            },
            action: "shell",
            resources: [command],
            save: [command],
            metadata: { tool: "run_checks", check: name },
          });

          const result = await runCommand(command, project.directory, timeoutMs);
          const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
          const findings = extractFindings(output, project.directory);

          let status: CheckResult["status"];
          if (result.timedOut) status = "timeout";
          else if (result.error) status = "error";
          else if (result.exitCode === 0) status = "passed";
          else status = "failed";

          results.push({
            name,
            command,
            status,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            summary: summarize(
              output,
              findings,
              status,
              result.exitCode,
              result.durationMs,
              result.timedOut,
              result.error,
            ),
            findings,
            outputTail: tail(output, 2_000),
          });
        }

        const executed = results.filter((result) => result.status !== "skipped");
        const failed = results.filter(
          (result) => result.status === "failed" || result.status === "timeout" || result.status === "error",
        );
        const passed = results.filter((result) => result.status === "passed");

        return ok({
          ok: failed.length === 0,
          project: { id: project.projectId, path: project.directory },
          profile: profile
            ? { found: true, verifiedAt: profile.verifiedAt }
            : { found: false, verifiedAt: null },
          summary: `${passed.length}/${executed.length} comprobaciones pasaron${failed.length ? `; fallaron: ${failed.map((result) => result.name).join(", ")}` : ""}`,
          checks: results,
        });
      },
    },
  ];
}

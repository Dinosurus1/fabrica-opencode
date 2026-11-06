/**
 * Tool run_gates y quality_policy_set.
 *
 * Qué hace: ejecuta compuertas deterministas según el perfil del proyecto
 * (formato, lint, tipos, build, tests, cobertura, seguridad, dependencias,
 * estática, e2e, accesibilidad, API, migraciones y lentas opcionales), compara
 * con la línea base y guarda cada ejecución en `gate_runs`.
 *
 * Qué accede: PostgreSQL (`factory_projects`, `gate_runs`), archivos del
 * proyecto y procesos hijos. Cada comando shell pasa por
 * `ctx.permission.assert`. No vuelca logs completos ni secretos.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FactoryDb, FactoryProfile, ProjectRef } from "./db.js";
import { extractFindings, type Finding } from "./checks.js";
import { evaluateCoverage, getCoverageConfig, parseCoverageOutput, parseCoverageReport } from "./coverage.js";
import { runCommand, shellQuote, tail, type CommandResult } from "./exec.js";
import { getChangedFiles, getCurrentBranch } from "./git.js";
import { runSecurityScan } from "./security.js";
import { fail, looksLikeSecret, ok, type ToolDef } from "./types.js";

export interface GatesToolsDeps {
  db: FactoryDb;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
  permission: { assert: (input: Record<string, unknown>) => Promise<void> };
}

type GateName =
  | "format"
  | "lint"
  | "typecheck"
  | "build"
  | "test"
  | "coverage"
  | "security"
  | "dependencies"
  | "static"
  | "e2e"
  | "accessibility"
  | "api"
  | "migrations"
  | "mutation"
  | "performance";

type GateStatus = "pass" | "fail" | "skipped" | "error";
type Severity = "critical" | "high" | "medium" | "low" | "unknown";

interface GateFinding {
  file: string;
  line: number | null;
  severity: Severity;
  rule: string;
  message: string;
  new?: boolean;
  debt?: boolean;
}

interface GateResult {
  gate: GateName;
  status: GateStatus;
  blocking: boolean;
  applicable: boolean;
  findings: GateFinding[];
  evidence: string;
  duration_ms: number;
  skipped_reason: string | null;
  network: unknown;
  metrics?: Record<string, unknown>;
  new_findings?: number;
  debt_findings?: number;
}

interface GateContext {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
}

const GATE_ORDER: GateName[] = [
  "format",
  "lint",
  "typecheck",
  "build",
  "test",
  "coverage",
  "security",
  "dependencies",
  "static",
  "e2e",
  "accessibility",
  "api",
  "migrations",
  "mutation",
  "performance",
];

const DEFAULT_GATES = GATE_ORDER.filter((gate) => gate !== "mutation" && gate !== "performance");

const DEFAULT_POLICY = {
  blocking: {
    build: true,
    format: false,
    lint: true,
    typecheck: true,
    test: true,
    coverage: false,
    e2e: false,
    security: true,
    dependencies: false,
    static: false,
    migrations: false,
    accessibility: false,
    api: false,
    mutation: false,
    performance: false,
  } as Record<GateName, boolean>,
  severity: { critical: true, high: true, medium: false, low: false },
  coverage: { total: 80, changed: 80, tolerance: 0.5 },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function commandOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isPlainObject(value) && typeof value.command === "string" && value.command.trim()) return value.command.trim();
  return null;
}

function policyFor(profile: FactoryProfile | null): {
  blocking: Record<GateName, boolean>;
  severity: Record<string, boolean>;
} {
  const raw = isPlainObject(profile?.quality?.policy) ? profile.quality.policy : {};
  const rawBlocking = isPlainObject(raw.blocking) ? raw.blocking : {};
  const blocking = { ...DEFAULT_POLICY.blocking };
  for (const gate of GATE_ORDER) {
    if (typeof rawBlocking[gate] === "boolean") blocking[gate] = rawBlocking[gate];
  }
  const rawSeverity = isPlainObject(raw.severity) ? raw.severity : {};
  const severity: Record<string, boolean> = { ...DEFAULT_POLICY.severity };
  for (const key of Object.keys(severity)) {
    if (typeof rawSeverity[key] === "boolean") severity[key] = rawSeverity[key];
  }
  return { blocking, severity };
}

function coverageConfig(profile: FactoryProfile | null) {
  const config = getCoverageConfig(profile);
  if (!config) return null;
  const raw = isPlainObject(profile?.quality?.coverage) ? profile.quality.coverage : {};
  const policy = isPlainObject(profile?.quality?.policy) && isPlainObject(profile.quality.policy.coverage)
    ? profile.quality.policy.coverage
    : {};
  return {
    ...config,
    threshold: Number(policy.total ?? raw.threshold ?? config.threshold),
    changedThreshold: Number(policy.changed ?? raw.changedThreshold ?? config.changedThreshold),
    tolerance: Number(policy.tolerance ?? raw.tolerance ?? config.tolerance),
  };
}

function fingerprint(finding: GateFinding): string {
  return `${finding.file}|${finding.rule}|${finding.message}`.replace(/\s+/g, " ").toLowerCase().slice(0, 500);
}

function findingCounts(findings: GateFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    const key = fingerprint(finding);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function mapExtracted(findings: Finding[], gate: GateName): GateFinding[] {
  return findings.slice(0, 20).map((finding) => ({
    file: finding.file,
    line: finding.line,
    severity: "medium",
    rule: gate,
    message: finding.message,
  }));
}

async function runGateCommand(
  deps: GatesToolsDeps,
  context: GateContext,
  command: string,
  cwd: string,
  timeout: number,
): Promise<CommandResult | { setupError: string }> {
  if (looksLikeSecret(command)) {
    return { setupError: "El comando parece contener un secreto; no se ejecutó." };
  }
  await deps.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool", messageID: context.messageID, id: context.id },
    action: "shell",
    resources: [command],
    save: [command],
    metadata: { tool: "run_gates" },
  });
  return runCommand(command, cwd, timeout);
}

async function shellGate(
  deps: GatesToolsDeps,
  context: GateContext,
  project: ProjectRef,
  gate: GateName,
  command: string | null,
  timeout = 180_000,
  applicableWhenMissing = false,
): Promise<GateResult> {
  const started = Date.now();
  if (!command) {
    return {
      gate,
      status: "skipped",
      blocking: false,
      applicable: applicableWhenMissing,
      findings: [],
      evidence: "sin comando configurado",
      duration_ms: 0,
      skipped_reason: "sin comando configurado",
      network: null,
    };
  }
  const result = await runGateCommand(deps, context, command, project.directory, timeout);
  if ("setupError" in result) {
    return {
      gate,
      status: "error",
      blocking: false,
      applicable: true,
      findings: [],
      evidence: result.setupError,
      duration_ms: Date.now() - started,
      skipped_reason: null,
      network: null,
    };
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const findings = mapExtracted(extractFindings(output, project.directory), gate);
  const status: GateStatus = result.timedOut
    ? "error"
    : result.error
      ? "error"
      : result.exitCode === 0
        ? "pass"
        : "fail";
  return {
    gate,
    status,
    blocking: false,
    applicable: true,
    findings,
    evidence: `exit ${result.exitCode ?? "?"}; ${findings.length} hallazgo(s); ${tail(output, 240)}`,
    duration_ms: result.durationMs,
    skipped_reason: null,
    network: null,
  };
}

async function securityGate(
  deps: GatesToolsDeps,
  context: GateContext,
  project: ProjectRef,
  profile: FactoryProfile | null,
): Promise<GateResult> {
  const started = Date.now();
  const security = isPlainObject(profile?.quality?.security) ? profile.quality.security : {};
  const mode = typeof security.mode === "string" && ["offline", "online", "auto"].includes(security.mode)
    ? security.mode
    : "offline";
  const scanners = Array.isArray(security.scanners)
    ? security.scanners.filter((value): value is string => typeof value === "string")
    : undefined;
  const result = await runSecurityScan(
    deps as never,
    project,
    { target: ".", mode, scanners },
    context,
  );
  if ("error" in result) {
    return {
      gate: "security",
      status: "error",
      blocking: false,
      applicable: true,
      findings: [],
      evidence: String((result as { error: unknown }).error),
      duration_ms: Date.now() - started,
      skipped_reason: null,
      network: null,
    };
  }
  const scannersResult = Array.isArray(result.scanners) ? result.scanners : [];
  const ran = scannersResult.filter((scanner) => isPlainObject(scanner) && scanner.status !== "missing" && scanner.status !== "skipped");
  const findings: GateFinding[] = (Array.isArray(result.findings) ? result.findings : []).slice(0, 50).map((raw) => {
    const finding = isPlainObject(raw) ? raw : {};
    return {
      file: String(finding.file ?? "?"),
      line: typeof finding.line === "number" ? finding.line : null,
      severity: ["critical", "high", "medium", "low"].includes(String(finding.severity))
        ? (finding.severity as Severity)
        : "unknown",
      rule: String(finding.rule ?? finding.scanner ?? "security"),
      message: String(finding.message ?? ""),
    };
  });
  const allSkipped = ran.length === 0;
  const scannerErrors = scannersResult.filter(
    (scanner) => isPlainObject(scanner) && (scanner.status === "error" || scanner.status === "timeout"),
  );
  const skippedReasons = scannersResult
    .filter((scanner) => isPlainObject(scanner) && (scanner.status === "missing" || scanner.status === "skipped"))
    .map((scanner) => `${String((scanner as Record<string, unknown>).scanner)}: ${String((scanner as Record<string, unknown>).skipped_reason ?? (scanner as Record<string, unknown>).hint ?? "no disponible")}`);
  const unavailable = scannersResult.filter((scanner) => {
    if (!isPlainObject(scanner)) return false;
    if (scanner.status === "missing") return true;
    if (scanner.status !== "skipped") return false;
    const reason = String(scanner.skipped_reason ?? "");
    return !/sin paquetes|no hay lockfile|no package sources|no hay manifiesto/i.test(reason);
  });
  const warningText = skippedReasons.length > 0 && unavailable.length === 0 ? ` · omitidos: ${skippedReasons.join(" · ")}` : "";
  const errorText = scannerErrors.length > 0
    ? ` · errores: ${scannerErrors.map((scanner) => `${String((scanner as Record<string, unknown>).scanner)}: ${String((scanner as Record<string, unknown>).error ?? "error")}`).join(" · ")}`
    : unavailable.length > 0
      ? ` · no disponibles: ${unavailable.map((scanner) => String((scanner as Record<string, unknown>).scanner)).join(" · ")}`
      : "";
  return {
    gate: "security",
    status: allSkipped ? "skipped" : scannerErrors.length > 0 || unavailable.length > 0 ? "error" : findings.length > 0 ? "fail" : "pass",
    blocking: false,
    applicable: true,
    findings,
    evidence: `${String(result.summary ?? `modo ${mode}`)}${warningText}${errorText}`.slice(0, 800),
    duration_ms: Date.now() - started,
    skipped_reason: allSkipped ? skippedReasons.join(" · ").slice(0, 500) : null,
    network: scannersResult.map((scanner) => isPlainObject(scanner)
      ? { scanner: scanner.scanner, network: scanner.network, config: scanner.config, status: scanner.status }
      : { scanner: "?" }),
  };
}

function phpCoverageSkipReason(project: ProjectRef, profile: FactoryProfile | null): Promise<string | null> | string | null {
  const languages = Array.isArray(profile?.stack?.languages) ? profile.stack.languages : [];
  if (!languages.includes("php")) return null;
  return (async () => {
    const modules = await runCommand("php -m", project.directory, 5_000);
    if (modules.exitCode !== 0) return "php no está disponible; no se puede comprobar xdebug/pcov.";
    if (!/\b(xdebug|pcov)\b/i.test(modules.stdout)) {
      return "PHP sin Xdebug ni PCOV; la cobertura PHP se marca skipped.";
    }
    return null;
  })();
}

async function coverageGate(
  deps: GatesToolsDeps,
  context: GateContext,
  project: ProjectRef,
  profile: FactoryProfile | null,
): Promise<GateResult> {
  const started = Date.now();
  const config = coverageConfig(profile);
  if (!config) {
    return {
      gate: "coverage",
      status: "skipped",
      blocking: false,
      applicable: false,
      findings: [],
      evidence: "sin comando de cobertura",
      duration_ms: 0,
      skipped_reason: "sin comando de cobertura en el perfil",
      network: null,
    };
  }
  const phpSkip = await phpCoverageSkipReason(project, profile);
  if (phpSkip) {
    return {
      gate: "coverage",
      status: "skipped",
      blocking: false,
      applicable: true,
      findings: [],
      evidence: phpSkip,
      duration_ms: 0,
      skipped_reason: phpSkip,
      network: null,
    };
  }

  const result = await runGateCommand(deps, context, config.command, project.directory, 240_000);
  if ("setupError" in result) {
    return {
      gate: "coverage",
      status: "error",
      blocking: false,
      applicable: true,
      findings: [],
      evidence: result.setupError,
      duration_ms: Date.now() - started,
      skipped_reason: null,
      network: null,
    };
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  let total = parseCoverageOutput(output);
  if (config.reportPath) {
    const reportPath = resolve(project.directory, config.reportPath);
    if (inside(project.directory, reportPath) && existsSync(reportPath)) {
      const report = parseCoverageReport(readFileSync(reportPath, "utf8"), reportPath);
      if (report !== null) total = report;
    }
  }
  let changed: number | null = null;
  if (config.changedCommand) {
    const changedResult = await runGateCommand(deps, context, config.changedCommand, project.directory, 240_000);
    if (!("setupError" in changedResult)) {
      changed = parseCoverageOutput([changedResult.stdout, changedResult.stderr].filter(Boolean).join("\n"));
    }
  }
  const baselineRaw = isPlainObject(profile?.baseline?.coverage) ? profile.baseline.coverage : {};
  const baseline = typeof baselineRaw.total === "number" ? baselineRaw.total : null;

  if (result.timedOut || result.error || (result.exitCode !== 0 && total === null)) {
    return {
      gate: "coverage",
      status: "fail",
      blocking: false,
      applicable: true,
      findings: [
        {
          file: "coverage",
          line: null,
          severity: "medium",
          rule: "coverage.command",
          message: `El comando de cobertura falló (exit ${result.exitCode ?? "?"}). ${tail(output, 300)}`,
        },
      ],
      evidence: `exit ${result.exitCode ?? "?"}`,
      duration_ms: result.durationMs,
      skipped_reason: null,
      network: null,
    };
  }

  const evaluation = evaluateCoverage(config, total, changed, baseline);
  return {
    gate: "coverage",
    status: evaluation.status,
    blocking: false,
    applicable: true,
    findings: evaluation.findings,
    evidence: evaluation.evidence,
    duration_ms: result.durationMs,
    skipped_reason: null,
    network: null,
    metrics: { total, changed, baseline },
  };
}

async function dependenciesGate(
  deps: GatesToolsDeps,
  context: GateContext,
  project: ProjectRef,
  profile: FactoryProfile | null,
): Promise<GateResult> {
  const configured = commandOf(profile?.quality?.dependencies);
  if (configured) return shellGate(deps, context, project, "dependencies", configured);
  if (existsSync(resolve(project.directory, "package.json"))) {
    const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
    if (!lockfiles.some((file) => existsSync(resolve(project.directory, file)))) {
      return {
        gate: "dependencies",
        status: "fail",
        blocking: false,
        applicable: true,
        findings: [{
          file: "package.json",
          line: null,
          severity: "medium",
          rule: "dependencies.lockfile",
          message: "Hay package.json pero no hay lockfile; la instalación no es reproducible.",
        }],
        evidence: "lockfile ausente",
        duration_ms: 0,
        skipped_reason: null,
        network: null,
      };
    }
  }
  if (existsSync(resolve(project.directory, "composer.json"))) {
    return shellGate(deps, context, project, "dependencies", "composer validate --no-check-publish");
  }
  return {
    gate: "dependencies",
    status: "skipped",
    blocking: false,
    applicable: false,
    findings: [],
    evidence: "sin comando de higiene de dependencias",
    duration_ms: 0,
    skipped_reason: "no hay verificador de dependencias configurado",
    network: null,
  };
}

async function apiGate(
  deps: GatesToolsDeps,
  context: GateContext,
  project: ProjectRef,
  profile: FactoryProfile | null,
): Promise<GateResult> {
  const api = isPlainObject(profile?.quality?.api) ? profile.quality.api : {};
  const openapi = typeof api.openapi === "string" ? api.openapi : "";
  if (!openapi) {
    return {
      gate: "api",
      status: "skipped",
      blocking: false,
      applicable: false,
      findings: [],
      evidence: "sin contrato OpenAPI",
      duration_ms: 0,
      skipped_reason: "no hay contrato OpenAPI en el perfil",
      network: null,
    };
  }
  const validator = typeof api.validator === "string" ? api.validator.trim() : "";
  if (validator) return shellGate(deps, context, project, "api", validator);
  if (!openapi.toLowerCase().endsWith(".json")) {
    return {
      gate: "api",
      status: "skipped",
      blocking: false,
      applicable: true,
      findings: [],
      evidence: "OpenAPI YAML sin validador",
      duration_ms: 0,
      skipped_reason: "OpenAPI YAML requiere un validador configurado",
      network: null,
    };
  }
  const path = resolve(project.directory, openapi);
  if (!inside(project.directory, path) || !existsSync(path)) {
    return {
      gate: "api",
      status: "fail",
      blocking: false,
      applicable: true,
      findings: [{ file: openapi, line: null, severity: "medium", rule: "api.openapi", message: "No existe el contrato OpenAPI indicado." }],
      evidence: "archivo ausente",
      duration_ms: 0,
      skipped_reason: null,
      network: null,
    };
  }
  try {
    const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const valid = isPlainObject(document) && (typeof document.openapi === "string" || typeof document.swagger === "string") && isPlainObject(document.info) && isPlainObject(document.paths);
    return {
      gate: "api",
      status: valid ? "pass" : "fail",
      blocking: false,
      applicable: true,
      findings: valid ? [] : [{ file: openapi, line: null, severity: "medium", rule: "api.openapi", message: "OpenAPI inválido: faltan openapi/swagger, info o paths." }],
      evidence: valid ? "JSON OpenAPI válido" : "JSON OpenAPI inválido",
      duration_ms: 0,
      skipped_reason: null,
      network: null,
    };
  } catch (error) {
    return {
      gate: "api",
      status: "fail",
      blocking: false,
      applicable: true,
      findings: [{ file: openapi, line: null, severity: "medium", rule: "api.openapi", message: `JSON inválido: ${error instanceof Error ? error.message : String(error)}` }],
      evidence: "JSON inválido",
      duration_ms: 0,
      skipped_reason: null,
      network: null,
    };
  }
}

async function migrationsGate(
  deps: GatesToolsDeps,
  context: GateContext,
  project: ProjectRef,
  profile: FactoryProfile | null,
): Promise<GateResult> {
  const migrations = isPlainObject(profile?.quality?.migrations) ? profile.quality.migrations : {};
  const up = typeof migrations.up === "string" ? migrations.up.trim() : "";
  const down = typeof migrations.down === "string" ? migrations.down.trim() : "";
  if (!up || !down) {
    return {
      gate: "migrations",
      status: "skipped",
      blocking: false,
      applicable: false,
      findings: [],
      evidence: "sin comandos up/down",
      duration_ms: 0,
      skipped_reason: "no hay migraciones up/down configuradas",
      network: null,
    };
  }
  const envName = typeof migrations.databaseUrlEnv === "string" ? migrations.databaseUrlEnv : "FACTORY_TEST_DATABASE_URL";
  const databaseUrl = process.env[envName];
  if (!databaseUrl) {
    return {
      gate: "migrations",
      status: "skipped",
      blocking: false,
      applicable: true,
      findings: [],
      evidence: `falta ${envName}`,
      duration_ms: 0,
      skipped_reason: `falta la variable ${envName}`,
      network: null,
    };
  }
  try {
    const url = new URL(databaseUrl);
    const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    const disposable = /(test|tmp|ci|sandbox)/i.test(url.pathname);
    if (!local || !disposable) {
      return {
        gate: "migrations",
        status: "error",
        blocking: false,
        applicable: true,
        findings: [{ file: "env", line: null, severity: "critical", rule: "migrations.guard", message: "La DB de pruebas no es local o no parece descartable; no se ejecutó." }],
        evidence: "guard de DB descartable",
        duration_ms: 0,
        skipped_reason: null,
        network: null,
      };
    }
  } catch {
    return {
      gate: "migrations",
      status: "error",
      blocking: false,
      applicable: true,
      findings: [{ file: "env", line: null, severity: "critical", rule: "migrations.guard", message: "FACTORY_TEST_DATABASE_URL no es una URL válida." }],
      evidence: "URL inválida",
      duration_ms: 0,
      skipped_reason: null,
      network: null,
    };
  }
  const upResult = await shellGate(deps, context, project, "migrations", up, 240_000);
  if (upResult.status !== "pass") return { ...upResult, gate: "migrations", evidence: `up: ${upResult.evidence}` };
  const downResult = await shellGate(deps, context, project, "migrations", down, 240_000);
  return {
    ...downResult,
    gate: "migrations",
    evidence: `up: ${upResult.evidence} · down: ${downResult.evidence}`,
  };
}

async function phpSyntaxGate(
  deps: GatesToolsDeps,
  context: GateContext,
  project: ProjectRef,
): Promise<GateResult> {
  let files = (await getChangedFiles(project.directory)).filter((file) => file.endsWith(".php"));
  if (files.length === 0) {
    const tracked = await runCommand("git ls-files '*.php'", project.directory, 15_000);
    files = tracked.exitCode === 0
      ? tracked.stdout.split(/\r?\n/).map((file) => file.trim()).filter((file) => file.endsWith(".php"))
      : [];
  }
  files = files.slice(0, 50);
  if (files.length === 0) {
    return {
      gate: "lint",
      status: "skipped",
      blocking: false,
      applicable: true,
      findings: [],
      evidence: "sin archivos PHP",
      duration_ms: 0,
      skipped_reason: "no hay archivos PHP para php -l",
      network: null,
    };
  }
  const command = files.map((file) => `php -l ${shellQuote(file)}`).join(" && ");
  return shellGate(deps, context, project, "lint", command, 120_000, true);
}

async function slowGate(
  deps: GatesToolsDeps,
  context: GateContext,
  project: ProjectRef,
  profile: FactoryProfile | null,
  gate: "mutation" | "performance",
  includeSlow: boolean,
): Promise<GateResult> {
  const configured = commandOf(profile?.quality?.[gate]);
  if (!includeSlow) {
    return {
      gate,
      status: "skipped",
      blocking: false,
      applicable: false,
      findings: [],
      evidence: "solo bajo petición",
      duration_ms: 0,
      skipped_reason: "compuerta lenta; usa include_slow=true",
      network: null,
    };
  }
  if (!configured) {
    return {
      gate,
      status: "skipped",
      blocking: false,
      applicable: false,
      findings: [],
      evidence: "sin comando configurado",
      duration_ms: 0,
      skipped_reason: "no hay comando configurado",
      network: null,
    };
  }
  return shellGate(deps, context, project, gate, configured, 600_000);
}

async function runGate(
  deps: GatesToolsDeps,
  context: GateContext,
  project: ProjectRef,
  profile: FactoryProfile | null,
  gate: GateName,
  includeSlow: boolean,
): Promise<GateResult> {
  switch (gate) {
    case "format":
      return shellGate(deps, context, project, gate, commandOf(profile?.quality?.format));
    case "lint": {
      if (profile?.commands?.lint) {
        return shellGate(deps, context, project, gate, profile.commands.lint, 180_000, true);
      }
      const languages = Array.isArray(profile?.stack?.languages) ? profile.stack.languages : [];
      const phpSyntax = isPlainObject(profile?.quality) && profile.quality.phpSyntax === true;
      if (languages.includes("php") && phpSyntax) {
        return phpSyntaxGate(deps, context, project);
      }
      return shellGate(deps, context, project, gate, null, 180_000, true);
    }
    case "typecheck":
      return shellGate(deps, context, project, gate, profile?.commands?.typecheck ?? null, 180_000, true);
    case "build":
      return shellGate(deps, context, project, gate, profile?.commands?.build ?? null, 300_000, false);
    case "test":
      return shellGate(deps, context, project, gate, profile?.commands?.test ?? null, 240_000, true);
    case "coverage":
      return coverageGate(deps, context, project, profile);
    case "security":
      return securityGate(deps, context, project, profile);
    case "dependencies":
      return dependenciesGate(deps, context, project, profile);
    case "static":
      return shellGate(deps, context, project, gate, commandOf(profile?.quality?.static));
    case "e2e":
      return shellGate(deps, context, project, gate, commandOf(profile?.quality?.e2e), 300_000);
    case "accessibility":
      return shellGate(deps, context, project, gate, commandOf(profile?.quality?.accessibility), 300_000);
    case "api":
      return apiGate(deps, context, project, profile);
    case "migrations":
      return migrationsGate(deps, context, project, profile);
    case "mutation":
    case "performance":
      return slowGate(deps, context, project, profile, gate, includeSlow);
  }
}

function applyPolicy(result: GateResult, policy: ReturnType<typeof policyFor>): GateResult {
  if (result.status === "pass") return { ...result, blocking: false };
  if (result.status === "error") return { ...result, blocking: policy.blocking[result.gate] ?? false };
  if (result.status === "skipped") {
    return { ...result, blocking: result.applicable ? (policy.blocking[result.gate] ?? false) : false };
  }
  if (result.gate === "security") {
    const severe = result.findings.some((finding) => policy.severity[finding.severity] === true);
    return { ...result, blocking: (policy.blocking.security ?? false) && severe };
  }
  return { ...result, blocking: policy.blocking[result.gate] ?? false };
}

function applyBaseline(result: GateResult, baselineGate: Record<string, unknown> | null): GateResult {
  const findings = result.findings.map((finding) => ({ ...finding }));
  if (!baselineGate) {
    return { ...result, findings: findings.map((finding) => ({ ...finding, new: true })), new_findings: findings.length, debt_findings: 0 };
  }
  const counts = isPlainObject(baselineGate.findings) ? baselineGate.findings : {};
  const used: Record<string, number> = {};
  let newCount = 0;
  let debtCount = 0;
  for (const finding of findings) {
    const key = fingerprint(finding);
    const allowed = Number(counts[key] ?? 0);
    if ((used[key] ?? 0) < allowed) {
      used[key] = (used[key] ?? 0) + 1;
      finding.debt = true;
      debtCount += 1;
    } else {
      finding.new = true;
      newCount += 1;
    }
  }
  const baselineStatus = String(baselineGate.status ?? "");
  const baselineReason = String(baselineGate.skipped_reason ?? result.skipped_reason ?? "");
  const debtOnly =
    (baselineStatus === "fail" && result.status === "fail" && newCount === 0) ||
    (baselineStatus === "skipped" && result.status === "skipped" && baselineReason === String(result.skipped_reason ?? ""));
  return {
    ...result,
    findings,
    new_findings: newCount,
    debt_findings: debtCount,
    blocking: debtOnly ? false : result.blocking,
    evidence: debtOnly ? `${result.evidence} · deuda de baseline` : result.evidence,
  };
}

export function createGatesTools(deps: GatesToolsDeps): ToolDef[] {
  return [
    {
      name: "run_gates",
      description:
        "Ejecuta las compuertas de calidad aplicables, las compara con la línea base y registra gate_runs. Devuelve pass/fail/skipped/error por compuerta.",
      input: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "UUID de la tarea." },
          iteration: { type: "integer", minimum: 1, maximum: 3, default: 1 },
          mode: { type: "string", enum: ["check", "baseline"], default: "check" },
          gates: {
            type: "array",
            items: { type: "string", enum: GATE_ORDER },
            description: "Subconjunto de compuertas. Default: todas las rápidas.",
          },
          include_slow: { type: "boolean", default: false },
          base: { type: "string", description: "Rama base para diff; default del perfil o main." },
        },
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const profile = await deps.db.getProfile(project.projectId);
        if (!profile) return fail("No hay perfil del proyecto. Ejecuta onboarding y project_profile_set primero.");

        const gateContext: GateContext = {
          sessionID: String(context.sessionID),
          agent: context.agent,
          messageID: String(context.messageID),
          id: String(context.id),
        };
        const mode = input.mode === "baseline" ? "baseline" : "check";
        const iteration = typeof input.iteration === "number" ? Math.round(input.iteration) : 1;
        if (iteration < 1 || iteration > 3) return fail("iteration debe estar entre 1 y 3.");

        let taskId: string | null = null;
        if (typeof input.task_id === "string" && input.task_id.trim()) {
          const task = await deps.db.getTask(project.projectId, input.task_id.trim());
          if (!task) return fail("La tarea no existe en este proyecto.");
          if (task.status === "done" || task.status === "cancelled") return fail("La tarea ya está cerrada.");
          taskId = task.id;
        }

        const requestedRaw = Array.isArray(input.gates) ? input.gates : DEFAULT_GATES;
        const requested: GateName[] = [];
        for (const value of requestedRaw) {
          if (typeof value !== "string" || !(GATE_ORDER as string[]).includes(value)) {
            return fail(`Compuerta inválida: ${String(value)}.`);
          }
          if (!requested.includes(value as GateName)) requested.push(value as GateName);
        }
        if (input.include_slow === true) {
          for (const gate of ["mutation", "performance"] as const) {
            if (!requested.includes(gate)) requested.push(gate);
          }
        }
        requested.sort((left, right) => GATE_ORDER.indexOf(left) - GATE_ORDER.indexOf(right));

        const policy = policyFor(profile);
        const baseline = isPlainObject(profile.baseline) ? profile.baseline : {};
        const baselineGates = isPlainObject(baseline.gates) ? baseline.gates : {};
        const results: GateResult[] = [];

        for (const gate of requested) {
          let result = await runGate(deps, gateContext, project, profile, gate, input.include_slow === true);
          result = applyPolicy(result, policy);
          if (mode === "check") {
            result = applyBaseline(result, isPlainObject(baselineGates[gate]) ? (baselineGates[gate] as Record<string, unknown>) : null);
          } else {
            result = { ...result, blocking: false };
          }
          results.push(result);
        }

        const blockingFailures = results.filter((result) => result.blocking && (result.status === "fail" || result.status === "error"));
        const blockingSkipped = results.filter((result) => result.blocking && result.status === "skipped");
        const warnings = results.filter((result) => !result.blocking && (result.status === "fail" || result.status === "error" || result.status === "skipped"));
        const status = blockingFailures.length > 0 ? "fail" : blockingSkipped.length > 0 ? "incomplete" : "pass";
        const summary = `${results.filter((result) => result.status === "pass").length} pass, ${results.filter((result) => result.status === "fail").length} fail, ${results.filter((result) => result.status === "skipped").length} skipped, ${results.filter((result) => result.status === "error").length} error`;

        const branch = await getCurrentBranch(project.directory).catch(() => null);
        const headResult = await runCommand("git rev-parse HEAD", project.directory, 10_000).catch(() => null);
        const commit = headResult && headResult.exitCode === 0 ? headResult.stdout.trim() : null;

        if (mode === "baseline") {
          const coverageResult = results.find((result) => result.gate === "coverage");
          const currentCoverage = isPlainObject(coverageResult?.metrics) ? coverageResult.metrics : {};
          const savedBaseline = {
            saved_at: new Date().toISOString(),
            coverage: {
              total: typeof currentCoverage.total === "number" ? currentCoverage.total : null,
              changed: typeof currentCoverage.changed === "number" ? currentCoverage.changed : null,
            },
            gates: Object.fromEntries(results.map((result) => [
              result.gate,
              {
                status: result.status,
                findings: findingCounts(result.findings),
                skipped_reason: result.skipped_reason,
              },
            ])),
            summary,
          };
          await deps.db.setBaseline(project.projectId, savedBaseline);
          await deps.db.createGateRun({
            projectId: project.projectId,
            taskId,
            iteration,
            mode,
            status: "pass",
            gates: results,
            summary,
            blockingFailures: [],
            warnings: warnings.map((result) => ({ gate: result.gate, status: result.status, reason: result.skipped_reason })),
            gitBranch: branch,
            gitCommit: commit,
          });
          return ok({
            ok: true,
            status: "pass",
            mode,
            baseline_saved: true,
            summary,
            gates: results,
            baseline: savedBaseline,
          });
        }

        const gateRun = await deps.db.createGateRun({
          projectId: project.projectId,
          taskId,
          iteration,
          mode,
          status,
          gates: results,
          summary,
          blockingFailures: blockingFailures.map((result) => ({ gate: result.gate, status: result.status })),
          warnings: warnings.map((result) => ({ gate: result.gate, status: result.status, reason: result.skipped_reason })),
          gitBranch: branch,
          gitCommit: commit,
        });

        return ok({
          ok: status === "pass",
          status,
          mode,
          task_id: taskId,
          iteration,
          gate_run_id: gateRun.id,
          summary,
          blocking_failures: blockingFailures.map((result) => ({ gate: result.gate, status: result.status })),
          skipped_blocking: blockingSkipped.map((result) => ({ gate: result.gate, reason: result.skipped_reason })),
          warnings: warnings.map((result) => ({ gate: result.gate, status: result.status, reason: result.skipped_reason })),
          gates: results,
        });
      },
    },
    {
      name: "quality_policy_set",
      description: "Cambia la política de compuertas del proyecto. Requiere confirmed=true tras aprobación explícita del usuario.",
      input: {
        type: "object",
        properties: {
          policy: { type: "object", additionalProperties: true },
          confirmed: { type: "boolean" },
        },
        required: ["policy", "confirmed"],
        additionalProperties: false,
      },
      async execute(input, context) {
        if (input.confirmed !== true) {
          return fail("Cambiar la política requiere confirmación explícita del usuario (confirmed=true).");
        }
        const policy = isPlainObject(input.policy) ? input.policy : null;
        if (!policy) return fail("policy debe ser un objeto.");
        const project = await deps.resolveProject(String(context.sessionID));
        const profile = await deps.db.getProfile(project.projectId);
        if (!profile) return fail("No hay perfil del proyecto.");
        const quality = { ...(profile.quality ?? {}), policy };
        const updated = await deps.db.setQuality(project.projectId, quality);
        return ok({ updated: true, policy: updated?.quality?.policy ?? policy });
      },
    },
  ];
}

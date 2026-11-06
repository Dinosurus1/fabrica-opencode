/**
 * Tool security_scan.
 *
 * Qué hace: ejecuta los escáneres de seguridad disponibles (semgrep, gitleaks,
 * osv-scanner, trivy) sobre el proyecto o un subdirectorio, y devuelve hallazgos
 * resumidos. Reporta el modo offline/online y la red que necesita cada escáner.
 * No instala nada. Si falta un binario, lo marca como `missing`; si falta una
 * caché offline, lo marca como `skipped` con la razón.
 *
 * Qué accede: archivos del proyecto, binarios del PATH, cachés locales de OSV/
 * Trivy y procesos hijos. Ejecuta comandos con el shell del usuario, por lo que
 * SIEMPRE llama antes a `ctx.permission.assert` con la acción `shell`. Nunca
 * devuelve secretos crudos: gitleaks se ejecuta con `--redact` y solo se
 * conservan regla, archivo y línea.
 */

import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { FactoryDb, FactoryProfile, ProjectRef } from "./db.js";
import { redact, runCommand, shellQuote, stripAnsi, tail } from "./exec.js";
import { fail, ok, type ToolDef } from "./types.js";

export interface SecurityToolsDeps {
  db: FactoryDb;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
  permission: { assert: (input: Record<string, unknown>) => Promise<void> };
}

const SCANNERS = ["semgrep", "gitleaks", "osv-scanner", "trivy"] as const;
type ScannerName = (typeof SCANNERS)[number];
type ScanMode = "offline" | "online" | "auto";

type Severity = "critical" | "high" | "medium" | "low" | "unknown";

interface SecurityFinding {
  scanner: ScannerName;
  severity: Severity;
  file: string;
  line: number | null;
  rule: string;
  message: string;
}

interface ScannerResult {
  scanner: ScannerName;
  status: "ok" | "findings" | "missing" | "error" | "timeout" | "skipped";
  durationMs: number;
  findings: SecurityFinding[];
  error: string | null;
  hint?: string;
  skippedReason?: string;
  network: "none" | "rules-fetch" | "api" | "db-download";
  config?: string;
}

const SCANNER_HINTS: Record<ScannerName, string> = {
  semgrep: "Instálalo con tu gestor de paquetes o `uv tool install semgrep`.",
  gitleaks: "Instálalo desde el release oficial o el paquete de tu distribución.",
  "osv-scanner": "Instálalo desde el release oficial de OSV-Scanner o el paquete de tu distribución.",
  trivy: "Instálalo desde el release oficial de Trivy o el paquete de tu distribución.",
};

const DEPENDENCY_MANIFESTS = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "requirements.txt",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "packages.lock.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

const STACK_PACKS: Record<string, string> = {
  javascript: "p/javascript",
  typescript: "p/javascript",
  python: "p/python",
  php: "p/php",
  java: "p/java",
  ruby: "p/ruby",
  go: "p/golang",
  rust: "p/rust",
  csharp: "p/csharp",
  "c#": "p/csharp",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeFile(file: string, root: string): string {
  const clean = file.replace(/^["']|["']$/g, "").trim();
  const absolute = isAbsolute(clean) ? clean : resolve(root, clean);
  return inside(root, absolute) ? relative(root, absolute) || clean : clean;
}

function safeMessage(value: unknown): string {
  return redact(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function severityFrom(value: unknown): Severity {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("critical") || text.includes("crítico") || text.includes("critico")) return "critical";
  if (text.includes("high") || text.includes("alto") || text === "error") return "high";
  if (text.includes("medium") || text.includes("medio") || text.includes("moderate") || text === "warning") return "medium";
  if (text.includes("low") || text.includes("bajo") || text === "info") return "low";
  return "unknown";
}

function severityFromScore(value: unknown): Severity {
  const score = Number(value);
  if (!Number.isFinite(score)) return "unknown";
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "unknown";
}

function findExecutable(name: string): string | null {
  const path = process.env.PATH ?? "";
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Sigue buscando.
    }
  }
  return null;
}

function cacheRoot(): string {
  return process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
}

function osvOfflineReady(): boolean {
  const directory = join(cacheRoot(), "osv-scalibr");
  if (!existsSync(directory)) return false;
  const findDatabase = (path: string, depth: number): boolean => {
    if (depth > 3) return false;
    try {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith(".zip") || entry.name.endsWith(".db"))) return true;
        if (entry.isDirectory() && findDatabase(join(path, entry.name), depth + 1)) return true;
      }
    } catch {
      return false;
    }
    return false;
  };
  return findDatabase(directory, 0);
}

function trivyOfflineReady(): boolean {
  return existsSync(join(cacheRoot(), "trivy", "db", "trivy.db"));
}

function findManifest(directory: string, depth = 0): string | null {
  if (depth > 3) return null;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === ".git" || entry.name.startsWith(".")) {
      continue;
    }
    if (entry.isFile() && DEPENDENCY_MANIFESTS.has(entry.name)) return join(directory, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === ".git" || entry.name.startsWith(".")) {
      continue;
    }
    const found = findManifest(join(directory, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function hasIac(directory: string): boolean {
  for (const file of ["Dockerfile", "docker-compose.yml", "compose.yml", "terraform.tf", "main.tf"]) {
    if (existsSync(join(directory, file))) return true;
  }
  return false;
}

async function resolveTarget(root: string, rawPath: unknown): Promise<string> {
  const requested = typeof rawPath === "string" && rawPath.trim() ? rawPath.trim() : ".";
  const candidate = resolve(root, requested);
  const realRoot = await realpath(root).catch(() => root);
  const realCandidate = await realpath(candidate).catch(() => candidate);
  if (!inside(realRoot, realCandidate)) {
    throw new Error("La ruta indicada queda fuera del proyecto; solo se permite escanear el proyecto actual.");
  }
  return realCandidate;
}

function rulesDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "factory", "rules");
}

function bundledRulesPath(): string {
  return join(rulesDirectory(), "semgrep.yml");
}

function stackPackIds(profile: FactoryProfile | null): string[] {
  const languages = Array.isArray(profile?.stack?.languages)
    ? profile.stack.languages.filter((value): value is string => typeof value === "string")
    : [];
  return [...new Set(languages.map((language) => STACK_PACKS[language.toLowerCase()]).filter(Boolean))];
}

function semgrepConfig(profile: FactoryProfile | null, mode: ScanMode): {
  configs: string[];
  network: "none" | "rules-fetch";
  label: string;
} {
  const bundled = bundledRulesPath();
  const stackPacks = stackPackIds(profile);
  if (mode === "offline") {
    const vendored = ["default.yml", "owasp-top-ten.yml", ...stackPacks.map((pack) => `${pack.replace(/^p\//, "")}.yml`)]
      .map((file) => join(rulesDirectory(), "packs", file))
      .filter((file) => existsSync(file));
    return {
      configs: [...new Set([...vendored, ...(existsSync(bundled) ? [bundled] : [])])],
      network: "none",
      label: "vendored-packs+bundled",
    };
  }

  const configs = [...new Set(["p/default", "p/owasp-top-ten", ...stackPacks, bundled])];
  return { configs, network: "rules-fetch", label: "registry-packs+bundled" };
}

function scannerCommand(
  name: ScannerName,
  target: string,
  options: {
    mode: ScanMode;
    profile: FactoryProfile | null;
    includeIac: boolean;
    trivyDbReady: boolean;
    gitleaksReportPath?: string;
  },
): { command: string; network: ScannerResult["network"]; config?: string; skip?: string } {
  switch (name) {
    case "semgrep": {
      const semgrep = semgrepConfig(options.profile, options.mode);
      if (semgrep.configs.length === 0) {
        return {
          command: "",
          network: "none",
          skip: "No hay reglas Semgrep locales disponibles.",
        };
      }
      const configs = semgrep.configs.map((config) => `--config ${shellQuote(config)}`).join(" ");
      return {
        command: `semgrep scan --json --quiet --metrics=off --disable-version-check --max-target-bytes 1000000 ${configs} ${shellQuote(target)}`,
        network: semgrep.network,
        config: semgrep.label,
      };
    }
    case "gitleaks": {
      if (!options.gitleaksReportPath) {
        return { command: "", network: "none", skip: "Falta la ruta temporal para el informe de gitleaks." };
      }
      return {
        command: `gitleaks dir ${shellQuote(target)} --no-banner --log-level error --redact --report-format json --report-path ${shellQuote(options.gitleaksReportPath)} --exit-code 0`,
        network: "none",
        config: "default",
      };
    }
    case "osv-scanner": {
      if (!findManifest(target)) {
        return {
          command: "",
          network: "none",
          skip: "No hay lockfile/manifiesto de dependencias compatible en el target.",
        };
      }
      if (options.mode === "offline" && !osvOfflineReady()) {
        return {
          command: "",
          network: "none",
          skip: "Sin base offline de OSV; prepara la caché con `osv-scanner scan source --offline --download-offline-databases -r <repo>`.",
        };
      }
      const offline = options.mode === "offline";
      return {
        command: `osv-scanner scan source ${offline ? "--offline --offline-vulnerabilities" : ""} --format json --verbosity error -r ${shellQuote(target)}`,
        network: offline ? "none" : "api",
        config: offline ? "offline-db" : "api",
      };
    }
    case "trivy": {
      if (options.mode === "offline" && !options.trivyDbReady) {
        return {
          command: "",
          network: "none",
          skip: "Sin DB local de Trivy; prepara la caché con `trivy fs --download-db-only`.",
        };
      }
      const scanners = options.includeIac ? "vuln,secret,misconfig" : "vuln,secret";
      const skipUpdate = options.mode === "offline" || options.trivyDbReady;
      return {
        command: `trivy fs --format json --scanners ${scanners} --quiet ${skipUpdate ? "--skip-db-update" : ""} --offline-scan --timeout 10m ${shellQuote(target)}`,
        network: skipUpdate ? "none" : "db-download",
        config: skipUpdate ? "local-db" : "db-download",
      };
    }
  }
}

function parseSemgrep(raw: string, root: string): SecurityFinding[] {
  const data = JSON.parse(raw) as { results?: unknown };
  const results = Array.isArray(data.results) ? data.results : [];
  const findings: SecurityFinding[] = [];
  for (const item of results) {
    if (!isPlainObject(item)) continue;
    const extra = isPlainObject(item.extra) ? item.extra : {};
    const start = isPlainObject(item.start) ? item.start : {};
    findings.push({
      scanner: "semgrep",
      severity: severityFrom(extra.severity),
      file: normalizeFile(String(item.path ?? "?"), root),
      line: Number(start.line) || null,
      rule: String(item.check_id ?? "semgrep"),
      message: safeMessage(extra.message ?? item.check_id ?? "hallazgo"),
    });
  }
  return findings;
}

function parseGitleaks(raw: string, root: string): SecurityFinding[] {
  const data = JSON.parse(raw) as unknown;
  const list = Array.isArray(data)
    ? data
    : isPlainObject(data) && Array.isArray(data.findings)
      ? data.findings
      : [];
  const findings: SecurityFinding[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    findings.push({
      scanner: "gitleaks",
      severity: severityFrom(item.Severity ?? "high"),
      file: normalizeFile(String(item.File ?? item.file ?? "?"), root),
      line: Number(item.StartLine ?? item.startLine) || null,
      rule: String(item.RuleID ?? item.ruleID ?? "gitleaks"),
      message: safeMessage(item.Description ?? item.description ?? "posible secreto detectado"),
    });
  }
  return findings;
}

function parseOsv(raw: string, root: string): SecurityFinding[] {
  const data = JSON.parse(raw) as { results?: unknown };
  const results = Array.isArray(data.results) ? data.results : [];
  const findings: SecurityFinding[] = [];

  for (const result of results) {
    if (!isPlainObject(result)) continue;
    const source = isPlainObject(result.source) ? String(result.source.path ?? "?") : String(result.source ?? "?");
    const packages = Array.isArray(result.packages) ? result.packages : [];
    for (const pkg of packages) {
      if (!isPlainObject(pkg)) continue;
      const packageInfo = isPlainObject(pkg.package) ? pkg.package : {};
      const packageName = String(packageInfo.name ?? packageInfo.purl ?? "paquete");
      const version = String(packageInfo.version ?? "");
      const groups = Array.isArray(pkg.groups) ? pkg.groups : [];
      const groupSeverity = groups
        .map((group) => (isPlainObject(group) ? severityFromScore(group.max_severity) : "unknown"))
        .sort((left, right) => {
          const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
          return rank[left] - rank[right];
        })[0] ?? "unknown";

      for (const vulnerability of Array.isArray(pkg.vulnerabilities) ? pkg.vulnerabilities : []) {
        if (!isPlainObject(vulnerability)) continue;
        const database = isPlainObject(vulnerability.database_specific) ? vulnerability.database_specific : {};
        const fromDatabase = severityFrom(database.severity);
        const severity = fromDatabase !== "unknown" ? fromDatabase : groupSeverity;
        findings.push({
          scanner: "osv-scanner",
          severity,
          file: normalizeFile(source, root),
          line: null,
          rule: String(vulnerability.id ?? "OSV"),
          message: safeMessage(
            `${packageName}${version ? `@${version}` : ""}: ${vulnerability.summary ?? vulnerability.id ?? "vulnerabilidad"}`,
          ),
        });
      }
    }
    for (const vulnerability of Array.isArray(result.vulnerabilities) ? result.vulnerabilities : []) {
      if (!isPlainObject(vulnerability)) continue;
      const database = isPlainObject(vulnerability.database_specific) ? vulnerability.database_specific : {};
      findings.push({
        scanner: "osv-scanner",
        severity: severityFrom(database.severity),
        file: normalizeFile(source, root),
        line: null,
        rule: String(vulnerability.id ?? "OSV"),
        message: safeMessage(vulnerability.summary ?? vulnerability.id ?? "vulnerabilidad"),
      });
    }
  }
  return findings;
}

function parseTrivy(raw: string, root: string): SecurityFinding[] {
  const data = JSON.parse(raw) as { Results?: unknown };
  const results = Array.isArray(data.Results) ? data.Results : [];
  const findings: SecurityFinding[] = [];
  for (const result of results) {
    if (!isPlainObject(result)) continue;
    const target = String(result.Target ?? "?");
    for (const vulnerability of Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities : []) {
      if (!isPlainObject(vulnerability)) continue;
      findings.push({
        scanner: "trivy",
        severity: severityFrom(vulnerability.Severity),
        file: normalizeFile(target, root),
        line: null,
        rule: String(vulnerability.VulnerabilityID ?? "trivy"),
        message: safeMessage(
          `${vulnerability.PkgName ?? "paquete"} ${vulnerability.InstalledVersion ?? ""}: ${vulnerability.Title ?? vulnerability.VulnerabilityID ?? "vulnerabilidad"}`,
        ),
      });
    }
    for (const secret of Array.isArray(result.Secrets) ? result.Secrets : []) {
      if (!isPlainObject(secret)) continue;
      findings.push({
        scanner: "trivy",
        severity: severityFrom(secret.Severity),
        file: normalizeFile(target, root),
        line: Number(secret.StartLine) || null,
        rule: String(secret.RuleID ?? "secret"),
        message: safeMessage(secret.Title ?? "posible secreto detectado"),
      });
    }
    for (const misconfiguration of Array.isArray(result.Misconfigurations) ? result.Misconfigurations : []) {
      if (!isPlainObject(misconfiguration)) continue;
      if (String(misconfiguration.Status ?? "").toUpperCase() === "PASS") continue;
      const cause = isPlainObject(misconfiguration.CauseMetadata) ? misconfiguration.CauseMetadata : {};
      findings.push({
        scanner: "trivy",
        severity: severityFrom(misconfiguration.Severity),
        file: normalizeFile(target, root),
        line: Number(cause.StartLine) || null,
        rule: String(misconfiguration.ID ?? "misconfig"),
        message: safeMessage(misconfiguration.Title ?? misconfiguration.ID ?? "misconfiguración"),
      });
    }
  }
  return findings;
}

function parseScanner(name: ScannerName, raw: string, root: string): SecurityFinding[] {
  switch (name) {
    case "semgrep":
      return parseSemgrep(raw, root);
    case "gitleaks":
      return parseGitleaks(raw, root);
    case "osv-scanner":
      return parseOsv(raw, root);
    case "trivy":
      return parseTrivy(raw, root);
  }
}

interface SecurityScanContext {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
}

export type SecurityScanOutcome = Record<string, unknown> | { error: string };

export async function runSecurityScan(
  deps: SecurityToolsDeps,
  project: ProjectRef,
  input: { target?: unknown; scanners?: unknown; mode?: unknown },
  context: SecurityScanContext,
): Promise<SecurityScanOutcome> {
  const failScan = (message: string): { error: string } => ({ error: message });
        let target: string;
        try {
          target = await resolveTarget(project.directory, input.target);
        } catch (error) {
          return failScan(error instanceof Error ? error.message : String(error));
        }

        const requestedRaw = Array.isArray(input.scanners) ? input.scanners : SCANNERS;
        const requested: ScannerName[] = [];
        for (const value of requestedRaw) {
          if (typeof value !== "string" || !(SCANNERS as readonly string[]).includes(value)) {
            return failScan(`Escáner inválido: ${String(value)}. Valores: ${SCANNERS.join(", ")}.`);
          }
          if (!requested.includes(value as ScannerName)) requested.push(value as ScannerName);
        }

        const rawMode = typeof input.mode === "string" ? input.mode : "offline";
        if (!["offline", "online", "auto"].includes(rawMode)) {
          return failScan("mode debe ser offline, online o auto.");
        }
        const mode: ScanMode = rawMode as ScanMode;
        const effectiveMode: ScanMode = mode === "auto" ? "online" : mode;
        const profile = await deps.db.getProfile(project.projectId);
        const includeIac = hasIac(target);
        const trivyDbReady = trivyOfflineReady();

        const results: ScannerResult[] = [];
        const warnings: string[] = [];

        for (const name of requested) {
          const started = Date.now();
          const executable = findExecutable(name);
          if (!executable) {
            const hint = SCANNER_HINTS[name];
            warnings.push(`${name} no está instalado. ${hint}`);
            results.push({
              scanner: name,
              status: "missing",
              durationMs: 0,
              findings: [],
              error: null,
              hint,
              network: "none",
            });
            continue;
          }

          let tempDir: string | null = null;
          let gitleaksReportPath: string | undefined;
          if (name === "gitleaks") {
            tempDir = await mkdtemp(join(tmpdir(), "opencode-gitleaks-"));
            gitleaksReportPath = join(tempDir, "report.json");
          }

          try {
            const plan = scannerCommand(name, target, {
              mode: effectiveMode,
              profile,
              includeIac,
              trivyDbReady,
              gitleaksReportPath,
            });

            if (plan.skip) {
              warnings.push(`${name} omitido: ${plan.skip}`);
              results.push({
                scanner: name,
                status: "skipped",
                durationMs: 0,
                findings: [],
                error: null,
                skippedReason: plan.skip,
                network: plan.network,
                config: plan.config,
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
              resources: [plan.command],
              save: [plan.command],
              metadata: { tool: "security_scan", scanner: name, mode: effectiveMode },
            });

            const timeout = name === "trivy" ? 600_000 : 300_000;
            const result = await runCommand(plan.command, project.directory, timeout);
            let raw = result.stdout || result.stderr;

            if (name === "gitleaks" && gitleaksReportPath) {
              try {
                raw = await readFile(gitleaksReportPath, "utf8");
              } catch {
                // Si no hay informe, usamos stdout/stderr para diagnosticar.
                raw = result.stdout || result.stderr;
              }
            }

            let findings: SecurityFinding[] = [];
            let status: ScannerResult["status"];
            let error: string | null = null;
            let skippedReason: string | undefined;

            if (result.timedOut) {
              status = "timeout";
              error = `timeout tras ${result.durationMs} ms`;
            } else if (result.error) {
              status = "error";
              error = result.error;
            } else if (
              name === "osv-scanner" &&
              /No package sources found|found 0 packages/i.test(raw)
            ) {
              status = "skipped";
              skippedReason = "sin paquetes en el lockfile; OSV no tiene nada que consultar.";
            } else if (!raw.trim()) {
              status = result.exitCode === 0 ? "ok" : "error";
              error = result.exitCode === 0 ? null : `exit ${result.exitCode} sin salida JSON`;
            } else {
              try {
                findings = parseScanner(name, raw, project.directory);
                status = findings.length > 0 ? "findings" : "ok";
              } catch (parseError) {
                status = "error";
                error = `no se pudo parsear la salida JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
              }
            }

            if (status === "error" && raw.trim()) {
              warnings.push(`${name} falló: ${tail(raw, 500)}`);
            }
            if (skippedReason) warnings.push(`${name} omitido: ${skippedReason}`);

            results.push({
              scanner: name,
              status,
              durationMs: result.durationMs,
              findings,
              error,
              skippedReason,
              network: plan.network,
              config: plan.config,
            });
          } finally {
            if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
          }
        }

        const findings = results
          .flatMap((result) => result.findings)
          .sort((left, right) => {
            const rank: Record<Severity, number> = {
              critical: 0,
              high: 1,
              medium: 2,
              low: 3,
              unknown: 4,
            };
            return rank[left.severity] - rank[right.severity];
          })
          .slice(0, 50);

        const available = results.filter((result) => result.status !== "missing").map((result) => result.scanner);
        const missing = results.filter((result) => result.status === "missing").map((result) => result.scanner);
        const skipped = results.filter((result) => result.status === "skipped").map((result) => result.scanner);
        const errors = results.filter((result) => result.status === "error" || result.status === "timeout");
        const complete = results.every((result) => result.status === "ok" || result.status === "findings");
        const counts = findings.reduce<Record<string, number>>((accumulator, finding) => {
          accumulator[finding.severity] = (accumulator[finding.severity] ?? 0) + 1;
          return accumulator;
        }, {});

        return {
          ok: errors.length === 0,
          complete,
          mode: effectiveMode,
          target: relative(project.directory, target) || ".",
          available,
          missing,
          skipped,
          summary:
            findings.length > 0
              ? `${findings.length} hallazgo(s); disponibles: ${available.join(", ") || "ninguno"}; faltan: ${missing.join(", ") || "ninguno"}${skipped.length ? `; omitidos: ${skipped.join(", ")}` : ""}`
              : `Sin hallazgos; disponibles: ${available.join(", ") || "ninguno"}; faltan: ${missing.join(", ") || "ninguno"}${skipped.length ? `; omitidos: ${skipped.join(", ")}` : ""}`,
          counts,
          warnings,
          scanners: results.map((result) => ({
            scanner: result.scanner,
            status: result.status,
            durationMs: result.durationMs,
            findings: result.findings.length,
            error: result.error,
            hint: result.hint,
            skipped_reason: result.skippedReason,
            network: result.network,
            config: result.config,
          })),
          findings,
        };
}

export function createSecurityTools(deps: SecurityToolsDeps): ToolDef[] {
  return [
    {
      name: "security_scan",
      description:
        "Ejecuta semgrep, gitleaks, osv-scanner y trivy en modo offline/online. Devuelve hallazgos, red usada y escáneres ausentes.",
      input: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Ruta dentro del proyecto.",
          },
          scanners: {
            type: "array",
            items: { type: "string", enum: SCANNERS },
            description: "Escáneres a ejecutar; default: todos.",
          },
          mode: {
            type: "string",
            enum: ["offline", "online", "auto"],
            default: "offline",
            description: "offline usa reglas/cachés locales; online permite red.",
          },
        },
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const result = await runSecurityScan(deps, project, input, {
          sessionID: String(context.sessionID),
          agent: context.agent,
          messageID: String(context.messageID),
          id: String(context.id),
        });
        if (Object.prototype.hasOwnProperty.call(result, "error")) {
          return fail(String((result as { error: unknown }).error));
        }
        return ok(result);
      },
    },
  ];
}

/**
 * Tools review_submit y task_close.
 *
 * Qué hacen:
 *  - review_submit: guarda el veredicto estructurado de un revisor en
 *    `review_runs` (no texto libre).
 *  - task_close: exige gate_run en verde, revisiones aprobadas, criterios con
 *    evidencia, memoria existente y rama no protegida; guarda el informe de
 *    cierre en la tarea.
 *
 * Qué acceden: PostgreSQL (`tasks`, `gate_runs`, `review_runs`, `memories`) y
 * el repositorio git para comprobar la rama. No ejecutan comandos de escritura.
 */

import type { FactoryDb, FactoryProfile, ProjectRef, ReviewUsage, TokenUsage } from "./db.js";
import { runCommand, shellQuote } from "./exec.js";
import { getCurrentBranch, getProtectedBranches } from "./git.js";
import { fail, looksLikeSecret, ok, type ToolDef } from "./types.js";
import { captureUsage, emptyUsage, type SessionUsageSnapshot, type UsageDeps } from "./usage.js";

export interface ReviewToolsDeps extends UsageDeps {
  db: FactoryDb;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
}

interface CapturedSessionUsage {
  usage: ReviewUsage;
  model: string;
}

async function captureSessionUsage(
  deps: ReviewToolsDeps,
  sessionID: string,
  declaredModel: string,
  snapshot?: SessionUsageSnapshot | null,
): Promise<CapturedSessionUsage> {
  const current = snapshot === undefined ? await deps.getSessionUsage(sessionID) : snapshot;
  if (!current) {
    return { usage: emptyUsage(sessionID), model: declaredModel || "desconocido" };
  }
  const priceModel = current.model || declaredModel;
  const contextTokens = current.tokens.input + current.tokens.cacheRead + current.tokens.cacheWrite;
  const price = current.costUsd > 0 ? null : await deps.getModelPrice(priceModel, contextTokens);
  return {
    usage: captureUsage(current, price, sessionID),
    model: declaredModel || current.model || "desconocido",
  };
}

interface ReportTokens {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}

function aggregateUsage(entries: Array<{ model: string; role: string; usage: ReviewUsage }>): {
  perModel: Array<{
    model: string;
    roles: string[];
    sessions: string[];
    tokens: ReportTokens;
    cost_usd: number;
    cost_source: "provider" | "catalog" | "unknown" | "mixed";
    cost_basis: string[];
  }>;
  totalTokens: ReportTokens;
  totalCostUsd: number;
} {
  const grouped = new Map<
    string,
    {
      roles: Set<string>;
      sessions: Set<string>;
      tokens: TokenUsage;
      cost: number;
      sources: Set<string>;
      basis: Set<string>;
    }
  >();
  const totalTokens: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let totalCostUsd = 0;

  for (const entry of entries) {
    const model = entry.model || "desconocido";
    const bucket = grouped.get(model) ?? {
      roles: new Set<string>(),
      sessions: new Set<string>(),
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      sources: new Set<string>(),
      basis: new Set<string>(),
    };
    bucket.roles.add(entry.role);
    if (entry.usage.sessionId) bucket.sessions.add(entry.usage.sessionId);
    bucket.tokens.input += entry.usage.tokens.input;
    bucket.tokens.output += entry.usage.tokens.output;
    bucket.tokens.reasoning += entry.usage.tokens.reasoning;
    bucket.tokens.cacheRead += entry.usage.tokens.cacheRead;
    bucket.tokens.cacheWrite += entry.usage.tokens.cacheWrite;
    bucket.cost += entry.usage.costUsd;
    bucket.sources.add(entry.usage.costSource);
    if (entry.usage.costBasis) bucket.basis.add(entry.usage.costBasis);
    grouped.set(model, bucket);

    totalTokens.input += entry.usage.tokens.input;
    totalTokens.output += entry.usage.tokens.output;
    totalTokens.reasoning += entry.usage.tokens.reasoning;
    totalTokens.cacheRead += entry.usage.tokens.cacheRead;
    totalTokens.cacheWrite += entry.usage.tokens.cacheWrite;
    totalCostUsd += entry.usage.costUsd;
  }

  const perModel = Array.from(grouped.entries())
    .map(([model, bucket]) => ({
      model,
      roles: Array.from(bucket.roles).sort(),
      sessions: Array.from(bucket.sessions),
      tokens: reportTokens(bucket.tokens),
      cost_usd: Math.round(bucket.cost * 1_000_000) / 1_000_000,
      cost_source:
        bucket.sources.size === 1
          ? (Array.from(bucket.sources)[0] as "provider" | "catalog" | "unknown")
          : ("mixed" as const),
      cost_basis: Array.from(bucket.basis),
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  return {
    perModel,
    totalTokens: reportTokens(totalTokens),
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
  };
}

function reportTokens(tokens: TokenUsage) {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache_read: tokens.cacheRead,
    cache_write: tokens.cacheWrite,
  };
}

function reportUsage(usage: ReviewUsage) {
  return {
    session_id: usage.sessionId,
    tokens: reportTokens(usage.tokens),
    cost_usd: usage.costUsd,
    cost_source: usage.costSource,
    cost_basis: usage.costBasis,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ["security", "code", "qa"] as const;
type Role = (typeof ROLES)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const CODE_FILE_RE =
  /\.(php|phtml|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|cs|sql|sh|bash|yml|yaml|json|toml|xml|env|conf|ini)$/i;
const DOC_FILE_RE = /\.(md|markdown|rst|txt|adoc)$/i;
const MANIFEST_RE =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.(json|lock)|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|pom\.xml|build\.gradle(\.kts)?|Gemfile(\.lock)?|Dockerfile|docker-compose[^/]*\.ya?ml)$/i;

interface SecurityAssessment {
  applicable: boolean;
  base: string | null;
  categories: string[];
  reasons: string[];
  files: string[];
}

async function resolveBaseBranch(cwd: string, profile: FactoryProfile | null): Promise<string | null> {
  const git = isPlainObject(profile?.conventions?.git) ? profile.conventions.git : {};
  const configured = typeof git.baseBranch === "string" ? git.baseBranch.trim() : "";
  if (configured) return configured;
  for (const candidate of ["main", "master", "develop"]) {
    const result = await runCommand(
      `git rev-parse --verify --quiet ${shellQuote(`refs/heads/${candidate}`)}`,
      cwd,
      10_000,
    );
    if (result.exitCode === 0) return candidate;
  }
  const parent = await runCommand("git rev-parse --verify --quiet HEAD~1", cwd, 10_000);
  return parent.exitCode === 0 ? "HEAD~1" : null;
}

/**
 * Calcula si el diff de la tarea toca superficie sensible. No decide si hay
 * una vulnerabilidad: decide si hace falta revisión de seguridad o una
 * justificación explícita para no pedirla.
 */
async function assessSecurityFromDiff(cwd: string, profile: FactoryProfile | null): Promise<SecurityAssessment> {
  const base = await resolveBaseBranch(cwd, profile);
  const range = base ? `${shellQuote(base)}...HEAD` : "HEAD";
  const [names, diff, working, workingNames, untracked] = await Promise.all([
    runCommand(`git diff --name-only ${range} --`, cwd, 20_000),
    runCommand(`git diff -U0 ${range} --`, cwd, 20_000),
    runCommand("git diff -U0 HEAD --", cwd, 20_000),
    runCommand("git diff --name-only HEAD --", cwd, 15_000),
    runCommand("git ls-files --others --exclude-standard", cwd, 15_000),
  ]);

  const files = new Set<string>();
  for (const result of [names, workingNames, untracked]) {
    if (result.exitCode !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim()) files.add(line.trim());
    }
  }

  let diffText = [diff.stdout, working.stdout].filter(Boolean).join("\n");
  // Repositorio con un solo commit y sin rama base reconocible: se audita el
  // commit completo en vez de declarar que no hay cambios.
  if (!base && files.size === 0) {
    const show = await runCommand("git show --format= --unified=0 HEAD --", cwd, 20_000);
    if (show.exitCode === 0) diffText = show.stdout;
    const tracked = await runCommand("git ls-files", cwd, 15_000);
    if (tracked.exitCode === 0) {
      for (const line of tracked.stdout.split(/\r?\n/)) if (line.trim()) files.add(line.trim());
    }
  }

  const fileList = Array.from(files).sort();
  const codeFiles = fileList.filter((file) => CODE_FILE_RE.test(file) && !DOC_FILE_RE.test(file));
  const added = diffText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

  const categories: string[] = [];
  const reasons: string[] = [];
  const add = (category: string, reason: string) => {
    if (!categories.includes(category)) categories.push(category);
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (codeFiles.length > 0) {
    if (fileList.some((file) => /\.sql$/i.test(file)) || /\b(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|ORDER\s+BY)\b/i.test(added)) {
      add("sql", "El diff toca SQL o consultas.");
    }
    if (/\$_(GET|POST|REQUEST|COOKIE|FILES)\b|\breq\.(body|query|params|headers|cookies)\b|\brequest\.(args|form|json|files|values)\b|\bparams\[|\b@RequestParam\b|\binput\(/i.test(added)) {
      add("entradas", "El diff procesa entradas de usuario.");
    }
    if (
      /\b(auth|login|logout|signin|signup|password|passwd|session|jwt|csrf|permission|role|cookie|oauth|token)\b/i.test(added) ||
      fileList.some((file) => /(^|\/)(auth|login|session|user|permission|security)[^/]*\.(php|js|ts|py|rb|go|java|cs)$/i.test(file))
    ) {
      add("auth", "El diff toca autenticación, sesión o permisos.");
    }
    if (
      /\b(unlink|file_get_contents|file_put_contents|fopen|fwrite|readfile|move_uploaded_file|upload|download|unzip|zip|path\.(join|resolve)|fs\.(read|write|unlink|create)|sendFile|realpath|basename)\b/i.test(added) ||
      fileList.some((file) => /(^|\/)(upload|file|files|download|storage|media)[^/]*\.(php|js|ts|py|rb|go|java|cs)$/i.test(file))
    ) {
      add("archivos", "El diff toca archivos, subidas o borrado.");
    }
    if (/\b(fetch|axios|http\.(get|post|request)|https?\.(get|request)|requests\.(get|post|put|delete)|urllib|curl|socket|webhook|urlopen)\b/i.test(added)) {
      add("red", "El diff introduce llamadas de red.");
    }
    if (looksLikeSecret(added)) {
      add("secretos", "El diff contiene cadenas con forma de secreto.");
    }
    if (fileList.some((file) => MANIFEST_RE.test(file))) {
      add("dependencias", "El diff cambia manifiestos o lockfiles de dependencias.");
    }
  }

  return {
    applicable: categories.length > 0,
    base,
    categories,
    reasons:
      categories.length > 0
        ? reasons
        : [codeFiles.length === 0 ? "sin cambios en código ejecutable" : "sin superficie sensible detectada en el diff"],
    files: fileList,
  };
}

export function createReviewTools(deps: ReviewToolsDeps): ToolDef[] {
  return [
    {
      name: "review_submit",
      description:
        "Guarda el veredicto estructurado de un revisor (security/code/qa) en review_runs: hallazgos, bloqueantes y modelo usado.",
      input: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "UUID de la tarea." },
          role: { type: "string", enum: ROLES },
          model: { type: "string", description: "Modelo que hizo la revisión." },
          verdict: { type: "string", enum: ["approved", "changes_required"] },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
                file: { type: "string" },
                line: { type: "integer", minimum: 1 },
                problem: { type: "string" },
                action: { type: "string" },
                blocking: { type: "boolean" },
              },
              required: ["severity", "file", "problem", "action", "blocking"],
              additionalProperties: false,
            },
          },
          summary: { type: "string", maxLength: 4000 },
          gate_run_id: { type: "string" },
          iteration: { type: "integer", minimum: 1, maximum: 3, default: 1 },
        },
        required: ["task_id", "role", "model", "verdict", "findings", "summary"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const taskId = String(input.task_id ?? "").trim();
        if (!UUID_RE.test(taskId)) return fail("task_id no es un UUID válido.");
        const task = await deps.db.getTask(project.projectId, taskId);
        if (!task) return fail("La tarea no existe en este proyecto.");

        const role = String(input.role ?? "") as Role;
        if (!ROLES.includes(role)) return fail("role debe ser security, code o qa.");
        const model = String(input.model ?? "").trim();
        if (!model) return fail("Indica el modelo que hizo la revisión.");
        const verdict = input.verdict === "approved" ? "approved" : input.verdict === "changes_required" ? "changes_required" : null;
        if (!verdict) return fail("verdict debe ser approved o changes_required.");
        if (!Array.isArray(input.findings)) return fail("findings debe ser un array.");
        if (looksLikeSecret(JSON.stringify(input.findings))) return fail("Los hallazgos parecen contener un secreto.");

        const findings = input.findings.map((raw) => {
          const finding = isPlainObject(raw) ? raw : {};
          return {
            severity: String(finding.severity ?? "medium"),
            file: String(finding.file ?? "?"),
            line: typeof finding.line === "number" ? finding.line : null,
            problem: String(finding.problem ?? "").slice(0, 1000),
            action: String(finding.action ?? "").slice(0, 1000),
            blocking: finding.blocking === true,
          };
        });
        const openBlocking = findings.filter((finding) => finding.blocking).length;
        if (verdict === "approved" && openBlocking > 0) {
          return fail("Un veredicto approved no puede tener hallazgos bloqueantes abiertos.");
        }

        const iteration = typeof input.iteration === "number" ? Math.round(input.iteration) : 1;
        if (iteration < 1 || iteration > 3) return fail("iteration debe estar entre 1 y 3.");
        const gateRunId = typeof input.gate_run_id === "string" && UUID_RE.test(input.gate_run_id) ? input.gate_run_id : null;

        // Uso de la sesión del revisor en el momento de registrar el veredicto.
        // Es un snapshot: la respuesta final del revisor puede añadir tokens
        // después; task_close vuelve a leer la sesión para refrescarlo.
        const captured = await captureSessionUsage(deps, String(context.sessionID), model);

        const review = await deps.db.createReviewRun({
          projectId: project.projectId,
          taskId,
          role,
          model,
          verdict,
          findings,
          openBlocking,
          summary: String(input.summary ?? "").slice(0, 4000),
          gateRunId,
          iteration,
          usage: captured.usage,
        });
        return ok({ submitted: true, review });
      },
    },
    {
      name: "task_close",
      description:
        "Cierra una tarea solo si el último gate_run está en verde, los revisores aprobaron sin bloqueantes, hay evidencia por criterio y la memoria existe. Calcula security_applicable del diff y exige justificación si se desactiva con superficie sensible.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "UUID de la tarea." },
          acceptance: {
            type: "array",
            items: {
              type: "object",
              properties: {
                criterion: { type: "string" },
                evidence: { type: "string" },
              },
              required: ["criterion", "evidence"],
              additionalProperties: false,
            },
          },
          security_applicable: {
            type: "boolean",
            description:
              "Fuerza si aplica revisión de seguridad. Si se omite, task_close lo calcula del diff. Si se pone false y el diff toca superficie sensible, exige security_justification.",
          },
          security_justification: {
            type: "string",
            maxLength: 2000,
            description: "Motivo guardado para no pedir revisión de seguridad cuando el diff sí toca superficie sensible.",
          },
          memory_id: { type: "string", description: "UUID de la memoria guardada." },
          residual_risks: { type: "string", maxLength: 4000 },
          waivers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                gate: { type: "string" },
                reason: { type: "string" },
              },
              required: ["gate", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "acceptance", "memory_id", "residual_risks"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const taskId = String(input.id ?? "").trim();
        if (!UUID_RE.test(taskId)) return fail("id no es un UUID válido.");
        const task = await deps.db.getTask(project.projectId, taskId);
        if (!task) return fail("La tarea no existe en este proyecto.");
        if (task.status === "done" || task.status === "cancelled") return fail("La tarea ya está cerrada.");

        const gateRun = await deps.db.getLatestGateRun(project.projectId, taskId);
        if (!gateRun) return fail("No hay gate_runs para esta tarea. Ejecuta run_gates antes de cerrar.");
        if (gateRun.mode !== "check") return fail("El último gate_run es de baseline; ejecuta run_gates en modo check.");
        if (gateRun.status !== "pass") {
          return fail(`El último gate_run está en ${gateRun.status}; no se puede cerrar. ${gateRun.summary ?? ""}`.trim());
        }
        if (gateRun.blockingFailures.length > 0) return fail("El gate_run tiene fallos bloqueantes registrados.");

        const gateResults = gateRun.gates.filter(isPlainObject);
        const skippedBlocking = gateResults.filter((gate) => gate.blocking === true && gate.status === "skipped");
        const waivers = Array.isArray(input.waivers)
          ? input.waivers.filter(isPlainObject).map((waiver) => ({ gate: String(waiver.gate ?? ""), reason: String(waiver.reason ?? "") }))
          : [];
        const missingWaivers = skippedBlocking.filter((gate) => !waivers.some((waiver) => waiver.gate === String(gate.gate)));
        if (missingWaivers.length > 0) {
          return fail(
            `Hay compuertas bloqueantes skipped sin waiver: ${missingWaivers.map((gate) => String(gate.gate)).join(", ")}.`,
          );
        }

        const profile = await deps.db.getProfile(project.projectId);
        const assessment = await assessSecurityFromDiff(project.directory, profile);
        const explicitSecurity = typeof input.security_applicable === "boolean" ? input.security_applicable : null;
        const securityJustification = String(input.security_justification ?? "").trim();
        let securityApplicable: boolean;
        let securitySource: "diff" | "explicit" | "justification";
        if (explicitSecurity === true) {
          securityApplicable = true;
          securitySource = "explicit";
        } else if (explicitSecurity === false) {
          if (assessment.applicable && !securityJustification) {
            return fail(
              `El diff toca superficie sensible (${assessment.categories.join(", ")}): ${assessment.reasons.join(" ")} ` +
                "Pasa @security-reviewer o guarda security_justification con el motivo.",
            );
          }
          securityApplicable = false;
          securitySource = securityJustification ? "justification" : "diff";
        } else {
          securityApplicable = assessment.applicable;
          securitySource = "diff";
        }
        if (securityJustification && looksLikeSecret(securityJustification)) {
          return fail("La justificación de seguridad parece contener un secreto.");
        }

        const reviews = await deps.db.getLatestReviews(taskId);
        const required: Role[] = securityApplicable ? ["security", "code", "qa"] : ["code", "qa"];
        const reviewSummary: Array<Record<string, unknown>> = [];
        const usageEntries: Array<{ model: string; role: string; usage: ReviewUsage }> = [];
        for (const role of required) {
          const review = reviews.find((item) => item.role === role);
          if (!review) return fail(`Falta la revisión obligatoria de ${role}. Usa review_submit.`);
          if (review.verdict !== "approved") return fail(`La revisión de ${role} no está aprobada.`);
          if (review.openBlocking > 0) return fail(`La revisión de ${role} tiene ${review.openBlocking} hallazgo(s) bloqueante(s) abierto(s).`);
          // Se relee la sesión del revisor para incluir la respuesta final que
          // pudo generarse después de llamar a review_submit. Si la sesión ya
          // no existe, se conserva el snapshot guardado en review_submit.
          const refreshId = review.usage.sessionId;
          const snapshot = refreshId ? await deps.getSessionUsage(refreshId) : null;
          const captured =
            snapshot && refreshId
              ? await captureSessionUsage(deps, refreshId, review.model, snapshot)
              : { usage: review.usage, model: review.model };
          reviewSummary.push({
            role,
            review_id: review.id,
            model: review.model,
            verdict: review.verdict,
            open_blocking: review.openBlocking,
            summary: review.summary,
            usage: reportUsage(captured.usage),
          });
          usageEntries.push({ model: review.model, role, usage: captured.usage });
        }

        const acceptance = Array.isArray(input.acceptance) ? input.acceptance.filter(isPlainObject) : [];
        if (acceptance.length === 0) return fail("Incluye al menos un criterio de aceptación con evidencia.");
        for (const item of acceptance) {
          if (!String(item.criterion ?? "").trim() || !String(item.evidence ?? "").trim()) {
            return fail("Cada criterio debe tener criterion y evidence no vacíos.");
          }
        }

        const memoryId = String(input.memory_id ?? "").trim();
        if (!UUID_RE.test(memoryId)) return fail("memory_id no es un UUID válido.");
        const memory = await deps.db.getMemory(memoryId);
        if (!memory) return fail("La memoria indicada no existe en la tabla memories.");
        if (memory.scope === "project" && memory.projectId !== task.projectId) {
          return fail("La memoria es de otro proyecto; no sirve como evidencia de cierre.");
        }

        const branch = await getCurrentBranch(project.directory);
        if (!branch) return fail("No se pudo determinar la rama actual.");
        const protectedBranches = getProtectedBranches(profile);
        if (protectedBranches.includes(branch)) {
          return fail(`No se cierra una tarea en la rama protegida "${branch}".`);
        }

        const residualRisks = String(input.residual_risks ?? "").trim();
        if (!residualRisks) return fail("Indica riesgos residuales (puede ser 'ninguno').");
        if (looksLikeSecret(residualRisks)) return fail("Los riesgos residuales parecen contener un secreto.");

        // La sesión del orquestador es acumulada: puede incluir trabajo de otras
        // tareas. Se etiqueta así en el informe para no atribuirle un costo exacto.
        const orchestrator = await captureSessionUsage(deps, String(context.sessionID), "");
        usageEntries.push({ model: orchestrator.model, role: "orchestrator", usage: orchestrator.usage });
        const aggregated = aggregateUsage(usageEntries);
        const usageReport = {
          captured_at: new Date().toISOString(),
          note:
            "Tokens y costo por sesión. Se usa el costo reportado por el proveedor cuando es > 0; " +
            "si no, se estima con el catálogo de modelos (USD por millón de tokens). " +
            "La sesión del orquestador es acumulada y puede incluir otras tareas.",
          reviews: reviewSummary,
          orchestrator: {
            session_id: orchestrator.usage.sessionId,
            model: orchestrator.model,
            scope: "sesión completa del orquestador (puede incluir otras tareas)",
            tokens: reportTokens(orchestrator.usage.tokens),
            cost_usd: orchestrator.usage.costUsd,
            cost_source: orchestrator.usage.costSource,
            cost_basis: orchestrator.usage.costBasis,
          },
          per_model: aggregated.perModel,
          totals: {
            tokens: aggregated.totalTokens,
            cost_usd: aggregated.totalCostUsd,
          },
        };

        const coverageGate = gateResults.find((gate) => gate.gate === "coverage");
        const report = {
          closed_at: new Date().toISOString(),
          gate_run_id: gateRun.id,
          gate_status: gateRun.status,
          iteration: gateRun.iteration,
          gate_summary: gateRun.summary,
          gates: gateResults.map((gate) => ({
            gate: gate.gate,
            status: gate.status,
            blocking: gate.blocking,
            evidence: gate.evidence,
            skipped_reason: gate.skipped_reason,
          })),
          coverage: coverageGate ? coverageGate.evidence : "sin compuerta de cobertura",
          security: {
            applicable: securityApplicable,
            source: securitySource,
            base_branch: assessment.base,
            categories: assessment.categories,
            reasons: assessment.reasons,
            files: assessment.files,
            justification: securityJustification || null,
          },
          acceptance: acceptance.map((item) => ({
            criterion: String(item.criterion),
            evidence: String(item.evidence),
          })),
          reviews: reviewSummary,
          usage: usageReport,
          memory: { id: memory.id, scope: memory.scope, kind: memory.kind, title: memory.title },
          residual_risks: residualRisks,
          waivers,
        };
        const securitySummary = securityApplicable
          ? `aplica (${assessment.categories.join(", ") || "explícito"})`
          : `no aplica (${securitySource}${securityJustification ? ": justificado" : ""})`;
        const summary = `Cerrada con gate_run ${gateRun.id.slice(0, 8)} (${gateRun.status}); revisores: ${required.join(", ")}; seguridad: ${securitySummary}; cobertura: ${String(coverageGate?.evidence ?? "n/a")}`;
        const closed = await deps.db.closeTask(project.projectId, taskId, report, summary);
        if (!closed) return fail("No se pudo cerrar la tarea.");
        return ok({ closed: true, task: closed, report });
      },
    },
  ];
}

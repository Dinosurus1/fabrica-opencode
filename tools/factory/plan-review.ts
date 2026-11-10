/**
 * Tool plan_review: lanza el subagente `plan-reviewer` en una sesión hija,
 * recoge su veredicto y lo guarda en `plan_reviews`.
 *
 * No edita archivos ni el plan. El orquestador decide qué hallazgos acepta o
 * refuta con evidencia.
 */

import type { FactoryDb, ProjectRef } from "./db.js";
import type { PlanStore } from "./plan-db.js";
import { MODELS, routeReview } from "./routing.js";
import { findingFingerprint, normalizeSeverity, summarizeFindings, type ReviewSeverity } from "./review-severity.js";
import { captureUsage, emptyUsage, type SessionUsageSnapshot, type UsageDeps } from "./usage.js";
import { fail, ok, type ToolDef } from "./types.js";

export interface PlanReviewToolsDeps {
  db: FactoryDb;
  planStore: PlanStore;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
  usage: UsageDeps;
  runtime: any;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseModel(model: string): { providerID: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { providerID: "opencode-go", id: model };
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function extractFinalText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (!message || message.type !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => String(item.text))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function parseVerdict(text: string): "approved" | "changes_required" | null {
  const match = text.match(/Veredicto\s*:\s*(APROBADO|CAMBIOS REQUERIDOS)/i);
  if (!match) return null;
  return match[1]!.toUpperCase().startsWith("APROBADO") ? "approved" : "changes_required";
}

function findingsSection(text: string): string {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^Hallazgos\s*:/i.test(lines[index]!.trim())) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return "";
  const section: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    if (/^Qué NO pude revisar\s*:/i.test(lines[index]!.trim())) break;
    section.push(lines[index]!);
  }
  return section.join("\n").trim();
}

function parseFindings(text: string): Array<{ severity: ReviewSeverity; text: string }> {
  const findings: Array<{ severity: ReviewSeverity; text: string }> = [];
  let inFindings = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^Hallazgos\s*:/i.test(line)) {
      inFindings = true;
      continue;
    }
    if (/^Qué NO pude revisar\s*:/i.test(line)) {
      inFindings = false;
      continue;
    }
    if (!inFindings) continue;
    const match = line.match(/^\s*-\s*\[(CRÍTICO|CRITICO|CRITICAL|ALTO|HIGH|MEDIO|MEDIUM|BAJO|LOW)\]\s*(.+)$/i);
    if (match) {
      findings.push({ severity: normalizeSeverity(match[1]), text: match[2]!.trim().slice(0, 2_000) });
    }
  }
  return findings;
}

async function waitWithTimeout(runtime: any, sessionID: string, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout de plan-reviewer (${Math.round(timeoutMs / 1000)} s).`)), timeoutMs);
  });
  try {
    await Promise.race([runtime.session.wait({ sessionID }), timeout]);
  } catch (error) {
    await runtime.session.interrupt({ sessionID, resume: false }).catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createPlanReviewTools(deps: PlanReviewToolsDeps): ToolDef[] {
  return [
    {
      name: "plan_review",
      description:
        "Lanza plan-reviewer (solo lectura) sobre el plan, documentos y proyecto; guarda veredicto, severidad y métricas. Dos rondas normales; la tercera exige confirmed=true tras exhausted.",
      input: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
          timeout_minutes: { type: "integer", minimum: 1, maximum: 30, default: 12 },
          confirmed: { type: "boolean", description: "Permite una tercera ronda cuando la revisión está exhausted." },
        },
        required: ["plan_id"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const planId = String(input.plan_id ?? "").trim();
        if (!UUID_RE.test(planId)) return fail("plan_id no es un UUID válido.");
        const plan = await deps.planStore.getPlan(project.projectId, planId);
        if (!plan) return fail("El plan no existe en este proyecto.");
        if (["cancelled", "completed", "executing", "paused"].includes(plan.status)) {
          return fail(`No se revisa un plan en estado ${plan.status}; reactívalo o crea otro plan.`);
        }
        const previousReviews = await deps.planStore.listPlanReviews(planId);
        const previousReview = previousReviews[0] ?? null;
        const previousFindings = previousReview?.findings ?? [];
        const previousSummary = summarizeFindings(previousFindings);
        if (plan.reviewRound >= 3) {
          await deps.planStore.updatePlan(project.projectId, planId, {
            reviewExhausted: true,
            residualFindings: previousSummary.list,
            status: "review_pending",
          });
          return ok({
            exhausted: true,
            plan_id: planId,
            round: plan.reviewRound,
            blocking: previousSummary.blocking,
            advisory: previousSummary.advisory,
            metrics: {
              blocking: previousSummary.blockingCount,
              advisory: previousSummary.advisoryCount,
              new: previousReview?.newFindings ?? 0,
              resolved: previousReview?.resolvedFindings ?? 0,
            },
            options: ["approve_with_waiver", "fix_and_revalidate", "cancel"],
            message: "La revisión agotó las rondas; presenta los hallazgos al usuario para que decida.",
          });
        }
        if (plan.reviewRound >= 2 && input.confirmed !== true) {
          await deps.planStore.updatePlan(project.projectId, planId, {
            reviewExhausted: true,
            residualFindings: previousSummary.list,
            status: "review_pending",
          });
          return ok({
            exhausted: true,
            plan_id: planId,
            round: plan.reviewRound,
            blocking: previousSummary.blocking,
            advisory: previousSummary.advisory,
            metrics: {
              blocking: previousSummary.blockingCount,
              advisory: previousSummary.advisoryCount,
              new: previousReview?.newFindings ?? 0,
              resolved: previousReview?.resolvedFindings ?? 0,
            },
            options: ["approve_with_waiver", "fix_and_revalidate", "cancel"],
            message: "La revisión agotó las 2 rondas. Decide: aprobar con waiver, corregir y revalidar, o cancelar. Para una tercera ronda usa confirmed=true.",
          });
        }
        const tasks = await deps.planStore.listPlanTasks(planId);
        if (tasks.length === 0) return fail("El plan no tiene tareas.");

        const orchestratorModel =
          typeof plan.metadata.orchestrator_model === "string"
            ? plan.metadata.orchestrator_model
            : MODELS.orchestrator;
        const reviewerModel = routeReview(orchestratorModel, "plan");
        const model = parseModel(reviewerModel);
        const requestedTimeout = Number(input.timeout_minutes ?? 12);
        const timeoutMinutes = Number.isFinite(requestedTimeout)
          ? Math.max(1, Math.min(30, Math.round(requestedTimeout)))
          : 12;
        const timeoutMs = timeoutMinutes * 60_000;

        const planPayload = JSON.stringify(
          {
            plan,
            tasks,
            source_documents: plan.sourceDocuments,
            validation: plan.validation,
          },
          null,
          2,
        );
        if (planPayload.length > 80_000) {
          return fail("El plan supera 80 KB de JSON; divídelo antes de revisarlo para no dejar tareas sin auditar.");
        }
        const prompt = [
          "Revisa este plan por fases antes de ejecutarlo.",
          "Lee los documentos de fases y el código del proyecto que necesites; no edites nada.",
          "Aplica el formato obligatorio de tu rol: Veredicto, Hallazgos y Qué NO pude revisar.",
          "Busca dependencias faltantes, orden dudoso, riesgos técnicos, criterios no verificables, huecos de seguridad, clasificación fácil/difícil y solapamiento de archivos.",
          `Proyecto: ${project.directory}`,
          `Plan: ${planId}`,
          "```json",
          planPayload,
          "```",
          "Hallazgos de la ronda anterior (si siguen vigentes, repítelos con el mismo texto; si están resueltos, no los incluyas):",
          "```json",
          JSON.stringify(previousSummary.list, null, 2),
          "```",
        ].join("\n");

        const created = await deps.runtime.session.create({
          parentID: String(context.sessionID),
          title: `Plan review · ${plan.title}`.slice(0, 120),
          agent: "plan-reviewer",
          model,
          location: { directory: project.directory },
        });
        const sessionID = String(created.id ?? "");
        if (!sessionID) return fail("No se pudo crear la sesión de plan-reviewer.");

        try {
          await deps.runtime.session.prompt({ sessionID, text: prompt });
          await waitWithTimeout(deps.runtime, sessionID, timeoutMs);
          const messages = await deps.runtime.session.context({ sessionID });
          const text = extractFinalText(messages);
          const rawVerdict = parseVerdict(text);
          if (!rawVerdict) {
            return fail(`plan-reviewer no devolvió un veredicto reconocible. Sesión: ${sessionID}. Respuesta: ${text.slice(0, 500)}`);
          }
          const findings = parseFindings(text);
          if (rawVerdict === "changes_required" && findings.length === 0) {
            return fail("plan-reviewer pidió cambios pero no se pudo parsear ningún hallazgo; reformatea la respuesta antes de continuar.");
          }
          const approvedSection = findingsSection(text);
          if (rawVerdict === "approved" && !approvedSection) {
            return fail("plan-reviewer aprobó sin una sección 'Hallazgos:' con contenido; no se acepta una aprobación sin auditoría explícita.");
          }
          if (rawVerdict === "approved" && /CR[IÍ]TICO|CRITICAL/i.test(approvedSection) && !findings.some((finding) => finding.severity === "CRITICO")) {
            return fail("plan-reviewer aprobó mencionando un CRÍTICO que no se pudo parsear; reformatea o corrige el hallazgo.");
          }
          const currentSummary = summarizeFindings(findings);
          // Un veredicto "aprobado" con hallazgos bloqueantes no es aprobado.
          const verdict = currentSummary.blockingCount > 0 ? "changes_required" : rawVerdict;
          const currentFingerprints = new Set(currentSummary.list.map(findingFingerprint));
          const previousFingerprints = new Set(previousSummary.list.map(findingFingerprint));
          const newFindings = currentSummary.list.filter((item) => !previousFingerprints.has(findingFingerprint(item))).length;
          const resolvedFindings = previousSummary.list.filter((item) => !currentFingerprints.has(findingFingerprint(item))).length;
          const snapshot = (await deps.usage.getSessionUsage(sessionID)) as SessionUsageSnapshot | null;
          const price = snapshot
            ? await deps.usage.getModelPrice(snapshot.model || reviewerModel, snapshot.tokens.input + snapshot.tokens.cacheRead)
            : null;
          const usage = snapshot ? captureUsage(snapshot, price, sessionID) : emptyUsage(sessionID);
          const round = plan.reviewRound + 1;
          const review = await deps.planStore.createPlanReview({
            planId,
            round,
            model: reviewerModel,
            verdict,
            findings,
            blockingCount: currentSummary.blockingCount,
            advisoryCount: currentSummary.advisoryCount,
            newFindings,
            resolvedFindings,
            summary: text.slice(0, 20_000),
            sessionId: sessionID,
            usage,
          });
          const nextStatus =
            verdict === "approved"
              ? plan.validation.ok === true
                ? "validated"
                : "review_pending"
              : "review_pending";
          await deps.planStore.updatePlan(project.projectId, planId, {
            reviewRound: round,
            reviewExhausted: false,
            residualFindings: currentSummary.list,
            status: nextStatus,
            approvedAt: nextStatus === "review_pending" ? null : undefined,
          });
          return ok({
            reviewed: true,
            round,
            verdict,
            findings,
            blocking: currentSummary.blocking,
            advisory: currentSummary.advisory,
            metrics: {
              blocking: currentSummary.blockingCount,
              advisory: currentSummary.advisoryCount,
              new: newFindings,
              resolved: resolvedFindings,
            },
            review,
            session_id: sessionID,
            model: reviewerModel,
            raw: text,
            usage,
          });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

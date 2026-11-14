/**
 * Selección de agentes por proyecto.
 *
 * Separa la selección de agentes (qué roles puede lanzar el orquestador) del
 * modo de modelo (manual/auto/híbrido). La selección se guarda por proyecto y
 * se aplica a la sesión como reglas `subagent` ordenadas.
 */

import type { AgentSelection } from "./mam-db.js";
import type { MamRuntime } from "./mam.js";
import type { ToolDef } from "./types.js";
import { fail, ok } from "./types.js";

export type AgentMode = "auto" | "manual" | "hybrid";

export interface AgentCatalogEntry {
  agentId: string;
  role: string;
  description: string;
  required?: boolean;
}

export const AGENT_CATALOG: AgentCatalogEntry[] = [
  { agentId: "factory", role: "orchestration", description: "Orquestador y Tech Lead.", required: true },
  { agentId: "implementer", role: "development", description: "Implementación aislada en worktree.", required: true },
  { agentId: "qa-engineer", role: "qa", description: "QA adversarial y evidencia por criterio.", required: true },
  { agentId: "code-reviewer", role: "review", description: "Revisión de diseño y mantenibilidad.", required: true },
  { agentId: "security-reviewer", role: "security", description: "Revisión de seguridad de solo lectura.", required: true },
  { agentId: "plan-reviewer", role: "planning", description: "Revisión del plan por fases." },
  { agentId: "product-analyst", role: "analysis", description: "Requisitos y criterios verificables." },
  { agentId: "architect", role: "architecture", description: "Diseño, contratos y ADR." },
  { agentId: "tech-writer", role: "documentation", description: "README, CHANGELOG, guías y runbooks." },
  { agentId: "helper", role: "assistance", description: "Segunda opinión y documentación con citas." },
  { agentId: "researcher", role: "research", description: "Información cambiante con fuentes." },
];

export interface AgentSignals {
  ambiguousScope?: boolean;
  crossModule?: boolean;
  phasePlan?: boolean;
  handoff?: boolean;
  research?: boolean;
  secondOpinion?: boolean;
}

export interface Recommendation {
  recommended: string[];
  rationale: Record<string, string>;
}

const BASE = ["factory", "implementer", "qa-engineer", "code-reviewer", "security-reviewer"];

export function recommendAgents(signals: AgentSignals = {}): Recommendation {
  const recommended = new Set(BASE);
  const rationale: Record<string, string> = {
    factory: "Siempre orquesta.",
    implementer: "Desarrollo aislado en worktree.",
    "qa-engineer": "Validación independiente.",
    "code-reviewer": "Revisión de diseño y mantenibilidad.",
    "security-reviewer": "Superficie sensible y buenas prácticas.",
  };
  if (signals.phasePlan) {
    recommended.add("plan-reviewer");
    rationale["plan-reviewer"] = "Hay un plan por fases que revisar antes de ejecutar.";
  }
  if (signals.ambiguousScope) {
    recommended.add("product-analyst");
    rationale["product-analyst"] = "Alcance ambiguo o requisitos incompletos.";
  }
  if (signals.crossModule) {
    recommended.add("architect");
    rationale.architect = "El cambio cruza módulos o contratos.";
  }
  if (signals.handoff) {
    recommended.add("tech-writer");
    rationale["tech-writer"] = "Hay que transferir o documentar la entrega.";
  }
  if (signals.research) {
    recommended.add("researcher");
    rationale.researcher = "Hace falta información externa cambiante.";
  }
  if (signals.secondOpinion) {
    recommended.add("helper");
    rationale.helper = "Conviene una segunda opinión acotada.";
  }
  return { recommended: AGENT_CATALOG.filter((entry) => recommended.has(entry.agentId)).map((entry) => entry.agentId), rationale };
}

export function validateSelected(selected: string[]): { valid: boolean; unknown: string[]; missingRequired: string[] } {
  const known = new Set(AGENT_CATALOG.map((entry) => entry.agentId));
  const unknown = selected.filter((agent) => !known.has(agent));
  const missingRequired = AGENT_CATALOG.filter((entry) => entry.required && !selected.includes(entry.agentId)).map(
    (entry) => entry.agentId,
  );
  return { valid: unknown.length === 0 && missingRequired.length === 0, unknown, missingRequired };
}

export function approvedFor(mode: AgentMode, selected: string[], recommended: string[]): string[] {
  if (mode === "manual") return [...new Set(selected)];
  if (mode === "auto") return [...new Set([...selected, ...recommended])];
  return [...new Set(selected)];
}

export async function getSelection(
  mam: MamRuntime,
  projectId: string,
): Promise<AgentSelection> {
  const stored = await mam.store.getAgentSelection(projectId);
  if (stored) return stored;
  const recommendation = recommendAgents({});
  return {
    projectId,
    mode: "hybrid",
    selected: recommendation.recommended,
    recommended: recommendation.recommended,
    approved: recommendation.recommended,
    rationale: recommendation.rationale,
    updatedAt: new Date().toISOString(),
  };
}

export async function applySelectionPermissions(
  runtime: any,
  sessionID: string,
  allowed: string[],
): Promise<void> {
  const session = await runtime.session.get({ sessionID });
  const current = Array.isArray(session.permissions) ? session.permissions : [];
  const kept = current.filter((rule: { action?: string }) => rule.action !== "subagent");
  const subagents = allowed.filter((agent) => agent !== "factory");
  const permissions = [
    ...kept,
    { action: "subagent", resource: "*", effect: "deny" },
    ...subagents.map((agent) => ({ action: "subagent", resource: agent, effect: "allow" })),
  ];
  await runtime.session.update({ sessionID, permissions });
}

export function checkAgent(selection: AgentSelection, agentId: string): boolean {
  return selection.approved.includes(agentId) || selection.selected.includes(agentId);
}

export interface AgentToolsDeps {
  mam: MamRuntime;
  resolveProject: (sessionID: string) => Promise<{ projectId: string }>;
}

export function createAgentSelectionTools(deps: AgentToolsDeps): ToolDef[] {
  return [
    {
      name: "factory_agents_get",
      description: "Lee la selección de agentes del proyecto, la recomendación determinística y el modo.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, context) {
        try {
          const project = await deps.resolveProject(String(context.sessionID));
          const selection = await getSelection(deps.mam, project.projectId);
          const recommendation = recommendAgents({});
          return ok({ selection, catalog: AGENT_CATALOG, recommendation });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "factory_agents_propose",
      description:
        "Propone agentes de forma determinística según señales del proyecto. No los aplica; el usuario decide en modo manual/híbrido.",
      input: {
        type: "object",
        properties: {
          ambiguous_scope: { type: "boolean" },
          cross_module: { type: "boolean" },
          phase_plan: { type: "boolean" },
          handoff: { type: "boolean" },
          research: { type: "boolean" },
          second_opinion: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(input) {
        const recommendation = recommendAgents({
          ambiguousScope: input.ambiguous_scope === true,
          crossModule: input.cross_module === true,
          phasePlan: input.phase_plan === true,
          handoff: input.handoff === true,
          research: input.research === true,
          secondOpinion: input.second_opinion === true,
        });
        return ok({ ...recommendation, catalog: AGENT_CATALOG });
      },
    },
    {
      name: "factory_agents_select",
      description:
        "Guarda el modo de selección de agentes y la selección del usuario. manual no añade nada; híbrido guarda el core; auto permite recomendaciones.",
      input: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["auto", "manual", "hybrid"] },
          selected: { type: "array", items: { type: "string" }, minItems: 1 },
          recommended: { type: "array", items: { type: "string" } },
          confirmed: { type: "boolean", default: false },
        },
        required: ["mode", "selected"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          const project = await deps.resolveProject(String(context.sessionID));
          const mode = input.mode as AgentMode;
          if (!["auto", "manual", "hybrid"].includes(mode)) return fail("mode inválido.");
          if (input.confirmed !== true && mode !== "auto") {
            return ok({ saved: false, requires_confirmation: true });
          }
          const selected = Array.isArray(input.selected) ? input.selected.map(String) : [];
          const validation = validateSelected(selected);
          if (!validation.valid) {
            return fail(
              `Selección inválida. Desconocidos: ${validation.unknown.join(", ") || "ninguno"}. Faltan requeridos: ${validation.missingRequired.join(", ") || "ninguno"}.`,
            );
          }
          const recommendation = recommendAgents({});
          const recommended = Array.isArray(input.recommended)
            ? input.recommended.map(String)
            : recommendation.recommended;
          const selection: AgentSelection = {
            projectId: project.projectId,
            mode,
            selected,
            recommended,
            approved: approvedFor(mode, selected, recommended),
            rationale: recommendation.rationale,
            updatedAt: new Date().toISOString(),
          };
          await deps.mam.store.setAgentSelection(selection);
          await deps.mam.store.audit("agents.selection.set", project.projectId, {
            mode,
            selected,
            approved: selection.approved,
          });
          return ok({ saved: true, selection });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "factory_agents_apply",
      description:
        "Aplica la selección a la sesión actual: deniega subagentes no seleccionados y permite los aprobados. Requiere confirmed=true.",
      input: {
        type: "object",
        properties: { confirmed: { type: "boolean", default: false } },
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          if (input.confirmed !== true) return ok({ applied: false, requires_confirmation: true });
          const project = await deps.resolveProject(String(context.sessionID));
          const selection = await getSelection(deps.mam, project.projectId);
          await applySelectionPermissions(deps.mam.runtime, String(context.sessionID), selection.approved);
          await deps.mam.store.audit("agents.selection.apply", project.projectId, {
            session_id: String(context.sessionID),
            allowed: selection.approved,
          });
          return ok({ applied: true, selection });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "factory_agents_check",
      description:
        "Comprueba si un agente está aprobado en la selección actual. El orquestador debe llamarlo antes de lanzar un subagente.",
      input: {
        type: "object",
        properties: { agent_id: { type: "string" } },
        required: ["agent_id"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          const project = await deps.resolveProject(String(context.sessionID));
          const selection = await getSelection(deps.mam, project.projectId);
          const agentId = String(input.agent_id ?? "").trim();
          const allowed = checkAgent(selection, agentId);
          return ok({
            agent_id: agentId,
            allowed,
            mode: selection.mode,
            reason: allowed ? "aprobado en la selección" : "no está en la selección aprobada",
            selection,
          });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

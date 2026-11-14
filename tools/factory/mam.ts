/**
 * Tools de Model & Agent Management (MAM).
 *
 * Qué hacen: sincronizan el catálogo real de OpenCode, gestionan perfiles de
 * ejecución por rol y aplican un perfil a los agentes con validación previa.
 * No cambian permisos, prompts ni skills: solo el modelo asignado.
 *
 * Qué acceden: PostgreSQL de la fábrica y el registro de agentes/modelos de
 * OpenCode a través del contexto del plugin.
 */

import type {
  AgentInput,
  AgentRecord,
  ExecutionProfileWithAssignments,
  MamStore,
  ModelInput,
  ModelRecord,
  ProfileAssignment,
  ProfileInput,
  ProfileMode,
  ProfilePolicy,
} from "./mam-db.js";
import { fail, ok, type ToolDef } from "./types.js";

export interface MamRuntime {
  store: MamStore;
  runtime: any;
  location: string;
  activeRegistration: { dispose: () => Promise<void> } | null;
}

export interface MamToolsDeps {
  mam: MamRuntime;
}

export function createMamRuntime(store: MamStore, runtime: any, location: string): MamRuntime {
  return { store, runtime, location, activeRegistration: null };
}

const ROLE_BY_AGENT: Record<string, string> = {
  factory: "orchestration",
  "product-analyst": "analysis",
  architect: "architecture",
  implementer: "development",
  "qa-engineer": "qa",
  "code-reviewer": "review",
  "security-reviewer": "security",
  "tech-writer": "documentation",
  "devops-engineer": "devops",
  "memory-consolidator": "memory",
  "plan-reviewer": "planning",
  helper: "assistance",
  researcher: "research",
  explore: "exploration",
};

const PROFILE_MODES: ProfileMode[] = ["auto", "manual", "hybrid"];

function listFrom(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  const data = (value as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function toModelInput(raw: Record<string, unknown>): ModelInput {
  const costs = Array.isArray(raw.cost) ? (raw.cost as Record<string, unknown>[]) : [];
  const base = (costs.find((entry) => !entry.tier) ?? costs[0] ?? {}) as Record<string, unknown>;
  const cache = (base.cache ?? {}) as Record<string, unknown>;
  const limit = (raw.limit ?? {}) as Record<string, unknown>;
  return {
    providerId: String(raw.providerID ?? raw.providerId ?? ""),
    modelId: String(raw.modelID ?? raw.modelId ?? raw.id ?? ""),
    name: raw.name ? String(raw.name) : null,
    family: raw.family ? String(raw.family) : null,
    type: raw.type ? String(raw.type) : "chat",
    status: raw.status ? String(raw.status) : "active",
    enabled: raw.enabled !== false,
    contextLimit: typeof limit.context === "number" ? limit.context : null,
    inputLimit: typeof limit.input === "number" ? limit.input : null,
    outputLimit: typeof limit.output === "number" ? limit.output : null,
    costInput: typeof base.input === "number" ? base.input : null,
    costOutput: typeof base.output === "number" ? base.output : null,
    costCacheRead: typeof cache.read === "number" ? cache.read : null,
    costCacheWrite: typeof cache.write === "number" ? cache.write : null,
    capabilities:
      raw.capabilities && typeof raw.capabilities === "object"
        ? (raw.capabilities as Record<string, unknown>)
        : {},
    variants: Array.isArray(raw.variants) ? raw.variants : [],
  };
}

function toAgentInput(raw: Record<string, unknown>): AgentInput {
  const model = (raw.model ?? {}) as Record<string, unknown>;
  const id = String(raw.id ?? raw.agentID ?? "");
  return {
    agentId: id,
    name: raw.name ? String(raw.name) : null,
    mode: raw.mode ? String(raw.mode) : null,
    description: raw.description ? String(raw.description) : null,
    role: ROLE_BY_AGENT[id] ?? "general",
    modelProvider: model.providerID ? String(model.providerID) : null,
    modelId: model.id ? String(model.id) : model.modelID ? String(model.modelID) : null,
    modelVariant: model.variant ? String(model.variant) : null,
    steps: typeof raw.steps === "number" ? raw.steps : null,
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    source: "opencode",
  };
}

function asMode(value: unknown): ProfileMode | undefined {
  return typeof value === "string" && (PROFILE_MODES as string[]).includes(value)
    ? (value as ProfileMode)
    : undefined;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPolicy(value: unknown): ProfilePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const strings = (input: unknown): string[] | undefined =>
    Array.isArray(input) ? input.map(String).filter(Boolean) : undefined;
  return {
    allowedProviders: strings(raw.allowedProviders ?? raw.allowed_providers),
    allowedModels: strings(raw.allowedModels ?? raw.allowed_models),
    prohibitedModels: strings(raw.prohibitedModels ?? raw.prohibited_models),
    requireTools:
      typeof raw.requireTools === "boolean"
        ? raw.requireTools
        : typeof raw.require_tools === "boolean"
          ? raw.require_tools
          : undefined,
    minContext:
      typeof raw.minContext === "number"
        ? raw.minContext
        : typeof raw.min_context === "number"
          ? raw.min_context
          : undefined,
    noSilentFallback:
      typeof raw.noSilentFallback === "boolean"
        ? raw.noSilentFallback
        : typeof raw.no_silent_fallback === "boolean"
          ? raw.no_silent_fallback
          : undefined,
  };
}

function asAssignments(value: unknown): ProfileAssignment[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    return {
      agentId: asString(raw.agentId ?? raw.agent_id),
      providerId: asString(raw.providerId ?? raw.provider_id),
      modelId: asString(raw.modelId ?? raw.model_id),
      variant: asString(raw.variant) || null,
      locked: raw.locked !== false,
      maxCostUsd: asNumberOrNull(raw.maxCostUsd ?? raw.max_cost_usd),
      tokenBudget:
        typeof (raw.tokenBudget ?? raw.token_budget) === "number"
          ? Math.round(Number(raw.tokenBudget ?? raw.token_budget))
          : null,
      priority:
        typeof raw.priority === "number" ? Math.round(raw.priority) : 0,
    };
  });
}

function profileInput(input: Record<string, unknown>): ProfileInput {
  return {
    id: asString(input.id) || undefined,
    name: asString(input.name),
    description: asString(input.description) || null,
    mode: asMode(input.mode) ?? "hybrid",
    isDefault: input.isDefault === true || input.is_default === true,
    policy: asPolicy(input.policy),
    assignments: asAssignments(input.assignments),
  };
}

export function parseProfileInput(input: Record<string, unknown>): ProfileInput {
  return profileInput(input);
}

export interface MamIssue {
  severity: "error" | "warning";
  agentId: string;
  providerId: string;
  modelId: string;
  message: string;
}

export async function validateProfileInput(
  store: MamStore,
  input: ProfileInput,
): Promise<MamIssue[]> {
  const issues: MamIssue[] = [];
  const models = await store.listModels({ limit: 2_000 });
  const agents = await store.listAgents();
  const modelIndex = new Map(models.map((model) => [`${model.providerId}/${model.modelId}`, model]));
  const agentIndex = new Map(agents.map((agent) => [agent.agentId, agent]));
  const seen = new Set<string>();
  const policy = input.policy ?? {};

  if (input.name.length < 3) {
    issues.push({
      severity: "error",
      agentId: "*",
      providerId: "*",
      modelId: "*",
      message: "El nombre del perfil debe tener al menos 3 caracteres.",
    });
  }
  if (input.assignments.length === 0) {
    issues.push({
      severity: "error",
      agentId: "*",
      providerId: "*",
      modelId: "*",
      message: "El perfil necesita al menos una asignación.",
    });
  }

  for (const assignment of input.assignments) {
    const ref = `${assignment.providerId}/${assignment.modelId}`;
    if (!assignment.agentId) {
      issues.push({
        severity: "error",
        agentId: "*",
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: "Asignación sin agentId.",
      });
      continue;
    }
    if (seen.has(assignment.agentId)) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El agente ${assignment.agentId} aparece más de una vez en el perfil.`,
      });
      continue;
    }
    seen.add(assignment.agentId);

    if (!agentIndex.has(assignment.agentId)) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El agente ${assignment.agentId} no existe en el catálogo.`,
      });
    }
    const model = modelIndex.get(ref) as ModelRecord | undefined;
    if (!model) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El modelo ${ref} no existe en el catálogo. Sincroniza el catálogo primero.`,
      });
      continue;
    }
    if (!model.enabled || model.status !== "active") {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El modelo ${ref} no está activo (status=${model.status}, enabled=${model.enabled}).`,
      });
    }
    if (!model.authorized) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El modelo ${ref} no está autorizado por la política.`,
      });
    }
    if (model.prohibited) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El modelo ${ref} está prohibido.`,
      });
    }
    if (policy.allowedProviders?.length && !policy.allowedProviders.includes(model.providerId)) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El proveedor ${model.providerId} no está permitido por el perfil.`,
      });
    }
    if (policy.allowedModels?.length && !policy.allowedModels.includes(ref)) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El modelo ${ref} no está en la lista permitida del perfil.`,
      });
    }
    if (policy.prohibitedModels?.includes(ref)) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El modelo ${ref} está prohibido por el perfil.`,
      });
    }
    if (policy.requireTools !== false && model.capabilities.tools !== true) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El modelo ${ref} no soporta tools y este rol las necesita.`,
      });
    }
    if (policy.minContext && (model.contextLimit ?? 0) < policy.minContext) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El modelo ${ref} tiene contexto ${model.contextLimit ?? 0}, menor que el mínimo ${policy.minContext}.`,
      });
    }
    if (assignment.locked === false) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: `El rol ${assignment.agentId} debe tener el modelo bloqueado.`,
      });
    }
    if (typeof assignment.maxCostUsd === "number" && assignment.maxCostUsd < 0) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: "El presupuesto no puede ser negativo.",
      });
    }
    if (typeof assignment.tokenBudget === "number" && assignment.tokenBudget < 1) {
      issues.push({
        severity: "error",
        agentId: assignment.agentId,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        message: "El límite de tokens debe ser positivo.",
      });
    }
  }

  return issues;
}

export async function syncCatalogFromRuntime(mam: MamRuntime): Promise<{
  counts: { models: number; agents: number };
  defaultProfile: ExecutionProfileWithAssignments | null;
}> {
  const models = listFrom(await mam.runtime.model.list()).map(toModelInput);
  const agents = listFrom(await mam.runtime.agent.list()).map(toAgentInput);
  const validModels = models.filter((model) => model.providerId && model.modelId);
  const validAgents = agents.filter((agent) => agent.agentId);
  const counts = await mam.store.syncCatalog(validModels, validAgents);
  const defaultProfile = await mam.store.ensureDefaultProfile();
  await mam.store.audit("catalog.sync", null, counts);
  return { counts, defaultProfile };
}

export interface ApplyProfileOptions {
  makeDefault?: boolean;
  sessionId?: string;
}

export async function applyProfileFromStore(
  mam: MamRuntime,
  profile: ExecutionProfileWithAssignments,
  options: ApplyProfileOptions = {},
): Promise<{ warnings: string[]; sessionUpdated: boolean }> {
  const { runtime } = mam;
  const warnings: string[] = [];
  if (mam.activeRegistration) {
    await mam.activeRegistration.dispose();
    mam.activeRegistration = null;
  }
  mam.activeRegistration = await runtime.agent.transform((editor: any) => {
    for (const assignment of profile.assignments) {
      const agent = editor.get(assignment.agentId);
      if (!agent) {
        warnings.push(`El agente ${assignment.agentId} ya no existe; se omite.`);
        continue;
      }
      agent.model = {
        providerID: assignment.providerId,
        id: assignment.modelId,
        ...(assignment.variant ? { variant: assignment.variant } : {}),
      };
    }
  });
  await runtime.agent.reload();
  await mam.store.setAppliedProfile(mam.location, profile.id);

  if (options.makeDefault === true) {
    await mam.store.setDefaultProfile(profile.id);
  }

  let sessionUpdated = false;
  if (options.sessionId) {
    const factoryAssignment =
      profile.assignments.find((assignment) => assignment.agentId === "factory") ??
      profile.assignments[0];
    if (factoryAssignment) {
      await runtime.session.switchModel({
        sessionID: options.sessionId,
        model: {
          providerID: factoryAssignment.providerId,
          id: factoryAssignment.modelId,
          ...(factoryAssignment.variant ? { variant: factoryAssignment.variant } : {}),
        },
      });
      sessionUpdated = true;
    }
  }

  return { warnings, sessionUpdated };
}

export function createMamTools(deps: MamToolsDeps): ToolDef[] {
  const { store } = deps.mam;

  return [
    {
      name: "model_catalog_sync",
      description:
        "Sincroniza el catálogo real de modelos y agentes de OpenCode en la fábrica. Crea el perfil 'Actual' si no hay uno por defecto. No cambia modelos.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        try {
          const { counts, defaultProfile } = await syncCatalogFromRuntime(deps.mam);
          return ok({
            synced: counts,
            default_profile: defaultProfile
              ? { id: defaultProfile.id, name: defaultProfile.name, assignments: defaultProfile.assignments.length }
              : null,
          });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "model_catalog_list",
      description: "Lista el catálogo de modelos con precios, contexto, capacidades y estado de autorización.",
      input: {
        type: "object",
        properties: {
          provider_id: { type: "string" },
          family: { type: "string" },
          status: { type: "string" },
          authorized: { type: "boolean" },
          prohibited: { type: "boolean" },
          enabled: { type: "boolean" },
          search: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 2000 },
        },
        additionalProperties: false,
      },
      async execute(input) {
        try {
          const models = await store.listModels({
            providerId: asString(input.provider_id) || undefined,
            family: asString(input.family) || undefined,
            status: asString(input.status) || undefined,
            authorized: typeof input.authorized === "boolean" ? input.authorized : undefined,
            prohibited: typeof input.prohibited === "boolean" ? input.prohibited : undefined,
            enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
            search: asString(input.search) || undefined,
            limit: typeof input.limit === "number" ? input.limit : undefined,
          });
          return ok({ count: models.length, models });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "agent_catalog_list",
      description: "Lista los agentes conocidos con su rol, modo, modelo configurado y número de permisos.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        try {
          const agents = await store.listAgents();
          return ok({ count: agents.length, agents });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "model_profile_list",
      description: "Lista los perfiles de ejecución guardados y marca el perfil por defecto.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        try {
          const [profiles, applied] = await Promise.all([
            store.listProfiles(),
            store.getAppliedProfile(deps.mam.location),
          ]);
          return ok({ count: profiles.length, profiles, applied_profile_id: applied });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "model_profile_get",
      description: "Devuelve un perfil con todas sus asignaciones de modelo por agente.",
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input) {
        try {
          const id = asString(input.id);
          if (!id) return fail("Falta el id del perfil.");
          const profile = await store.getProfile(id);
          if (!profile) return fail("El perfil no existe.");
          const applied = await store.getAppliedProfile(deps.mam.location);
          return ok({ ...profile, applied: applied === profile.id });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "model_profile_validate",
      description: "Valida un perfil contra el catálogo y la política antes de guardarlo o aplicarlo.",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string", minLength: 3, maxLength: 120 },
          description: { type: "string" },
          mode: { type: "string", enum: PROFILE_MODES },
          is_default: { type: "boolean" },
          policy: { type: "object", additionalProperties: true },
          assignments: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        required: ["name", "assignments"],
        additionalProperties: false,
      },
      async execute(input) {
        try {
          const profile = profileInput(input);
          const issues = await validateProfileInput(store, profile);
          return ok({
            valid: !issues.some((issue) => issue.severity === "error"),
            issues,
          });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "model_profile_set",
      description:
        "Crea o actualiza un perfil de ejecución con asignaciones de modelo por agente. Valida disponibilidad, capacidades y política antes de guardar.",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string", minLength: 3, maxLength: 120 },
          description: { type: "string", maxLength: 500 },
          mode: { type: "string", enum: PROFILE_MODES, default: "hybrid" },
          is_default: { type: "boolean", default: false },
          policy: { type: "object", additionalProperties: true },
          assignments: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                agent_id: { type: "string" },
                provider_id: { type: "string" },
                model_id: { type: "string" },
                variant: { type: "string" },
                locked: { type: "boolean", default: true },
                max_cost_usd: { type: "number", minimum: 0 },
                token_budget: { type: "integer", minimum: 1 },
                priority: { type: "integer" },
              },
              required: ["agent_id", "provider_id", "model_id"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "assignments"],
        additionalProperties: false,
      },
      async execute(input) {
        try {
          const profile = profileInput(input);
          const issues = await validateProfileInput(store, profile);
          const errors = issues.filter((issue) => issue.severity === "error");
          if (errors.length > 0) {
            return ok({ saved: false, issues });
          }
          const saved = await store.upsertProfile(profile);
          await store.audit("profile.set", saved.id, {
            name: saved.name,
            mode: saved.mode,
            assignments: saved.assignments.length,
            isDefault: saved.isDefault,
          });
          return ok({ saved: true, profile: saved, issues });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "model_profile_delete",
      description: "Elimina un perfil de ejecución. Requiere confirmed=true y no elimina agentes ni modelos.",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          confirmed: { type: "boolean", default: false },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input) {
        try {
          const id = asString(input.id);
          if (!id) return fail("Falta el id del perfil.");
          if (input.confirmed !== true) {
            return ok({ deleted: false, requires_confirmation: true });
          }
          const profile = await store.getProfile(id);
          if (!profile) return fail("El perfil no existe.");
          const deleted = await store.deleteProfile(id);
          await store.audit("profile.delete", id, { name: profile.name });
          return ok({ deleted, id });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "model_profile_apply",
      description:
        "Aplica un perfil a los agentes de OpenCode. Sin confirmed=true solo devuelve la vista previa. No cambia permisos, prompts ni skills.",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          confirmed: { type: "boolean", default: false },
          make_default: { type: "boolean", default: false },
          session_id: { type: "string", description: "Sesión cuyo modelo se actualiza tras aplicar el perfil." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input) {
        try {
          const id = asString(input.id);
          if (!id) return fail("Falta el id del perfil.");
          const profile = await store.getProfile(id);
          if (!profile) return fail("El perfil no existe.");
          const issues = await validateProfileInput(store, {
            id: profile.id,
            name: profile.name,
            description: profile.description,
            mode: profile.mode,
            isDefault: profile.isDefault,
            policy: profile.policy,
            assignments: profile.assignments,
          });
          const errors = issues.filter((issue) => issue.severity === "error");
          if (errors.length > 0) {
            return ok({ applied: false, issues, requires_fix: true });
          }
          if (input.confirmed !== true) {
            return ok({
              applied: false,
              requires_confirmation: true,
              profile: {
                id: profile.id,
                name: profile.name,
                assignments: profile.assignments,
              },
              issues,
            });
          }
          const result = await applyProfileFromStore(deps.mam, profile, {
            makeDefault: input.make_default === true,
            sessionId: asString(input.session_id) || undefined,
          });
          const sessionID = asString(input.session_id);
          await store.audit("profile.apply", profile.id, {
            name: profile.name,
            makeDefault: input.make_default === true,
            sessionId: sessionID || null,
            assignments: profile.assignments.length,
          });
          return ok({
            applied: true,
            profile: {
              id: profile.id,
              name: profile.name,
              isDefault: input.make_default === true || profile.isDefault,
            },
            session_updated: result.sessionUpdated,
            warnings: result.warnings,
            issues,
          });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "mam_status",
      description: "Resumen del catálogo MAM: modelos, agentes, perfiles y perfil por defecto.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        try {
          const [models, agents, profiles, defaultProfile, appliedProfile] = await Promise.all([
            store.listModels({ limit: 2_000 }),
            store.listAgents(),
            store.listProfiles(),
            store.getDefaultProfile(),
            store.getAppliedProfile(deps.mam.location),
          ]);
          const byProvider: Record<string, number> = {};
          for (const model of models) {
            byProvider[model.providerId] = (byProvider[model.providerId] ?? 0) + 1;
          }
          return ok({
            models: models.length,
            models_by_provider: byProvider,
            authorized: models.filter((model) => model.authorized && !model.prohibited).length,
            prohibited: models.filter((model) => model.prohibited).length,
            agents: agents.length,
            agents_with_model: agents.filter((agent) => agent.modelProvider && agent.modelId).length,
            profiles: profiles.length,
            default_profile: defaultProfile
              ? { id: defaultProfile.id, name: defaultProfile.name, assignments: defaultProfile.assignments.length }
              : null,
            applied_profile_id: appliedProfile,
          });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

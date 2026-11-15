/**
 * Perfiles de ejecución predeterminados de la fábrica.
 *
 * Son plantillas seguras: no se aplican solas. `seedBuiltinProfiles()` las crea
 * en PostgreSQL si faltan, y el usuario decide cuál aplicar desde Models.
 *
 * Los modelos se eligieron del catálogo real (2026-11-14) con tools=true y
 * contexto >= 128k. Si un modelo desaparece, la validación impide sembrar el
 * perfil y se registra el motivo.
 */

import type { ExecutionProfileWithAssignments, ProfileInput } from "./mam-db.js";

type ModelChoice = [providerId: string, modelId: string, tokenBudget: number, maxCostUsd: number];

type ProfileSpec = {
  name: string;
  description: string;
  mode: ProfileInput["mode"];
  policy: Record<string, unknown>;
  models: Record<string, ModelChoice>;
};

const M = {
  flash: ["opencode-go", "deepseek-v4.1-flash"],
  pro: ["opencode-go", "deepseek-v4-pro"],
  haiku: ["opencode-go", "claude-haiku-5-5"],
  glm: ["opencode-go", "glm-5.3"],
  glmFlash: ["opencode-go", "glm-5.3-flash"],
  mini: ["opencode-go", "minimax-m3"],
  miniFlash: ["opencode-go", "minimax-m3.1-flash"],
  luna: ["opencode-go", "gpt-6-luna"],
  longcatFree: ["opencode-go", "longcat-2.5-free"],
  dsFree: ["opencode", "deepseek-v4.1-flash-free"],
  glmFree: ["opencode", "glm-5.3-flash-free"],
  miniFree: ["opencode", "minimax-m3.1-flash-free"],
  inkFree: ["opencode", "inkling-2-small-free"],
  sonnet: ["opencode", "claude-sonnet-5-5"],
  gptMini: ["opencode", "gpt-5.4-mini"],
  gemini: ["opencode", "gemini-4-hydrogen"],
} as const;

const AGENTS = [
  "factory",
  "build",
  "plan",
  "explore",
  "general",
  "product-analyst",
  "architect",
  "implementer",
  "code-reviewer",
  "security-reviewer",
  "qa-engineer",
  "tech-writer",
  "devops-engineer",
  "plan-reviewer",
  "memory-consolidator",
  "helper",
  "researcher",
];

const EXPENSIVE_MODELS = [
  "opencode/gpt-5.5-pro",
  "opencode/gpt-6-astra",
  "opencode/claude-fable-5",
  "opencode/claude-fable-5-1",
  "opencode/claude-fable-5-2",
  "opencode/claude-opus-4-5",
  "opencode/claude-opus-4-6",
  "opencode/claude-opus-4-7",
  "opencode/claude-opus-4-8",
  "opencode/claude-opus-5",
  "opencode/claude-opus-5-5",
  "opencode/gpt-5.5",
  "opencode/gpt-5.6-sol",
  "opencode-go/kimi-k3",
  "opencode-go/qwen3.8-max",
  "opencode/gemini-4-argon",
];

const basePolicy = {
  minContext: 128_000,
  requireTools: true,
  noSilentFallback: true,
  prohibitedModels: EXPENSIVE_MODELS,
};

function assignment(
  agentId: string,
  [providerId, modelId, tokenBudget, maxCostUsd]: ModelChoice,
) {
  return {
    agentId,
    providerId,
    modelId,
    variant: null,
    locked: true,
    tokenBudget,
    maxCostUsd,
    priority: 0,
  };
}

function assignments(models: Record<string, ModelChoice>) {
  return AGENTS.filter((agent) => models[agent] !== undefined).map((agent) =>
    assignment(agent, models[agent]!),
  );
}

const SPECS: ProfileSpec[] = [
  {
    name: "Programación básica",
    description:
      "Perfil económico para aprender y programar scripts, ejercicios y cambios pequeños. Modelos rápidos con buen soporte de herramientas.",
    mode: "manual",
    policy: { ...basePolicy, allowedProviders: ["opencode-go"] },
    models: {
      factory: [M.flash[0], M.flash[1], 64_000, 0.15],
      build: [M.flash[0], M.flash[1], 64_000, 0.15],
      plan: [M.flash[0], M.flash[1], 48_000, 0.12],
      explore: [M.glmFlash[0], M.glmFlash[1], 32_000, 0.06],
      general: [M.flash[0], M.flash[1], 48_000, 0.12],
      "product-analyst": [M.glmFlash[0], M.glmFlash[1], 24_000, 0.05],
      architect: [M.pro[0], M.pro[1], 48_000, 0.15],
      implementer: [M.flash[0], M.flash[1], 64_000, 0.15],
      "code-reviewer": [M.haiku[0], M.haiku[1], 24_000, 0.05],
      "security-reviewer": [M.haiku[0], M.haiku[1], 24_000, 0.05],
      "qa-engineer": [M.miniFlash[0], M.miniFlash[1], 32_000, 0.08],
      "tech-writer": [M.luna[0], M.luna[1], 24_000, 0.05],
      "devops-engineer": [M.glmFlash[0], M.glmFlash[1], 24_000, 0.05],
      "plan-reviewer": [M.haiku[0], M.haiku[1], 16_000, 0.04],
      "memory-consolidator": [M.glmFlash[0], M.glmFlash[1], 16_000, 0.04],
      helper: [M.glmFlash[0], M.glmFlash[1], 16_000, 0.04],
      researcher: [M.flash[0], M.flash[1], 32_000, 0.08],
    },
  },
  {
    name: "Proyecto grande",
    description:
      "Perfil para monorepos y arquitecturas grandes: modelos de razonamiento y coding fuerte, contexto amplio y presupuestos mayores.",
    mode: "hybrid",
    policy: {
      ...basePolicy,
      allowedProviders: ["opencode-go", "opencode"],
      allowedModels: [
        "opencode-go/deepseek-v4.1-flash",
        "opencode-go/deepseek-v4-pro",
        "opencode-go/claude-haiku-5-5",
        "opencode-go/glm-5.3",
        "opencode-go/glm-5.3-flash",
        "opencode-go/minimax-m3",
        "opencode-go/minimax-m3.1-flash",
        "opencode-go/gpt-6-luna",
        "opencode/claude-sonnet-5-5",
        "opencode/gpt-5.4-mini",
        "opencode/gemini-4-hydrogen",
      ],
    },
    models: {
      factory: [M.flash[0], M.flash[1], 200_000, 0.4],
      build: [M.sonnet[0], M.sonnet[1], 200_000, 2.5],
      plan: [M.pro[0], M.pro[1], 200_000, 0.6],
      explore: [M.glmFlash[0], M.glmFlash[1], 32_000, 0.06],
      general: [M.flash[0], M.flash[1], 64_000, 0.15],
      "product-analyst": [M.pro[0], M.pro[1], 64_000, 0.2],
      architect: [M.pro[0], M.pro[1], 200_000, 0.6],
      implementer: [M.sonnet[0], M.sonnet[1], 200_000, 2.5],
      "code-reviewer": [M.gptMini[0], M.gptMini[1], 64_000, 0.4],
      "security-reviewer": [M.gemini[0], M.gemini[1], 64_000, 0.8],
      "qa-engineer": [M.mini[0], M.mini[1], 64_000, 0.2],
      "tech-writer": [M.luna[0], M.luna[1], 48_000, 0.1],
      "devops-engineer": [M.glm[0], M.glm[1], 64_000, 0.2],
      "plan-reviewer": [M.haiku[0], M.haiku[1], 48_000, 0.1],
      "memory-consolidator": [M.glmFlash[0], M.glmFlash[1], 32_000, 0.06],
      helper: [M.glmFlash[0], M.glmFlash[1], 32_000, 0.06],
      researcher: [M.flash[0], M.flash[1], 64_000, 0.15],
    },
  },
  {
    name: "Proyectos pequeños y medianos",
    description:
      "Perfil equilibrado para proyectos normales: buen coding y revisión sin pagar modelos de gama alta.",
    mode: "manual",
    policy: { ...basePolicy, allowedProviders: ["opencode-go"] },
    models: {
      factory: [M.flash[0], M.flash[1], 96_000, 0.2],
      build: [M.flash[0], M.flash[1], 96_000, 0.2],
      plan: [M.flash[0], M.flash[1], 64_000, 0.15],
      explore: [M.glmFlash[0], M.glmFlash[1], 32_000, 0.06],
      general: [M.flash[0], M.flash[1], 64_000, 0.15],
      "product-analyst": [M.glmFlash[0], M.glmFlash[1], 32_000, 0.06],
      architect: [M.pro[0], M.pro[1], 64_000, 0.2],
      implementer: [M.flash[0], M.flash[1], 96_000, 0.2],
      "code-reviewer": [M.haiku[0], M.haiku[1], 32_000, 0.06],
      "security-reviewer": [M.haiku[0], M.haiku[1], 32_000, 0.06],
      "qa-engineer": [M.miniFlash[0], M.miniFlash[1], 48_000, 0.1],
      "tech-writer": [M.luna[0], M.luna[1], 32_000, 0.06],
      "devops-engineer": [M.glmFlash[0], M.glmFlash[1], 32_000, 0.06],
      "plan-reviewer": [M.haiku[0], M.haiku[1], 24_000, 0.05],
      "memory-consolidator": [M.glmFlash[0], M.glmFlash[1], 24_000, 0.05],
      helper: [M.glmFlash[0], M.glmFlash[1], 24_000, 0.05],
      researcher: [M.flash[0], M.flash[1], 48_000, 0.12],
    },
  },
  {
    name: "Preguntas básicas",
    description:
      "Perfil sin coste para dudas, resúmenes y uso ocasional. Usa modelos gratuitos; si el proveedor limita, cambia a Programación básica.",
    mode: "manual",
    policy: { ...basePolicy, allowedProviders: ["opencode-go", "opencode"] },
    models: {
      factory: [M.longcatFree[0], M.longcatFree[1], 32_000, 0.01],
      build: [M.longcatFree[0], M.longcatFree[1], 32_000, 0.01],
      plan: [M.longcatFree[0], M.longcatFree[1], 32_000, 0.01],
      explore: [M.glmFree[0], M.glmFree[1], 16_000, 0.01],
      general: [M.longcatFree[0], M.longcatFree[1], 32_000, 0.01],
      "product-analyst": [M.longcatFree[0], M.longcatFree[1], 24_000, 0.01],
      architect: [M.longcatFree[0], M.longcatFree[1], 32_000, 0.01],
      implementer: [M.dsFree[0], M.dsFree[1], 32_000, 0.01],
      "code-reviewer": [M.dsFree[0], M.dsFree[1], 24_000, 0.01],
      "security-reviewer": [M.dsFree[0], M.dsFree[1], 24_000, 0.01],
      "qa-engineer": [M.miniFree[0], M.miniFree[1], 24_000, 0.01],
      "tech-writer": [M.longcatFree[0], M.longcatFree[1], 24_000, 0.01],
      "devops-engineer": [M.glmFree[0], M.glmFree[1], 24_000, 0.01],
      "plan-reviewer": [M.dsFree[0], M.dsFree[1], 16_000, 0.01],
      "memory-consolidator": [M.glmFree[0], M.glmFree[1], 16_000, 0.01],
      helper: [M.glmFree[0], M.glmFree[1], 16_000, 0.01],
      researcher: [M.inkFree[0], M.inkFree[1], 32_000, 0.01],
    },
  },
  {
    name: "Linux",
    description:
      "Perfil para administración, shell, systemd, contenedores y depuración en Linux. Prioriza herramientas y comandos seguros.",
    mode: "manual",
    policy: { ...basePolicy, allowedProviders: ["opencode-go"] },
    models: {
      factory: [M.flash[0], M.flash[1], 64_000, 0.15],
      build: [M.flash[0], M.flash[1], 64_000, 0.15],
      plan: [M.flash[0], M.flash[1], 64_000, 0.15],
      explore: [M.glmFlash[0], M.glmFlash[1], 32_000, 0.06],
      general: [M.flash[0], M.flash[1], 64_000, 0.15],
      "product-analyst": [M.glmFlash[0], M.glmFlash[1], 32_000, 0.06],
      architect: [M.pro[0], M.pro[1], 64_000, 0.2],
      implementer: [M.flash[0], M.flash[1], 64_000, 0.15],
      "code-reviewer": [M.haiku[0], M.haiku[1], 32_000, 0.06],
      "security-reviewer": [M.haiku[0], M.haiku[1], 32_000, 0.06],
      "qa-engineer": [M.miniFlash[0], M.miniFlash[1], 32_000, 0.08],
      "tech-writer": [M.luna[0], M.luna[1], 32_000, 0.06],
      "devops-engineer": [M.glm[0], M.glm[1], 64_000, 0.2],
      "plan-reviewer": [M.haiku[0], M.haiku[1], 24_000, 0.05],
      "memory-consolidator": [M.glmFlash[0], M.glmFlash[1], 24_000, 0.05],
      helper: [M.glmFlash[0], M.glmFlash[1], 24_000, 0.05],
      researcher: [M.flash[0], M.flash[1], 48_000, 0.12],
    },
  },
  {
    name: "Estudiar",
    description:
      "Perfil para estudiar y explicar temas: razonamiento largo, contexto amplio y coste moderado.",
    mode: "manual",
    policy: { ...basePolicy, allowedProviders: ["opencode-go"] },
    models: {
      factory: [M.flash[0], M.flash[1], 64_000, 0.15],
      build: [M.pro[0], M.pro[1], 128_000, 0.35],
      plan: [M.pro[0], M.pro[1], 128_000, 0.35],
      explore: [M.flash[0], M.flash[1], 64_000, 0.15],
      general: [M.flash[0], M.flash[1], 64_000, 0.15],
      "product-analyst": [M.pro[0], M.pro[1], 64_000, 0.2],
      architect: [M.pro[0], M.pro[1], 96_000, 0.3],
      implementer: [M.flash[0], M.flash[1], 64_000, 0.15],
      "code-reviewer": [M.haiku[0], M.haiku[1], 32_000, 0.06],
      "security-reviewer": [M.haiku[0], M.haiku[1], 32_000, 0.06],
      "qa-engineer": [M.miniFlash[0], M.miniFlash[1], 32_000, 0.08],
      "tech-writer": [M.luna[0], M.luna[1], 64_000, 0.1],
      "devops-engineer": [M.glmFlash[0], M.glmFlash[1], 32_000, 0.06],
      "plan-reviewer": [M.haiku[0], M.haiku[1], 32_000, 0.06],
      "memory-consolidator": [M.glmFlash[0], M.glmFlash[1], 24_000, 0.05],
      helper: [M.glmFlash[0], M.glmFlash[1], 24_000, 0.05],
      researcher: [M.flash[0], M.flash[1], 64_000, 0.15],
    },
  },
];

export const BUILTIN_PROFILES: ProfileInput[] = SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  mode: spec.mode,
  isDefault: false,
  policy: spec.policy,
  assignments: assignments(spec.models),
}));

export const BUILTIN_PROFILE_NAMES = BUILTIN_PROFILES.map((profile) => profile.name);

export type BuiltinProfileName = (typeof BUILTIN_PROFILE_NAMES)[number];

export function builtinProfileSummary(
  profile: ExecutionProfileWithAssignments,
): { name: string; description: string | null; assignments: number } {
  return {
    name: profile.name,
    description: profile.description,
    assignments: profile.assignments.length,
  };
}

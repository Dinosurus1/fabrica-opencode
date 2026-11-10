/**
 * Ruteo de modelos por familia.
 *
 * Regla de oro: el revisor de una tarea no puede ser de la misma familia que
 * quien la escribió. Este módulo es la única fuente de verdad del mapa; los
 * prompts no hardcodean modelos.
 *
 * Kimi K2.7 no está en el ruteo normal: solo se usa como escalado manual para
 * bugs/arquitectura compleja.
 */

export type ModelFamily = "deepseek" | "glm" | "claude" | "kimi" | "minimax" | "gpt" | "gemini" | "other";
export type ReviewRole = "security" | "code" | "qa" | "plan";

export const MODELS = {
  orchestrator: "opencode-go/deepseek-v4.1-flash",
  implementer: "opencode-go/glm-5.3-flash",
  implementerEasy: "opencode-go/gpt-6-luna",
  security: "opencode-go/glm-5.3-flash",
  code: "opencode-go/claude-haiku-5-5",
  qa: "opencode-go/minimax-m3",
  qaEasy: "opencode-go/gpt-6-luna",
  plan: "opencode-go/claude-haiku-5-5",
  escalation: "opencode-go/kimi-k2.7-code",
} as const;

export function modelFamily(model: string): ModelFamily {
  const id = model.split("/").pop()?.toLowerCase() ?? "";
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("glm")) return "glm";
  if (id.includes("claude")) return "claude";
  if (id.includes("kimi")) return "kimi";
  if (id.includes("minimax")) return "minimax";
  if (id.includes("gpt")) return "gpt";
  if (id.includes("gemini")) return "gemini";
  return "other";
}

export function sameFamily(left: string, right: string): boolean {
  const a = modelFamily(left);
  const b = modelFamily(right);
  return a !== "other" && a === b;
}

function securityFor(author: string): string {
  return modelFamily(author) === "glm" ? MODELS.orchestrator : MODELS.security;
}

function codeFor(author: string): string {
  return modelFamily(author) === "claude" ? MODELS.orchestrator : MODELS.code;
}

function qaFor(author: string): string {
  return modelFamily(author) === "minimax" ? MODELS.qaEasy : MODELS.qa;
}

/**
 * Devuelve el modelo del revisor. `plan` usa el orquestador como autor.
 */
export function routeReview(authorModel: string, role: ReviewRole): string {
  const author = authorModel.trim() || MODELS.orchestrator;
  switch (role) {
    case "security":
      return securityFor(author);
    case "code":
      return codeFor(author);
    case "qa":
      return qaFor(author);
    case "plan":
      return modelFamily(author) === "claude" ? MODELS.security : MODELS.plan;
  }
}

export function routeReviewMap(authorModel: string): Record<Exclude<ReviewRole, "plan">, string> {
  return {
    security: routeReview(authorModel, "security"),
    code: routeReview(authorModel, "code"),
    qa: routeReview(authorModel, "qa"),
  };
}

/** Modelo de implementación por dificultad; el plan puede sobrescribirlo. */
export function defaultImplementerModel(difficulty: "easy" | "medium" | "hard"): string {
  return difficulty === "easy" ? MODELS.implementer : MODELS.orchestrator;
}

export function defaultAssignee(difficulty: "easy" | "medium" | "hard"): "orchestrator" | "implementer" {
  return difficulty === "easy" ? "implementer" : "orchestrator";
}

export function escalationModel(): string {
  return MODELS.escalation;
}

export function assertDifferentFamily(authorModel: string, reviewerModel: string, role: ReviewRole): void {
  if (sameFamily(authorModel, reviewerModel)) {
    throw new Error(
      `El revisor ${role} (${reviewerModel}) es de la misma familia que el autor (${authorModel}); elige otro modelo.`,
    );
  }
}

/**
 * Clasificación determinística de un prompt para sugerir un perfil.
 *
 * No sustituye a `profiles.recommend` (que analiza el proyecto): lo combina.
 * Si el prompt es un traspaso de sesión, se ignora para no clasificar el texto
 * del propio traspaso como si fuera un pedido nuevo.
 */
import type { ProfileRecommendation } from "./types";

export interface PromptRecommendation {
  recommended: string;
  confidence: number;
  reasons: string[];
  scores: Record<string, number>;
  source: "prompt" | "project";
}

const HANDOFF_MARKERS = [
  "# Traspaso de sesión",
  "Continuación de la sesión",
  "## Último pedido",
  "## Restricciones vigentes",
];

export function isHandoffText(text: string): boolean {
  const clean = text.trimStart();
  return HANDOFF_MARKERS.some((marker) => clean.startsWith(marker) || clean.includes(marker));
}

export function analyzePrompt(text: string): PromptRecommendation {
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  const scores: Record<string, number> = {
    "Preguntas básicas": 0,
    "Programación básica": 0,
    "Proyectos pequeños y medianos": 0,
    "Proyecto grande": 0,
    Linux: 0,
    Estudiar: 0,
  };
  const reasons: string[] = [];

  if (!clean || clean.length < 20 || isHandoffText(text)) {
    return {
      recommended: "",
      confidence: 0,
      reasons: ["prompt demasiado corto o es un traspaso"],
      scores,
      source: "prompt",
    };
  }

  const add = (name: string, value: number, reason?: string) => {
    scores[name] = (scores[name] ?? 0) + value;
    if (reason) reasons.push(reason);
  };

  if (/\b(plan|planific|roadmap|fase|arquitect|diseñ|migra|refactor|monorepo|microserv|escala|complej|multi[- ]?módulo|sistema grande)\b/i.test(lower)) {
    add("Proyecto grande", 4, "el pedido habla de planificación, arquitectura o alcance grande");
  }
  if (/\b(implementa|añade|agrega|arregla|corrige|bug|fallo|error|test|prueba|código|codigo|función|funcion|endpoint|componente|react|api|sql|typescript|python|refactoriza)\b/i.test(lower)) {
    add("Proyectos pequeños y medianos", 3, "el pedido implica tocar código");
  }
  if (/\b(linux|systemd|nix|arch|hyprland|docker|podman|kernel|bash|servidor|vps|tailscale|ssh)\b/i.test(lower)) {
    add("Linux", 4, "hay señales de sistema operativo o infraestructura");
  }
  if (/\b(estudiar|examen|apunte|nota|curso|tutorial|resumen|tesis|universidad|pdf|libro|memorizar)\b/i.test(lower)) {
    add("Estudiar", 4, "el pedido es material de estudio");
  }
  if (clean.length < 140 && /^(qué|que|cómo|como|cuál|cual|cuándo|cuando|dónde|donde|por qué|por que|explica|dime|resume|hola)\b/i.test(lower)) {
    add("Preguntas básicas", 3, "es una pregunta corta y concreta");
  }
  if (/\b(snippet|script|ejemplo|fragmento|plantilla)\b/i.test(lower) && clean.length < 400) {
    add("Programación básica", 2, "es un ejemplo o fragmento pequeño");
  }

  const ranked = Object.entries(scores)
    .map(([name, score]) => ({ name, score }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  const top = ranked[0] ?? { name: "Preguntas básicas", score: 0 };
  const second = ranked[1] ?? { name: "", score: 0 };
  if (top.score === 0) {
    return {
      recommended: "Preguntas básicas",
      confidence: 0.45,
      reasons: ["sin señales claras; se sugiere el perfil más seguro"],
      scores,
      source: "prompt",
    };
  }
  const margin = (top.score - second.score) / Math.max(1, top.score);
  const confidence = Math.min(0.95, 0.55 + Math.min(0.3, top.score * 0.06) + margin * 0.15);
  return {
    recommended: top.name,
    confidence: Math.round(confidence * 100) / 100,
    reasons,
    scores,
    source: "prompt",
  };
}

/**
 * Combina la recomendación del proyecto (archivos, tests, tamaño) con la del
 * prompt. El prompt manda si tiene confianza suficiente y no es un traspaso.
 */
export function combinePromptAndProject(
  prompt: PromptRecommendation,
  project: ProfileRecommendation | undefined,
): PromptRecommendation {
  const projectName = project?.profile?.name ?? project?.recommended ?? "";
  if (prompt.recommended && prompt.confidence >= 0.62) {
    return {
      ...prompt,
      reasons:
        projectName && projectName !== prompt.recommended
          ? [`prompt: ${prompt.reasons[0] ?? "encaje del pedido"}`, `proyecto: ${projectName}`]
          : prompt.reasons,
      source: "prompt",
    };
  }
  if (projectName) {
    return {
      recommended: projectName,
      confidence: project?.confidence ?? 0.55,
      reasons: project?.reasons?.slice(0, 2) ?? ["recomendación del proyecto"],
      scores: project?.scores ?? {},
      source: "project",
    };
  }
  return prompt;
}

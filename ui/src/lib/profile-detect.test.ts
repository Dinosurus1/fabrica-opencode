import { describe, expect, it } from "vitest";
import { analyzePrompt, combinePromptAndProject, isHandoffText } from "./profile-detect";
import type { ProfileRecommendation } from "./types";

const project: ProfileRecommendation = {
  recommended: "Proyectos pequeños y medianos",
  confidence: 0.64,
  scores: {},
  reasons: ["120 archivos de código"],
  alternatives: [],
  profile: { id: "p-small", name: "Proyectos pequeños y medianos" },
};

describe("analyzePrompt", () => {
  it("detecta planificación y arquitectura", () => {
    const result = analyzePrompt(
      "Haz un plan por fases para refactorizar la arquitectura y migrar el monolito a módulos.",
    );
    expect(result.recommended).toBe("Proyecto grande");
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it("detecta material de estudio", () => {
    const result = analyzePrompt("Resume este PDF del examen y hazme apuntes para estudiar la unidad.");
    expect(result.recommended).toBe("Estudiar");
  });

  it("detecta preguntas cortas", () => {
    const result = analyzePrompt("¿Qué es un índice en PostgreSQL?");
    expect(result.recommended).toBe("Preguntas básicas");
  });

  it("detecta Linux", () => {
    const result = analyzePrompt("Configura systemd y nix para levantar el servidor en Arch.");
    expect(result.recommended).toBe("Linux");
  });

  it("ignora un traspaso", () => {
    const result = analyzePrompt("# Traspaso de sesión\n\n## Objetivo\nPlanificar la fase 3");
    expect(result.recommended).toBe("");
    expect(isHandoffText("# Traspaso de sesión\n...")).toBe(true);
  });
});

describe("combinePromptAndProject", () => {
  it("usa el prompt si tiene confianza", () => {
    const prompt = analyzePrompt("Haz un plan por fases y revisa la arquitectura del sistema.");
    const result = combinePromptAndProject(prompt, project);
    expect(result.source).toBe("prompt");
    expect(result.recommended).toBe("Proyecto grande");
  });

  it("cae al proyecto cuando el prompt no tiene señales", () => {
    const prompt = analyzePrompt("");
    const result = combinePromptAndProject(prompt, project);
    expect(result.source).toBe("project");
    expect(result.recommended).toBe("Proyectos pequeños y medianos");
  });
});

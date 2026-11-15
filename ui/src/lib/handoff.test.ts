import { describe, expect, it } from "vitest";
import { applyPinnedSections, buildHandoff, estimateTokens } from "./handoff";
import type { Session, SessionMessage } from "./types";

const session: Session = {
  id: "ses_1",
  projectID: "prj_1",
  agent: "factory",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0 },
  time: { created: 1, updated: 2 },
  title: "Continuación · Continuación · Actualización de Factory",
};

function message(type: "user" | "assistant", text: string, id = `${type}-${text.length}`): SessionMessage {
  return { id, type, content: [{ type: "text", text }] };
}

describe("buildHandoff", () => {
  it("copia el último pedido completo sin truncar", () => {
    const request = `Pedido ${"x".repeat(1500)}`;
    const handoff = buildHandoff({
      session,
      messages: [message("user", "primer pedido"), message("assistant", "estado"), message("user", request)],
    });
    expect(handoff.lastRequest).toBe(request);
    expect(handoff.text).toContain(request);
    expect(handoff.objective).toBe("Actualización de Factory");
  });

  it("extrae el pedido textual de un traspaso anterior en lugar de anidarlo", () => {
    const original = `Arregla los bugs de la fase 2 ${"y".repeat(500)}`;
    const previous = [
      "# Traspaso de sesión",
      "## Objetivo",
      "Actualización de Factory",
      "## Último pedido (textual)",
      original,
      "## Hecho",
      "- Fase 1 cerrada",
      "## Pendiente",
      "- Comandos",
    ].join("\n");
    const handoff = buildHandoff({
      session,
      messages: [message("user", previous), message("assistant", "sigo aquí")],
    });
    expect(handoff.lastRequest).toBe(original);
    expect(handoff.done).toContain("Fase 1 cerrada");
    expect(handoff.pending).toContain("Comandos");
  });

  it("incluye repo, restricciones y checklist del asistente", () => {
    const handoff = buildHandoff({
      session,
      messages: [
        message("user", "implementa /status"),
        message("assistant", "## Hecho\n- endpoint\n## En curso\n- tests\n## Pendiente\n- docs"),
      ],
      repo: {
        ok: true,
        branch: "factory/fase-2",
        last_commit: "abc123 feat: x",
        dirty: ["M ui/src/pages/Sessions.tsx"],
        clean: false,
      },
    });
    expect(handoff.branch).toBe("factory/fase-2");
    expect(handoff.lastCommit).toBe("abc123 feat: x");
    expect(handoff.files).toEqual(["M ui/src/pages/Sessions.tsx"]);
    expect(handoff.done).toContain("endpoint");
    expect(handoff.doing).toContain("tests");
    expect(handoff.pending).toContain("docs");
    expect(handoff.constraints.some((item) => item.includes("No subir claves"))).toBe(true);
  });

  it("recorta solo el estado del asistente y lo marca", () => {
    const handoff = buildHandoff({
      session,
      messages: [message("user", "hola"), message("assistant", "z".repeat(5_000))],
    });
    expect(handoff.truncated).toBe(true);
    expect(handoff.lastAssistant).toContain("recortado a 4000 caracteres");
    expect(estimateTokens(handoff.text)).toBe(handoff.tokens);
  });

  it("marca elementos fijados sin duplicar la línea", () => {
    const handoff = buildHandoff({
      session,
      messages: [message("user", "hola")],
    });
    const once = applyPinnedSections(handoff.text, ["lastRequest", "constraints"]);
    const twice = applyPinnedSections(once, ["lastRequest"]);
    expect(once).toContain("Elementos fijados: Último pedido, Restricciones");
    expect(twice).toContain("Elementos fijados: Último pedido.");
    expect(twice.match(/Elementos fijados:/g)).toHaveLength(1);
  });
});

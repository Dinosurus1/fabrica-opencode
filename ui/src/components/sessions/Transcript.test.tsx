import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../../lib/types";
import { buildTurns, Transcript } from "./Transcript";

const messages: SessionMessage[] = [
  {
    id: "u1",
    type: "user",
    text: "Hola, revisa el README",
    time: { created: 1 },
  },
  {
    id: "a1",
    type: "assistant",
    content: [{ type: "text", text: "Voy a revisarlo." }],
    agent: "factory",
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    time: { created: 2 },
  },
  {
    id: "a2",
    type: "assistant",
    content: [{ type: "text", text: "Listo: no hay cambios." }],
    time: { created: 3 },
  },
];

describe("Transcript", () => {
  it("agrupa turnos consecutivos del asistente", () => {
    const turns = buildTurns(messages);
    expect(turns.map((turn) => turn.kind)).toEqual(["user", "assistant"]);
    expect(turns[1]?.messages).toHaveLength(2);
  });

  it("renderiza el texto del usuario y del asistente", () => {
    render(<Transcript messages={messages} running={false} sessionId="ses_test" />);
    expect(screen.getByText(/Hola, revisa el README/)).toBeInTheDocument();
    expect(screen.getByText(/Voy a revisarlo/)).toBeInTheDocument();
    expect(screen.getByText(/Listo: no hay cambios/)).toBeInTheDocument();
  });
});

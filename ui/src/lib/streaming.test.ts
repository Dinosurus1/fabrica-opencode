import { describe, expect, it } from "vitest";
import {
  applyStreamEvent,
  clearSessionStreams,
  clearSettledStreams,
  mergeStreamMessages,
} from "./streaming";
import type { LiveEvent } from "./events";
import type { SessionMessage } from "./types";

function delta(
  type: string,
  data: Record<string, unknown>,
  created = 1_700_000_000_000,
): LiveEvent {
  return { type, created, data };
}

const start = {
  type: "session.text.started",
  data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 },
};

function feed(events: LiveEvent[]) {
  return events.reduce(applyStreamEvent, {});
}

describe("applyStreamEvent", () => {
  it("acumula deltas por ordinal y conserva el orden", () => {
    const state = feed([
      delta("session.text.started", start.data),
      delta("session.text.delta", { ...start.data, delta: "Hola " }),
      delta("session.text.delta", { ...start.data, delta: "mundo" }),
      delta("session.text.started", { ...start.data, ordinal: 2 }),
      delta("session.text.delta", { ...start.data, ordinal: 2, delta: "!" }),
    ]);
    const message = mergeStreamMessages([], state, "ses_1")[0];
    expect(message.content).toEqual([
      { type: "text", text: "Hola mundo!" },
    ]);
  });

  it("separa razonamiento y texto", () => {
    const state = feed([
      delta("session.reasoning.started", { ...start.data, ordinal: 0 }),
      delta("session.reasoning.delta", { ...start.data, delta: "pienso" }),
      delta("session.text.started", { ...start.data, ordinal: 1 }),
      delta("session.text.delta", { ...start.data, ordinal: 1, delta: "respondo" }),
    ]);
    const message = mergeStreamMessages([], state, "ses_1")[0];
    expect(message.content).toEqual([
      { type: "reasoning", text: "pienso" },
      { type: "text", text: "respondo" },
    ]);
  });

  it("ignora eventos de otra sesión", () => {
    const state = feed([
      delta("session.text.delta", { sessionID: "ses_2", assistantMessageID: "msg_2", delta: "x" }),
    ]);
    expect(mergeStreamMessages([], state, "ses_1")).toEqual([]);
  });

  it("no duplica el mensaje cuando ya está en el contexto", () => {
    const base: SessionMessage[] = [
      {
        id: "msg_1",
        type: "assistant",
        content: [
          { type: "text", text: "Hola" },
          { type: "tool", tool: "bash" },
        ],
      },
    ];
    const state = feed([
      delta("session.text.started", start.data),
      delta("session.text.delta", { ...start.data, delta: "Hola mundo" }),
    ]);
    const merged = mergeStreamMessages(base, state, "ses_1");
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toEqual([
      { type: "text", text: "Hola mundo" },
      { type: "tool", tool: "bash" },
    ]);
  });

  it("borra los buffers de una sesión eliminada", () => {
    const state = feed([
      delta("session.text.delta", { ...start.data, delta: "x" }),
      delta("session.text.delta", { sessionID: "ses_2", assistantMessageID: "msg_2", delta: "y" }),
    ]);
    const next = applyStreamEvent(state, delta("session.deleted", { sessionID: "ses_1" }));
    expect(Object.keys(next)).toHaveLength(1);
    expect(mergeStreamMessages([], next, "ses_1")).toEqual([]);
  });
});

describe("clearSettledStreams", () => {
  const state = feed([
    delta("session.text.delta", { ...start.data, delta: "final" }),
    delta("session.text.delta", { sessionID: "ses_2", assistantMessageID: "msg_2", delta: "otra" }),
  ]);

  it("descarta el buffer cuando el mensaje final ya llegó", () => {
    const settled: SessionMessage[] = [
      { id: "msg_1", type: "assistant", content: [{ type: "text", text: "final" }] },
    ];
    const next = clearSettledStreams(state, "ses_1", settled);
    expect(mergeStreamMessages([], next, "ses_1")).toEqual([]);
    expect(mergeStreamMessages([], next, "ses_2")).toHaveLength(1);
  });

  it("conserva el buffer si el contexto aún no trae el mensaje", () => {
    const next = clearSettledStreams(state, "ses_1", []);
    expect(next).toBe(state);
  });

  it("clearSessionStreams limpia solo la sesión indicada", () => {
    const next = clearSessionStreams(state, "ses_1");
    expect(mergeStreamMessages([], next, "ses_1")).toEqual([]);
    expect(mergeStreamMessages([], next, "ses_2")).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  applyPermissionEvent,
  pendingPermissionCount,
  permissionActionLabel,
  permissionResources,
  permissionSaveRules,
  permissionSessionIds,
  replaceSessionPermissions,
  seedPermissions,
  sessionIdFromEvent,
} from "./permissions";
import type { PermissionRequest } from "./types";

const request: PermissionRequest = {
  id: "per_1",
  sessionID: "ses_1",
  action: "shell",
  resources: ["git status --short"],
  save: ["git status *"],
};

describe("permissionActionLabel", () => {
  it("traduce las acciones conocidas", () => {
    expect(permissionActionLabel("shell")).toBe("Ejecutar comandos");
    expect(permissionActionLabel("read")).toBe("Leer archivos");
  });

  it("usa un texto razonable para acciones desconocidas", () => {
    expect(permissionActionLabel("custom-tool")).toBe("Permiso para custom-tool");
    expect(permissionActionLabel("")).toBe("Permiso");
  });
});

describe("permissionResources / permissionSaveRules", () => {
  it("limpia recursos vacíos y conserva el orden", () => {
    expect(
      permissionResources({ ...request, resources: [" ls ", "", "git log"] }),
    ).toEqual(["ls", "git log"]);
    expect(permissionSaveRules({ ...request, save: [" echo * ", ""] })).toEqual(["echo *"]);
    expect(permissionResources({ ...request, resources: undefined as unknown as string[] })).toEqual([]);
  });
});

describe("applyPermissionEvent", () => {
  it("añade la solicitud sin duplicarla", () => {
    const event = { type: "permission.asked", data: { sessionID: "ses_1", id: "per_1" } };
    const once = applyPermissionEvent({}, event);
    expect(once).toEqual({ ses_1: ["per_1"] });
    expect(applyPermissionEvent(once, event)).toBe(once);
  });

  it("retira solo la solicitud respondida", () => {
    const state = { ses_1: ["per_1", "per_2"] };
    const next = applyPermissionEvent(state, {
      type: "permission.replied",
      data: { sessionID: "ses_1", requestID: "per_1" },
    });
    expect(next).toEqual({ ses_1: ["per_2"] });
    expect(state).toEqual({ ses_1: ["per_1", "per_2"] });
  });

  it("elimina la sesión cuando ya no queda nada pendiente", () => {
    const next = applyPermissionEvent(
      { ses_1: ["per_1"] },
      { type: "permission.replied", data: { sessionID: "ses_1", requestID: "per_1" } },
    );
    expect(next).toEqual({});
  });

  it("ignora eventos sin sesión o sin id", () => {
    const state = { ses_1: ["per_1"] };
    expect(applyPermissionEvent(state, { type: "permission.asked", data: {} })).toBe(state);
    expect(
      applyPermissionEvent(state, { type: "permission.asked", data: { sessionID: "ses_1" } }),
    ).toBe(state);
    expect(applyPermissionEvent(state, { type: "session.idle", data: { sessionID: "ses_1" } })).toBe(
      state,
    );
  });
});

describe("sessionIdFromEvent", () => {
  it("extrae el sessionID cuando es válido", () => {
    expect(sessionIdFromEvent({ type: "permission.asked", data: { sessionID: "ses_1" } })).toBe(
      "ses_1",
    );
    expect(sessionIdFromEvent({ type: "permission.asked", data: {} })).toBeNull();
  });
});

describe("seedPermissions / replaceSessionPermissions", () => {
  it("añade solicitudes de la API sin duplicados", () => {
    const seeded = seedPermissions({}, [request, { ...request, id: "per_2" }]);
    expect(seeded).toEqual({ ses_1: ["per_1", "per_2"] });
    expect(seedPermissions(seeded, [request])).toBe(seeded);
  });

  it("sincroniza una sesión y descarta lo ya respondido en otra pestaña", () => {
    const state = { ses_1: ["per_1", "per_2"], ses_2: ["per_9"] };
    const synced = replaceSessionPermissions(state, "ses_1", [{ ...request, id: "per_2" }]);
    expect(synced).toEqual({ ses_1: ["per_2"], ses_2: ["per_9"] });
    expect(replaceSessionPermissions(state, "ses_1", [])).toEqual({ ses_2: ["per_9"] });
    expect(replaceSessionPermissions(state, "ses_1", [request, { ...request, id: "per_2" }])).toBe(
      state,
    );
  });

  it("cuenta sesiones y solicitudes", () => {
    const state = { ses_1: ["per_1", "per_2"], ses_2: ["per_3"] };
    expect(permissionSessionIds(state)).toEqual(new Set(["ses_1", "ses_2"]));
    expect(pendingPermissionCount(state)).toBe(3);
  });
});

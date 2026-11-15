import type { PermissionRequest } from "./types";

/**
 * Utilidades del flujo de permisos de OpenCode V2.
 *
 * OpenCode bloquea la herramienta hasta que el cliente responde
 * (`once` | `always` | `reject`). Si nadie responde, la sesión sigue
 * «running» para siempre; por eso la consola muestra estas solicitudes y las
 * contabiliza por sesión.
 */

const ACTION_LABELS: Record<string, string> = {
  shell: "Ejecutar comandos",
  read: "Leer archivos",
  write: "Crear o escribir archivos",
  edit: "Editar archivos",
  patch: "Aplicar cambios",
  glob: "Buscar archivos",
  grep: "Buscar en el contenido",
  list: "Listar archivos",
  webfetch: "Descargar de la web",
  websearch: "Buscar en la web",
  task: "Lanzar un subagente",
  "*": "Permiso general",
};

export function permissionActionLabel(action: string): string {
  const normalized = (action ?? "").trim();
  if (!normalized) return "Permiso";
  return ACTION_LABELS[normalized] ?? `Permiso para ${normalized}`;
}

export function permissionResources(request: PermissionRequest): string[] {
  return (request.resources ?? []).map((item) => String(item).trim()).filter(Boolean);
}

/** Reglas que se guardarían al responder «Permitir siempre». */
export function permissionSaveRules(request: PermissionRequest): string[] {
  return (request.save ?? []).map((item) => String(item).trim()).filter(Boolean);
}

/** Estado por sesión: sessionID → IDs de solicitudes pendientes. */
export type PermissionState = Record<string, string[]>;

export interface PermissionEventLike {
  type: string;
  data?: Record<string, unknown> | null;
}

function addRequest(state: PermissionState, sessionID: string, requestID: string): PermissionState {
  const current = state[sessionID] ?? [];
  if (current.includes(requestID)) return state;
  return { ...state, [sessionID]: [...current, requestID] };
}

function removeRequest(state: PermissionState, sessionID: string, requestID?: string): PermissionState {
  const current = state[sessionID];
  if (!current) return state;
  const next = requestID ? current.filter((item) => item !== requestID) : [];
  if (next.length === current.length) return state;
  if (next.length === 0) {
    const { [sessionID]: _removed, ...rest } = state;
    return rest;
  }
  return { ...state, [sessionID]: next };
}

export function sessionIdFromEvent(event: PermissionEventLike): string | null {
  const value = event.data?.sessionID;
  return typeof value === "string" && value ? value : null;
}

/** Aplica `permission.asked` / `permission.replied` sin mutar el estado. */
export function applyPermissionEvent(
  state: PermissionState,
  event: PermissionEventLike,
): PermissionState {
  const sessionID = sessionIdFromEvent(event);
  if (!sessionID) return state;

  if (event.type === "permission.asked") {
    const id = event.data?.id;
    if (typeof id !== "string" || !id) return state;
    return addRequest(state, sessionID, id);
  }

  if (event.type === "permission.replied") {
    const requestID = event.data?.requestID;
    return removeRequest(state, sessionID, typeof requestID === "string" ? requestID : undefined);
  }

  return state;
}

/** Añade solicitudes conocidas por la API a las observadas por SSE. */
export function seedPermissions(
  state: PermissionState,
  requests: PermissionRequest[] | undefined,
): PermissionState {
  let next = state;
  for (const request of requests ?? []) {
    if (!request?.sessionID || !request?.id) continue;
    next = addRequest(next, request.sessionID, request.id);
  }
  return next;
}

/**
 * Sustituye el estado de una sesión por lo que dice el servidor. Sirve para
 * descartar solicitudes ya respondidas desde otra pestaña.
 */
export function replaceSessionPermissions(
  state: PermissionState,
  sessionID: string,
  requests: PermissionRequest[] | undefined,
): PermissionState {
  const ids = [...new Set((requests ?? []).map((request) => request.id).filter(Boolean))];
  const current = state[sessionID] ?? [];
  if (ids.length === current.length && ids.every((id, index) => id === current[index])) {
    return state;
  }
  if (ids.length === 0) {
    if (!(sessionID in state)) return state;
    const { [sessionID]: _removed, ...rest } = state;
    return rest;
  }
  return { ...state, [sessionID]: ids };
}

export function permissionSessionIds(state: PermissionState): Set<string> {
  return new Set(Object.keys(state));
}

export function pendingPermissionCount(state: PermissionState): number {
  return Object.values(state).reduce((total, ids) => total + ids.length, 0);
}

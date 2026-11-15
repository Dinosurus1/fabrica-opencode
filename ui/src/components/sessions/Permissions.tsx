import {
  FileCode2,
  Globe,
  ListChecks,
  Loader2,
  Search,
  ShieldAlert,
  Terminal,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { permissionActionLabel, permissionResources, permissionSaveRules } from "../../lib/permissions";
import type { PermissionDecision, PermissionRequest } from "../../lib/types";
import { Button } from "../ui";

const ACTION_ICONS: Array<{ match: RegExp; icon: typeof Terminal }> = [
  { match: /shell|bash|command/i, icon: Terminal },
  { match: /read|write|edit|patch|file/i, icon: FileCode2 },
  { match: /glob|grep|search|find|list/i, icon: Search },
  { match: /web|fetch|http/i, icon: Globe },
  { match: /task|todo|plan/i, icon: ListChecks },
];

function actionIcon(action: string) {
  return ACTION_ICONS.find((entry) => entry.match.test(action))?.icon ?? Wrench;
}

export interface PermissionReplyState {
  requestId: string;
  decision: PermissionDecision;
}

export interface PermissionsPanelProps {
  requests: PermissionRequest[];
  pending?: PermissionReplyState | null;
  error?: unknown;
  onReply: (request: PermissionRequest, decision: PermissionDecision, message?: string) => void;
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Panel de aprobación de herramientas. OpenCode deja la ejecución en suspenso
 * hasta que se responde la solicitud, así que debe quedar visible por encima
 * del transcript y nunca cerrarse solo.
 */
export function PermissionsPanel({ requests, pending, error, onReply }: PermissionsPanelProps) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  if (requests.length === 0) return null;

  const busy = Boolean(pending);
  const failure = errorText(error);

  return (
    <section
      aria-label="Permisos pendientes"
      className="border-b border-warning/30 bg-warning/[0.07] px-3 py-2.5 lg:px-4"
    >
      <div className="mx-auto w-full max-w-3xl">
        <header className="flex flex-wrap items-center gap-2 text-[11px]">
          <ShieldAlert size={14} className="shrink-0 text-warning" />
          <span className="font-medium text-warning">El agente necesita tu aprobación</span>
          <span className="text-faint">
            {requests.length} {requests.length === 1 ? "solicitud" : "solicitudes"} · la ejecución está en pausa
          </span>
        </header>

        <div className="mt-2 max-h-[38vh] space-y-2 overflow-y-auto pr-0.5">
          {requests.map((request) => {
            const Icon = actionIcon(request.action);
            const resources = permissionResources(request);
            const saveRules = permissionSaveRules(request);
            const isBusy = pending?.requestId === request.id;
            const decision = isBusy ? pending?.decision : undefined;

            return (
              <article
                key={request.id}
                className="rounded-lg border border-warning/25 bg-carbon-950/70 px-2.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <Icon size={12} className="shrink-0 text-warning" />
                  <span className="text-[11px] font-medium text-ink">
                    {permissionActionLabel(request.action)}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[9px] text-faint" title={request.id}>
                    {request.id.slice(0, 14)}…
                  </span>
                </div>

                {request.message ? (
                  <p className="mt-1 text-[11px] leading-4 text-muted">{request.message}</p>
                ) : null}

                {resources.length > 0 ? (
                  <ul className="mt-1.5 max-h-32 space-y-1 overflow-y-auto">
                    {resources.map((resource, index) => (
                      <li key={`${request.id}-${index}`}>
                        <code className="block whitespace-pre-wrap break-words rounded bg-carbon-900 px-2 py-1 font-mono text-[10px] leading-4 text-muted">
                          {resource}
                        </code>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="mt-2 flex flex-col gap-1.5 sm:flex-row sm:items-center">
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      variant="primary"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => onReply(request, "once")}
                      disabled={busy}
                    >
                      {decision === "once" ? <Loader2 size={12} className="animate-spin" /> : null}
                      Permitir una vez
                    </Button>
                    <Button
                      className="h-7 px-2 text-[11px]"
                      onClick={() => onReply(request, "always")}
                      disabled={busy}
                      title={
                        saveRules.length > 0
                          ? `Aprueba y guarda estas reglas: ${saveRules.join(", ")}`
                          : "Aprueba sin volver a preguntar por esta acción"
                      }
                    >
                      {decision === "always" ? <Loader2 size={12} className="animate-spin" /> : null}
                      Permitir siempre
                    </Button>
                  </div>
                  <div className="flex flex-1 gap-1.5 sm:justify-end">
                    <input
                      value={reasons[request.id] ?? ""}
                      onChange={(event) =>
                        setReasons((current) => ({ ...current, [request.id]: event.target.value }))
                      }
                      placeholder="Motivo si rechazas (opcional)"
                      aria-label="Motivo del rechazo"
                      className="h-7 min-w-0 flex-1 rounded-md border border-line bg-carbon-900 px-2 text-[10px] text-ink outline-none placeholder:text-faint focus:border-danger/60 sm:max-w-[190px]"
                      disabled={busy}
                    />
                    <Button
                      variant="danger"
                      className="h-7 shrink-0 px-2 text-[11px]"
                      onClick={() => onReply(request, "reject", reasons[request.id])}
                      disabled={busy}
                      title="Rechaza la acción y explica el motivo al agente"
                    >
                      {decision === "reject" ? <Loader2 size={12} className="animate-spin" /> : null}
                      Rechazar
                    </Button>
                  </div>
                </div>

                {saveRules.length > 0 ? (
                  <p className="mt-1.5 text-[9px] leading-4 text-faint">
                    «Permitir siempre» guarda:{" "}
                    <span className="font-mono text-muted">
                      {saveRules.slice(0, 4).join(" · ")}
                      {saveRules.length > 4 ? ` · +${saveRules.length - 4}` : ""}
                    </span>
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>

        {failure ? <p className="mt-2 text-[11px] text-danger">{failure}</p> : null}
      </div>
    </section>
  );
}

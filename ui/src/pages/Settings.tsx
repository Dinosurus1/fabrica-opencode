import { useQuery } from "@tanstack/react-query";
import { Brain, Cpu, Lock, Server, Settings2, ShieldCheck } from "lucide-react";
import { useProject } from "../components/ProjectContext";
import { Badge, EmptyState, ErrorState, PageHeader, Section, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { cn, formatDate } from "../lib/format";
import { useFactoryHealth } from "../lib/hooks";

export function SettingsPage() {
  const { project } = useProject();
  const directory = project?.canonical;
  const health = useFactoryHealth(directory);
  const providers = useQuery({
    queryKey: ["opencode", "providers", directory ?? "default"],
    queryFn: () => api.providers(directory),
  });
  const mcp = useQuery({
    queryKey: ["opencode", "mcp", directory ?? "default"],
    queryFn: () => api.mcp(directory),
  });
  const config = useQuery({
    queryKey: ["opencode", "config", directory ?? "default"],
    queryFn: () => api.config(directory),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        subtitle="Estado de la fábrica, proveedores, MCP y configuración. Esta primera versión es de solo lectura para configuración, permisos y proveedores."
        actions={<Badge tone="violet"><Lock size={12} /> solo lectura</Badge>}
      />

      {health.error || providers.error || mcp.error || config.error ? (
        <ErrorState error={health.error ?? providers.error ?? mcp.error ?? config.error} />
      ) : null}

      <div className="grid gap-5 xl:grid-cols-2">
        <Section title="Fábrica" description="Diagnóstico rápido del motor.">
          {health.isLoading ? (
            <div className="p-6">
              <Spinner />
            </div>
          ) : !health.data ? (
            <EmptyState title="Sin datos" description="No se pudo consultar el RPC de la fábrica." />
          ) : (
            <div className="space-y-2 p-4 text-sm">
              <SettingRow icon={<Cpu size={14} />} label="Modelos" value={String(health.data.models)} />
              <SettingRow icon={<Settings2 size={14} />} label="Agentes" value={String(health.data.agents)} />
              <SettingRow icon={<ShieldCheck size={14} />} label="Perfiles" value={String(health.data.profiles)} />
              <SettingRow
                icon={<Brain size={14} />}
                label="Memoria"
                value={health.data.memory_available ? "disponible" : "no disponible"}
              />
              <SettingRow
                icon={<Server size={14} />}
                label="Perfil por defecto"
                value={health.data.default_profile ?? "ninguno"}
              />
              <SettingRow
                icon={<ShieldCheck size={14} />}
                label="Perfil aplicado"
                value={health.data.applied_profile ?? "ninguno"}
              />
              <div className="pt-2 text-[11px] text-faint">Comprobado: {formatDate(health.data.checked_at)}</div>
            </div>
          )}
        </Section>

        <Section title="Proveedores" description="Conexiones de modelo configuradas en OpenCode.">
          {providers.isLoading ? (
            <div className="p-6">
              <Spinner />
            </div>
          ) : (
            <div className="divide-y divide-line-soft">
              {(providers.data ?? []).map((provider) => (
                <div key={provider.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-ink">{provider.name}</div>
                    <div className="font-mono text-[10px] text-faint">{provider.id}</div>
                  </div>
                  <Badge tone={provider.activation === "enabled" ? "success" : "warning"}>
                    {provider.activation ?? "—"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section title="MCP" description="Servidores conectados y su estado. No se modifican desde esta vista.">
        {mcp.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : (mcp.data?.length ?? 0) === 0 ? (
          <EmptyState title="Sin servidores MCP" description="Configura MCP en opencode.json." />
        ) : (
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {(mcp.data ?? []).map((server) => {
              const status = server.status?.status ?? "unknown";
              return (
                <div key={server.name} className="rounded-lg border border-line-soft bg-carbon-950/50 p-3">
                  <div className="flex items-center gap-2">
                    <span className={cn("size-1.5 rounded-full", status === "connected" ? "bg-success" : "bg-warning")} />
                    <span className="text-xs font-medium text-ink">{server.title ?? server.name}</span>
                    <Badge tone={status === "connected" ? "success" : "warning"} className="ml-auto">
                      {status}
                    </Badge>
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-faint">{server.name}</div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Configuración y permisos" description="La UI no edita configuración, permisos ni proveedores en esta etapa.">
        <div className="space-y-3 p-4 text-[11px] leading-5 text-muted">
          <p>
            La configuración de OpenCode vive en <code className="kbd">~/.config/opencode/opencode.json</code> y los
            permisos de cada agente en <code className="kbd">agents/*.md</code>. Cambiarlos aquí sin auditoría rompería
            la separación entre definición, modelo y permisos.
          </p>
          <p>
            Esta consola sí puede crear y aplicar perfiles de modelo, cambiar el agente o el modelo de una sesión y
            gestionar memoria. Los cambios de configuración se harán en una fase posterior con confirmación explícita.
          </p>
          {config.data ? (
            <details className="rounded-md border border-line-soft bg-carbon-950/50 px-3 py-2">
              <summary className="cursor-pointer text-[11px] font-medium text-ink">Ver configuración resuelta</summary>
              <pre className="mt-2 max-h-72 overflow-auto text-[10px] leading-5 text-muted">
                {JSON.stringify(config.data, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

function SettingRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-line-soft bg-carbon-950/40 px-3 py-2">
      <span className="text-faint">{icon}</span>
      <span className="text-muted">{label}</span>
      <span className="ml-auto font-medium text-ink">{value}</span>
    </div>
  );
}

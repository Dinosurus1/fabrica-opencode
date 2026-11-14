import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Bot,
  Brain,
  ChevronDown,
  Cpu,
  FolderGit2,
  LayoutDashboard,
  ListChecks,
  Menu,
  MessagesSquare,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api } from "../lib/api";
import { cn, shortPath } from "../lib/format";
import { useFactoryHealth } from "../lib/hooks";
import { useProject } from "./ProjectContext";

const navigation = [
  {
    label: "Operación",
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/sessions", label: "Sessions", icon: MessagesSquare },
      { to: "/work", label: "Work", icon: ListChecks },
    ],
  },
  {
    label: "Fábrica",
    items: [
      { to: "/agents", label: "Agents", icon: Bot },
      { to: "/models", label: "Models", icon: Cpu },
      { to: "/memory", label: "Memory", icon: Brain },
    ],
  },
  {
    label: "Sistema",
    items: [
      { to: "/projects", label: "Projects", icon: FolderGit2 },
      { to: "/skills", label: "Skills", icon: Sparkles },
      { to: "/analytics", label: "Analytics", icon: BarChart3 },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { projects, project, projectId, setProjectId } = useProject();
  const health = useFactoryHealth(project?.canonical);
  const info = useQuery({
    queryKey: ["opencode", "info"],
    queryFn: () =>
      fetch("/api/info", { headers: { "x-factory-ui": "1" } }).then(
        (response) => response.json() as Promise<{ version: string }>,
      ),
    staleTime: 5 * 60_000,
  });

  const healthy = health.data?.ok === true;

  return (
    <div className="flex min-h-full">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-line-soft bg-carbon-900/95 transition-transform lg:static lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center justify-between border-b border-line-soft px-4">
          <div className="flex items-center gap-2.5">
            <div className="grid size-7 place-items-center rounded-md border border-violet/40 bg-violet/15 text-[11px] font-bold text-violet-soft">
              F
            </div>
            <div className="leading-tight">
              <div className="text-[13px] font-semibold tracking-[0.02em] text-ink">Factory</div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-faint">Console</div>
            </div>
          </div>
          <button
            className="rounded-md p-1 text-faint hover:bg-carbon-800 hover:text-ink lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Cerrar menú"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
          <span className={cn("size-2 rounded-full", healthy ? "bg-success" : "bg-danger")} />
          <span className="text-xs font-medium text-ink">Modo fábrica</span>
          <span className="ml-auto text-[10px] text-faint">
            {healthy ? "operativa" : health.isError ? "sin conexión" : "comprobando"}
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3">
          {navigation.map((section) => (
            <div key={section.label} className="mb-4">
              <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
                {section.label}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      onClick={() => setMobileOpen(false)}
                      className={({ isActive }) =>
                        cn(
                          "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                          isActive
                            ? "bg-violet/15 text-violet-soft"
                            : "text-muted hover:bg-carbon-800 hover:text-ink",
                        )
                      }
                    >
                      <Icon size={15} strokeWidth={1.8} />
                      {item.label}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-line-soft px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Activity size={14} className="text-faint" />
            <span>OpenCode</span>
            <span className="ml-auto font-mono text-[10px] text-faint">
              {info.data?.version ? `v${info.data.version}` : "—"}
            </span>
          </div>
          <div className="mt-1.5 text-[10px] text-faint">
            {health.data
              ? `${health.data.models} modelos · ${health.data.agents} agentes · ${health.data.profiles} perfiles`
              : "Sin datos de salud"}
          </div>
        </div>
      </aside>

      {mobileOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line-soft bg-carbon-950/85 px-4 backdrop-blur-md lg:px-6">
          <button
            className="rounded-md p-1.5 text-muted hover:bg-carbon-800 hover:text-ink lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menú"
          >
            <Menu size={18} />
          </button>

          <div className="relative min-w-0">
            <select
              className="h-8 max-w-[340px] appearance-none rounded-lg border border-line bg-carbon-900 pl-3 pr-8 text-xs font-medium text-ink outline-none focus:border-violet"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              aria-label="Proyecto activo"
            >
              {projects.length === 0 ? <option value="">Sin proyectos</option> : null}
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {shortPath(item.canonical)}
                </option>
              ))}
            </select>
            <ChevronDown
              size={14}
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint"
            />
          </div>

          <div className="hidden min-w-0 items-center gap-2 text-xs text-faint md:flex">
            <span className="truncate">{project ? shortPath(project.canonical) : "—"}</span>
            {project?.vcs ? (
              <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted">
                {project.vcs}
              </span>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div
              className="hidden items-center gap-2 rounded-full border border-line bg-carbon-900 px-3 py-1.5 text-[11px] text-muted sm:flex"
              title={health.data ? `Comprobado: ${health.data.checked_at}` : undefined}
            >
              <span className={cn("size-1.5 rounded-full", healthy ? "bg-success" : "bg-danger")} />
              {healthy ? "Fábrica operativa" : health.isError ? "Fábrica sin conexión" : "Comprobando"}
            </div>
            <NavLink
              to="/settings"
              className="grid size-8 place-items-center rounded-lg border border-line bg-carbon-900 text-muted transition-colors hover:text-ink"
              aria-label="Ajustes"
            >
              <Settings size={15} />
            </NavLink>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 lg:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

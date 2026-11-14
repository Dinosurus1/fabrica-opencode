import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Pencil, Pin, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useProject } from "../components/ProjectContext";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  Section,
  Spinner,
  StatCard,
} from "../components/ui";
import { formatDate, formatNumber, relativeTime } from "../lib/format";
import { rpc } from "../lib/rpc";
import type { MemoryItem, MemoryStats } from "../lib/types";

interface MemoryUpdate {
  title: string;
  tags: string;
  importance: number;
  pinned: boolean;
}

export function MemoryPage() {
  const { project } = useProject();
  const directory = project?.canonical;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState("");
  const [kind, setKind] = useState("");
  const [pinned, setPinned] = useState(false);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [form, setForm] = useState<MemoryUpdate>({ title: "", tags: "", importance: 3, pinned: false });
  const [deleting, setDeleting] = useState<MemoryItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const stats = useQuery({
    queryKey: ["factory", "memory-stats", directory ?? "default"],
    queryFn: () => rpc<MemoryStats>("memory.stats", {}, directory),
  });
  const memories = useQuery({
    queryKey: ["factory", "memories", search, scope, kind, pinned, directory ?? "default"],
    queryFn: () =>
      rpc<{ count: number; memories: MemoryItem[] }>("memory.list", {
        search: search || undefined,
        scope: scope || undefined,
        kind: kind || undefined,
        pinned: pinned || undefined,
        limit: 200,
      }, directory),
  });

  const update = useMutation({
    mutationFn: () =>
      rpc("memory.update", {
        id: editing!.id,
        title: form.title.trim() || null,
        tags: form.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        importance: form.importance,
        pinned: form.pinned,
      }, directory),
    onSuccess: async () => {
      setEditing(null);
      setNotice("Memoria actualizada.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["factory", "memories"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "memory-stats"] }),
      ]);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : String(error)),
  });

  const remove = useMutation({
    mutationFn: () => rpc<{ deleted: number }>("memory.delete", { ids: [deleting!.id], confirmed: true }, directory),
    onSuccess: async (result) => {
      setDeleting(null);
      setNotice(`Memoria eliminada (${result.deleted}).`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["factory", "memories"] }),
        queryClient.invalidateQueries({ queryKey: ["factory", "memory-stats"] }),
      ]);
    },
    onError: (error) => {
      setDeleting(null);
      setNotice(error instanceof Error ? error.message : String(error));
    },
  });

  const items = memories.data?.memories ?? [];
  const byScope = stats.data?.byScope ?? {};
  const byKind = stats.data?.byKind ?? {};

  return (
    <div className="space-y-5">
      <PageHeader
        title="Memory"
        subtitle="Memoria vectorial compartida. Aquí puedes auditar, buscar textualmente, editar metadatos y borrar. La búsqueda semántica sigue en el chat con memory_search."
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                className="field h-8 w-64 pl-8 text-xs"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar en contenido y título..."
              />
            </div>
            <select className="field h-8 w-28 text-xs" value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="">Todo scope</option>
              <option value="global">Global</option>
              <option value="project">Proyecto</option>
            </select>
            <select className="field h-8 w-32 text-xs" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">Todo tipo</option>
              {["preference", "fact", "decision", "convention", "snippet"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                className="size-3.5 accent-[#7c5cff]"
                checked={pinned}
                onChange={(event) => setPinned(event.target.checked)}
              />
              Fijadas
            </label>
          </div>
        }
      />

      {notice ? (
        <div className="rounded-lg border border-violet/30 bg-violet/10 px-3 py-2 text-xs text-violet-soft">{notice}</div>
      ) : null}

      {stats.error ? <ErrorState error={stats.error} onRetry={() => void stats.refetch()} /> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Memorias" value={formatNumber(stats.data?.total ?? 0)} hint="global + proyecto" icon={<Brain size={15} />} />
        <StatCard label="Globales" value={formatNumber(byScope.global ?? 0)} hint="preferencias y entorno" tone="violet" />
        <StatCard label="De proyecto" value={formatNumber(byScope.project ?? 0)} hint="decisiones y convenciones" tone="success" />
        <StatCard label="Tamaño" value={stats.data?.size ?? "—"} hint={`${Object.keys(byKind).length} tipos`} />
      </div>

      <Section
        title="Memorias"
        description={`${items.length} resultados${memories.isFetching ? " · actualizando" : ""}`}
      >
        {memories.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : memories.isError ? (
          <ErrorState error={memories.error} onRetry={() => void memories.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Brain size={26} />}
            title="Sin memorias"
            description="La memoria se llena con memory_save o con la captura automática de sesiones."
          />
        ) : (
          <div className="max-h-[70vh] divide-y divide-line-soft overflow-y-auto">
            {items.map((memory) => (
              <article key={memory.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={memory.scope === "global" ? "violet" : "default"}>{memory.scope}</Badge>
                  <Badge>{memory.kind}</Badge>
                  {memory.pinned ? (
                    <Badge tone="warning">
                      <Pin size={11} /> fijada
                    </Badge>
                  ) : null}
                  <span className="text-[10px] text-faint">importancia {memory.importance}/5</span>
                  <span className="ml-auto text-[10px] text-faint">{relativeTime(memory.updatedAt)}</span>
                </div>
                {memory.title ? <h3 className="mt-2 text-xs font-semibold text-ink">{memory.title}</h3> : null}
                <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted">{memory.content}</p>
                {memory.tags.length ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {memory.tags.map((tag) => (
                      <span key={tag} className="rounded border border-line bg-carbon-800 px-1.5 py-0.5 text-[10px] text-faint">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-mono text-[10px] text-faint">{memory.id.slice(0, 12)}…</span>
                  <span className="text-[10px] text-faint">{formatDate(memory.createdAt)}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => {
                        setEditing(memory);
                        setForm({
                          title: memory.title ?? "",
                          tags: memory.tags.join(", "),
                          importance: memory.importance,
                          pinned: memory.pinned,
                        });
                      }}
                    >
                      <Pencil size={12} /> Editar
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-7 px-2 text-[11px] text-danger hover:text-danger"
                      onClick={() => setDeleting(memory)}
                    >
                      <Trash2 size={12} /> Borrar
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </Section>

      <Modal
        open={Boolean(editing)}
        title="Editar memoria"
        description="Cambiar metadatos no regenera el embedding; el contenido se mantiene."
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={() => update.mutate()} disabled={update.isPending}>
              Guardar
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Título">
            <input className="field" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </Field>
          <Field label="Tags" hint="Separadas por comas.">
            <input className="field" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Importancia">
              <select
                className="field"
                value={form.importance}
                onChange={(event) => setForm({ ...form, importance: Number(event.target.value) })}
              >
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    {value} / 5
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex items-end gap-2 pb-2 text-xs text-muted">
              <input
                type="checkbox"
                className="size-3.5 accent-[#7c5cff]"
                checked={form.pinned}
                onChange={(event) => setForm({ ...form, pinned: event.target.checked })}
              />
              Fijar en el contexto
            </label>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Borrar memoria"
        message={
          <>
            Se eliminará la memoria <strong className="text-ink">{deleting?.title ?? deleting?.id}</strong> de forma
            permanente. ¿Continuar?
          </>
        }
        confirmLabel="Borrar"
        danger
        onConfirm={() => remove.mutate()}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

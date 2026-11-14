export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("es-ES", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatUsd(value: number | string | null | undefined): string {
  const number = typeof value === "string" ? Number(value) : value;
  if (number === null || number === undefined || Number.isNaN(number)) return "—";
  if (number === 0) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: number < 1 ? 4 : 2,
  }).format(number);
}

export function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function relativeTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `hace ${days} d`;
  return formatDate(value);
}

export function shortPath(path: string | null | undefined): string {
  if (!path) return "—";
  return path.replace(/^\/home\/[^/]+/, "~");
}

export function modelLabel(providerId: string | null | undefined, modelId: string | null | undefined): string {
  if (!providerId && !modelId) return "—";
  return `${providerId ?? "?"}/${modelId ?? "?"}`;
}

export function statusClass(status: string | null | undefined): string {
  switch (status) {
    case "pass":
    case "approved":
    case "done":
    case "merged":
    case "succeeded":
    case "connected":
    case "active":
      return "badge-success";
    case "fail":
    case "error":
    case "changes_required":
    case "failed":
    case "blocked":
    case "cancelled":
      return "badge-danger";
    case "incomplete":
    case "running":
    case "in_progress":
    case "busy":
      return "badge-warning";
    case "pending":
    case "skipped":
      return "badge";
    default:
      return "badge";
  }
}

export function percent(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value / total) * 100);
}

/**
 * Severidad y métricas de hallazgos del plan-reviewer.
 *
 * CRÍTICO y ALTO bloquean la aprobación. MEDIO y BAJO son deuda residual que
 * se puede aceptar con confirmación explícita.
 */

export type ReviewSeverity = "CRITICO" | "ALTO" | "MEDIO" | "BAJO";

export function normalizeSeverity(value: unknown): ReviewSeverity {
  const text = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  if (text.includes("CRIT")) return "CRITICO";
  if (text.includes("ALT") || text.includes("HIGH")) return "ALTO";
  if (text.includes("MED")) return "MEDIO";
  return "BAJO";
}

export function findingText(finding: unknown): string {
  if (!finding || typeof finding !== "object") return "";
  const item = finding as Record<string, unknown>;
  return String(item.text ?? item.problem ?? item.finding ?? "").trim();
}

export function findingFingerprint(finding: unknown): string {
  const item = finding && typeof finding === "object" ? (finding as Record<string, unknown>) : {};
  return `${normalizeSeverity(item.severity)}|${findingText(finding).toLowerCase().replace(/\s+/g, " ").slice(0, 180)}`;
}

export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return severity === "CRITICO" || severity === "ALTO";
}

export interface SummaryFinding {
  severity: ReviewSeverity;
  text: string;
}

export function summarizeFindings(findings: unknown[]): {
  list: SummaryFinding[];
  blocking: SummaryFinding[];
  advisory: SummaryFinding[];
  blockingCount: number;
  advisoryCount: number;
} {
  const list = findings
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      severity: normalizeSeverity((item as Record<string, unknown>).severity),
      text: findingText(item).slice(0, 2_000),
    }))
    .filter((item) => item.text);
  const blocking = list.filter((item) => isBlockingSeverity(item.severity));
  const advisory = list.filter((item) => !isBlockingSeverity(item.severity));
  return { list, blocking, advisory, blockingCount: blocking.length, advisoryCount: advisory.length };
}

/**
 * Utilidades de cobertura para run_gates.
 *
 * Qué hace: normaliza la configuración de cobertura del perfil, parsea salidas
 * y reportes comunes (lcov, Cobertura, Istanbul/JSON) y decide si hay regresión
 * o incumplimiento de umbral.
 *
 * Qué accede: no accede a nada por sí mismo; recibe texto/rutas y devuelve datos.
 */

import type { FactoryProfile } from "./db.js";

export interface CoverageConfig {
  command: string;
  changedCommand?: string;
  reportPath?: string;
  threshold: number;
  changedThreshold: number;
  tolerance: number;
}

export interface CoverageFinding {
  file: string;
  line: number | null;
  severity: "medium";
  rule: string;
  message: string;
}

export interface CoverageEvaluation {
  status: "pass" | "fail";
  findings: CoverageFinding[];
  evidence: string;
  total: number | null;
  changed: number | null;
  baseline: number | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getCoverageConfig(profile: FactoryProfile | null): CoverageConfig | null {
  const coverage = isPlainObject(profile?.quality?.coverage) ? profile.quality.coverage : {};
  const command = typeof coverage.command === "string" && coverage.command.trim()
    ? coverage.command.trim()
    : typeof profile?.commands?.coverage === "string" && profile.commands.coverage.trim()
      ? profile.commands.coverage.trim()
      : "";
  if (!command) return null;
  return {
    command,
    changedCommand: typeof coverage.changedCommand === "string" && coverage.changedCommand.trim()
      ? coverage.changedCommand.trim()
      : undefined,
    reportPath: typeof coverage.reportPath === "string" && coverage.reportPath.trim()
      ? coverage.reportPath.trim()
      : undefined,
    threshold: numberOr(coverage.threshold ?? coverage.totalThreshold, 80),
    changedThreshold: numberOr(coverage.changedThreshold, 80),
    tolerance: numberOr(coverage.tolerance, 0.5),
  };
}

export function parseCoverageOutput(text: string): number | null {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
  const patterns = [
    /All files[^\n]*?\|\s*([\d.]+)\s*\|/i,
    /Lines\s*:\s*([\d.]+)%/i,
    /coverage:\s*([\d.]+)%/i,
    /TOTAL\s+[^\n]*?([\d.]+)%/i,
    /total[^\n]*?([\d.]+)%/i,
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match) {
      const value = Number.parseFloat(match[1]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

export function parseCoverageReport(content: string, filename: string): number | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".lcov") || lower.endsWith("lcov.info")) {
    let found = 0;
    let hit = 0;
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith("LF:")) found += Number(line.slice(3)) || 0;
      if (line.startsWith("LH:")) hit += Number(line.slice(3)) || 0;
    }
    return found > 0 ? (hit / found) * 100 : null;
  }
  if (lower.endsWith(".xml")) {
    let found = 0;
    let hit = 0;
    for (const match of content.matchAll(/<line\b[^>]*\bnumber="\d+"[^>]*\bhits="(\d+)"/g)) {
      const hits = Number(match[1]);
      if (Number.isFinite(hits)) {
        found += 1;
        if (hits > 0) hit += 1;
      }
    }
    return found > 0 ? (hit / found) * 100 : null;
  }
  try {
    const data = JSON.parse(content) as unknown;
    if (isPlainObject(data)) {
      const total = isPlainObject(data.total) ? data.total : {};
      const lines = isPlainObject(total.lines) ? total.lines : {};
      const pct = Number(lines.pct ?? total.percent ?? data.percent ?? NaN);
      if (Number.isFinite(pct)) return pct;
    }
  } catch {
    return null;
  }
  return null;
}

export function evaluateCoverage(
  config: CoverageConfig,
  total: number | null,
  changed: number | null,
  baseline: number | null,
): CoverageEvaluation {
  const findings: CoverageFinding[] = [];
  if (total === null) {
    return {
      status: "fail",
      findings: [{
        file: "coverage",
        line: null,
        severity: "medium",
        rule: "coverage.unparsable",
        message: "No se pudo extraer la cobertura total de la salida o del reporte.",
      }],
      evidence: "sin cobertura parseable",
      total,
      changed,
      baseline,
    };
  }

  if (baseline !== null) {
    if (total < baseline - config.tolerance) {
      findings.push({
        file: "coverage",
        line: null,
        severity: "medium",
        rule: "coverage.regression",
        message: `La cobertura total bajó de ${baseline.toFixed(2)}% a ${total.toFixed(2)}% (tolerancia ${config.tolerance}%).`,
      });
    }
  } else if (total < config.threshold) {
    findings.push({
      file: "coverage",
      line: null,
      severity: "medium",
      rule: "coverage.total",
      message: `Cobertura total ${total.toFixed(2)}% por debajo del umbral ${config.threshold}%.`,
    });
  }

  if (changed !== null && changed < config.changedThreshold) {
    findings.push({
      file: "coverage",
      line: null,
      severity: "medium",
      rule: "coverage.changed",
      message: `Cobertura del código cambiado ${changed.toFixed(2)}% por debajo del umbral ${config.changedThreshold}%.`,
    });
  }

  return {
    status: findings.length > 0 ? "fail" : "pass",
    findings,
    evidence:
      `total=${total.toFixed(2)}%` +
      `${changed !== null ? `; cambiado=${changed.toFixed(2)}%` : ""}` +
      `${baseline !== null ? `; baseline=${baseline.toFixed(2)}%` : ""}`,
    total,
    changed,
    baseline,
  };
}

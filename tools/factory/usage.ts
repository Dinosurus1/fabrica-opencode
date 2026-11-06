/**
 * Cálculo de uso de tokens y costo estimado.
 *
 * Fuente de verdad del uso: la sesión de OpenCode (`cost` y `tokens`). Si el
 * proveedor no reporta costo (> 0), se estima con el precio por millón de
 * tokens del catálogo de modelos visible en OpenCode.
 *
 * Límites conocidos (se reflejan en `cost_basis`):
 *  - Se usa el precio base o el tramo de contexto que corresponde al tamaño
 *    observado de la sesión; no se modelan descuentos por hora ni promociones.
 *  - Los tokens de razonamiento se facturan al precio de salida.
 *  - El costo es una estimación, no una factura.
 */

import type { ReviewUsage, TokenUsage } from "./db.js";

export interface SessionUsageSnapshot {
  sessionId: string;
  model: string;
  tokens: TokenUsage;
  costUsd: number;
}

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  basis: string;
}

export interface UsageDeps {
  getSessionUsage: (sessionID: string) => Promise<SessionUsageSnapshot | null>;
  getModelPrice: (model: string, contextTokens: number) => Promise<ModelPrice | null>;
}

export function zeroTokens(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function emptyUsage(sessionId: string | null): ReviewUsage {
  return {
    sessionId,
    tokens: zeroTokens(),
    costUsd: 0,
    costSource: "unknown",
    costBasis: null,
  };
}

/** Precio del catálogo, en USD por millón de tokens. */
export function catalogCostUsd(tokens: TokenUsage, price: ModelPrice): number {
  const micros =
    tokens.input * price.input +
    (tokens.output + tokens.reasoning) * price.output +
    tokens.cacheRead * price.cacheRead +
    tokens.cacheWrite * price.cacheWrite;
  return Math.round((micros / 1_000_000) * 1_000_000) / 1_000_000;
}

/**
 * Convierte una instantánea de sesión en la fila que guarda `review_submit`.
 * Si el proveedor reporta costo, se usa tal cual; si no, se estima.
 */
export function captureUsage(
  snapshot: SessionUsageSnapshot | null,
  price: ModelPrice | null,
  sessionId: string | null,
): ReviewUsage {
  if (!snapshot) return emptyUsage(sessionId);
  if (snapshot.costUsd > 0) {
    return {
      sessionId: snapshot.sessionId,
      tokens: snapshot.tokens,
      costUsd: snapshot.costUsd,
      costSource: "provider",
      costBasis: "cost reportado por el proveedor",
    };
  }
  if (price) {
    return {
      sessionId: snapshot.sessionId,
      tokens: snapshot.tokens,
      costUsd: catalogCostUsd(snapshot.tokens, price),
      costSource: "catalog",
      costBasis: price.basis,
    };
  }
  return {
    sessionId: snapshot.sessionId,
    tokens: snapshot.tokens,
    costUsd: 0,
    costSource: "unknown",
    costBasis: "sin precio en el catálogo y proveedor sin costo reportado",
  };
}

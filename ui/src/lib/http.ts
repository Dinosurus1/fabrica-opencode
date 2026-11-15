/**
 * Cliente HTTP tipado de la consola.
 *
 * - Errores con estado y cuerpo para que la UI pueda distinguir 401/403/429/5xx.
 * - Reintentos solo en lecturas idempotentes; nunca repite un POST.
 * - Timeout por petición y validación opcional del contrato con un schema.
 */

export interface Parser<T> {
  parse(value: unknown): T;
}

export class HttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly url: string;
  readonly retryable: boolean;

  constructor(input: {
    status: number;
    statusText: string;
    body: string;
    url: string;
    retryable?: boolean;
  }) {
    super(
      `${input.status} ${input.statusText}${input.body ? `: ${input.body.slice(0, 240)}` : ""}`,
    );
    this.name = "HttpError";
    this.status = input.status;
    this.statusText = input.statusText;
    this.body = input.body;
    this.url = input.url;
    this.retryable = input.retryable ?? input.status >= 500;
  }
}

export class ContractError extends Error {
  readonly url: string;
  readonly issues: unknown;

  constructor(url: string, issues: unknown) {
    super(`Respuesta inesperada de ${url}`);
    this.name = "ContractError";
    this.url = url;
    this.issues = issues;
  }
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbort(error: unknown) {
  return (
    (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

export interface JsonRequestInit extends RequestInit {
  timeoutMs?: number;
  schema?: Parser<unknown>;
}

export async function jsonRequest<T>(
  url: string,
  init: JsonRequestInit = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, schema, ...requestInit } = init;
  const method = (requestInit.method ?? "GET").toUpperCase();
  const canRetry = method === "GET" || method === "HEAD";

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...requestInit,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(requestInit.headers ?? {}),
        },
        signal: requestInit.signal ?? AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new HttpError({
          status: response.status,
          statusText: response.statusText,
          body,
          url,
          retryable: canRetry && RETRYABLE_STATUS.has(response.status),
        });
        if (error.retryable && attempt < MAX_ATTEMPTS - 1) {
          lastError = error;
          await sleep(250 * 2 ** attempt);
          continue;
        }
        if (response.status === 401 && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("factory:unauthorized"));
        }
        throw error;
      }

      if (response.status === 204) return undefined as T;
      let value: unknown;
      try {
        value = (await response.json()) as unknown;
      } catch (issues) {
        throw new ContractError(url, issues);
      }
      if (schema) {
        try {
          return schema.parse(value) as T;
        } catch (issues) {
          throw new ContractError(url, issues);
        }
      }
      return value as T;
    } catch (error) {
      if (error instanceof HttpError || error instanceof ContractError) throw error;
      lastError = error;
      if (!canRetry || isAbort(error) || attempt >= MAX_ATTEMPTS - 1) throw error;
      await sleep(250 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof HttpError && error.status === 401;
}

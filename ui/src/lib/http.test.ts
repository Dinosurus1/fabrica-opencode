import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractError, HttpError, jsonRequest } from "./http";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jsonRequest", () => {
  it("devuelve JSON y añade cabeceras", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const value = await jsonRequest<{ ok: boolean }>("/x", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    expect(value).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(init.credentials).toBe("same-origin");
  });

  it("devuelve undefined en 204", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(jsonRequest("/x")).resolves.toBeUndefined();
  });

  it("lanza HttpError con estado y cuerpo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no autorizado", { status: 401, statusText: "Unauthorized" })),
    );
    await expect(jsonRequest("/x")).rejects.toMatchObject({
      name: "HttpError",
      status: 401,
      body: "no autorizado",
    });
  });

  it("no reintenta un POST fallido", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 502, statusText: "Bad Gateway" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(jsonRequest("/x", { method: "POST" })).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reintenta un GET 502 y termina bien", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls < 3
        ? new Response("temporal", { status: 503, statusText: "Service Unavailable" })
        : jsonResponse({ ok: "final" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(jsonRequest("/x")).resolves.toEqual({ ok: "final" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("valida el contrato y lanza ContractError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: 123 })));
    await expect(
      jsonRequest("/x", { schema: { parse: () => { throw new Error("forma inválida"); } } }),
    ).rejects.toBeInstanceOf(ContractError);
  });

  it("no reintenta un timeout", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("timeout", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(jsonRequest("/x")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no reintenta un 200 que no es JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("texto plano", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(jsonRequest("/x")).rejects.toBeInstanceOf(ContractError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

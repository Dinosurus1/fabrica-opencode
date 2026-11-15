import { jsonRequest } from "./http";

export async function rpc<T>(
  method: string,
  input: Record<string, unknown> = {},
  directory?: string,
): Promise<T> {
  const query = directory
    ? `?location[directory]=${encodeURIComponent(directory)}`
    : "";
  const body = await jsonRequest<{ output?: unknown; message?: string; type?: string }>(
    `/api/rpc/opencode.factory/${method}${query}`,
    {
      method: "POST",
      headers: { "x-factory-ui": "1" },
      body: JSON.stringify({ input }),
      timeoutMs: 60_000,
    },
  );
  if (body?.type === "error" && body.message) throw new Error(body.message);
  return body?.output as T;
}

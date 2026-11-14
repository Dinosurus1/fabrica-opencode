export async function rpc<T>(
  method: string,
  input: Record<string, unknown> = {},
  directory?: string,
): Promise<T> {
  const query = directory
    ? `?location[directory]=${encodeURIComponent(directory)}`
    : "";
  const response = await fetch(`/api/rpc/opencode.factory/${method}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-factory-ui": "1" },
    body: JSON.stringify({ input }),
  });
  const body = (await response.json().catch(() => null)) as
    | { output?: unknown; message?: string; type?: string }
    | null;
  if (!response.ok) {
    throw new Error(body?.message ?? `${response.status} ${response.statusText}`);
  }
  return body?.output as T;
}

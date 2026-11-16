import { expect, request, test } from "@playwright/test";

/**
 * Medición de tráfico del contexto por turno.
 *
 * Escenario: sesión de 200 mensajes (≈250 KB de JSON) en la que el agente está
 * ocupado 10 s y después queda inactivo. Cuenta cuántas veces se pide
 * `/api/session/<id>/context` y cuántos bytes se descargan en ese turno.
 *
 * Sirve de presupuesto: el sondeo de respaldo no debe convertir la
 * transcripción en una descarga periódica.
 */

const PASSWORD = "e2e-password";
const BASE = "http://127.0.0.1:4174";
const SESSION_TITLE = "E2E Context Traffic";
const MESSAGE_COUNT = 200;
const BUSY_MS = 10_000;
const SETTLE_MS = 3_000;

function messages() {
  const now = Date.now();
  return Array.from({ length: MESSAGE_COUNT }, (_, index) => {
    const isUser = index % 2 === 0;
    const text = `mensaje ${index + 1} · ${"relleno de transcripción ".repeat(50)}`;
    return {
      id: `msg_traffic_${index + 1}`,
      type: isUser ? "user" : "assistant",
      text,
      content: [{ type: "text", text }],
      time: { created: now + index },
    };
  });
}

test.afterAll(async () => {
  const context = await request.newContext({ baseURL: BASE });
  try {
    await context.post("/auth/login", {
      headers: { "x-factory-ui": "1" },
      data: { password: PASSWORD },
    });
    const response = await context.get("/api/session?limit=100");
    if (!response.ok()) return;
    const body = (await response.json()) as { data?: Array<{ id: string; title?: string }> };
    for (const session of body.data ?? []) {
      if (session.title !== SESSION_TITLE) continue;
      await context.delete(`/api/session/${encodeURIComponent(session.id)}`, {
        headers: { "x-factory-ui": "1" },
      });
    }
  } finally {
    await context.dispose();
  }
});

test("el contexto no se descarga en bucle durante un turno", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/");
  await page.getByLabel("Contraseña de la consola").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("link", { name: "Sessions" })).toBeVisible();

  const created = await page.request.post("/api/session", {
    headers: { "x-factory-ui": "1" },
    data: { title: SESSION_TITLE, agent: "factory" },
  });
  expect(created.ok()).toBeTruthy();
  const createdBody = (await created.json()) as { data?: { id?: string } };
  const sessionId = createdBody.data?.id;
  expect(sessionId).toBeTruthy();

  const payload = JSON.stringify({ data: messages() });
  const payloadBytes = Buffer.byteLength(payload);

  const contextRequests: number[] = [];
  let contextBytes = 0;

  await page.route(`**/api/session/${sessionId}/context`, async (route) => {
    contextRequests.push(Date.now());
    contextBytes += payloadBytes;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-encoding": "identity" },
      body: payload,
    });
  });
  await page.route(`**/api/session/${sessionId}/permission`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) }),
  );
  await page.route(`**/api/session/${sessionId}/form`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) }),
  );
  await page.route("**/api/permission/request*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) }),
  );
  await page.route("**/api/form*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) }),
  );

  // El turno dura BUSY_MS: la sesión se reporta como `running` y luego idle.
  const startedAt = Date.now();
  await page.route("**/api/session/active", async (route) => {
    const busy = Date.now() - startedAt < BUSY_MS;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(busy ? { data: { [sessionId!]: { type: "running" } } } : { data: {} }),
    });
  });

  // SSE sin eventos: lo que se mide es el sondeo, no el streaming.
  await page.route("**/api/event*", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: "retry: 60000\n\n",
    }),
  );

  await page.goto(`/sessions?session=${encodeURIComponent(sessionId!)}`);
  // La transcripción está virtualizada y abierta por el final: el último turno
  // es lo que se ve sin desplazarse.
  await expect(page.getByText(/mensaje 200 ·/).first()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => (Date.now() - startedAt < BUSY_MS ? "running" : "idle"), { timeout: BUSY_MS + 15_000 })
    .toBe("idle");
  await page.waitForTimeout(SETTLE_MS);

  const busyRequests = contextRequests.filter((at) => at - startedAt <= BUSY_MS).length;
  const total = contextRequests.length;

  console.log(
    `[context-traffic] payload=${(payloadBytes / 1024).toFixed(0)} KB ` +
      `peticiones=${total} (durante el turno=${busyRequests}) ` +
      `bytes=${(contextBytes / 1024).toFixed(0)} KB`,
  );

  // Presupuesto: carga inicial + evento terminal + red de seguridad como mucho.
  expect(total).toBeLessThanOrEqual(4);
  expect(contextBytes).toBeLessThanOrEqual(payloadBytes * 4);
});

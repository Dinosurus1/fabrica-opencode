import path from "node:path";
import { expect, request, test } from "@playwright/test";

const PASSWORD = "e2e-password";
const BASE = "http://127.0.0.1:4174";
const SESSION_TITLE = "E2E Network";
const ASSISTANT_ID = "msg_e2e_network";

function sse(events: Array<Record<string, unknown>>, retry = 5_000): string {
  return `retry: ${retry}\n\n${events
    .map((event) => `data: ${JSON.stringify(event)}`)
    .join("\n\n")}\n\n`;
}

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Contraseña de la consola").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("link", { name: "Sessions" })).toBeVisible();
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
      if (session.title === SESSION_TITLE) {
        await context.delete(`/api/session/${encodeURIComponent(session.id)}`, {
          headers: { "x-factory-ui": "1" },
        });
      }
    }
  } finally {
    await context.dispose();
  }
});

test("red: cortar 10 s y recuperar sin duplicar ni perder mensajes", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  const created = await page.request.post("/api/session", {
    headers: { "x-factory-ui": "1" },
    data: {
      title: SESSION_TITLE,
      agent: "factory",
      location: { directory: path.resolve(process.cwd(), "..") },
    },
  });
  expect(created.ok()).toBeTruthy();
  const createdBody = (await created.json()) as { data?: { id?: string } };
  const sessionId = createdBody.data?.id;
  expect(sessionId).toBeTruthy();

  const now = Date.now();
  const userMessage = {
    id: "msg_e2e_user",
    type: "user",
    text: "hola",
    content: [{ type: "text", text: "hola" }],
    time: { created: now },
  };
  const assistantMessage = {
    id: ASSISTANT_ID,
    type: "assistant",
    text: "hola mundo",
    content: [{ type: "text", text: "hola mundo" }],
    time: { created: now + 1 },
  };

  let offline = false;
  let full = false;
  let connections = 0;

  await page.route(`**/api/session/${sessionId}/context`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: full ? [userMessage, assistantMessage] : [userMessage] }),
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
  await page.route("**/api/session/active", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) }),
  );

  await page.route("**/api/event*", async (route) => {
    if (offline) {
      await route.abort("internetdisconnected");
      return;
    }
    connections += 1;
    if (connections === 1) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: sse([
          {
            type: "session.text.started",
            created: now,
            data: { sessionID: sessionId, assistantMessageID: ASSISTANT_ID, ordinal: 0 },
          },
          {
            type: "session.text.delta",
            created: now,
            data: { sessionID: sessionId, assistantMessageID: ASSISTANT_ID, ordinal: 0, delta: "hola" },
          },
        ]),
      });
      return;
    }
    if (connections === 2) {
      full = true;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: sse([
          {
            type: "session.text.delta",
            created: now + 2,
            data: { sessionID: sessionId, assistantMessageID: ASSISTANT_ID, ordinal: 0, delta: " mundo" },
          },
          { type: "session.idle", created: now + 3, data: { sessionID: sessionId } },
        ]),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: "retry: 60000\n\n",
    });
  });

  await page.goto(`/sessions?session=${encodeURIComponent(sessionId!)}`);
  const userBubble = page
    .locator("div.items-end")
    .filter({ has: page.getByText("Tú", { exact: true }) })
    .getByText("hola", { exact: true });
  await expect(userBubble.first()).toBeVisible({ timeout: 15_000 });

  // Corte de red de 10 s: la SSE y el polling deben fallar y recuperarse.
  offline = true;
  await page.context().setOffline(true);
  await expect(page.getByText(/Sin conexión|Reconectando/).first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(10_000);
  offline = false;
  await page.context().setOffline(false);

  await expect(page.getByText("hola mundo")).toHaveCount(1, { timeout: 25_000 });
  await expect(page.getByText(/^Sin conexión\./)).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(2_000);
  await expect(page.getByText("hola mundo")).toHaveCount(1);
  await expect(userBubble).toHaveCount(1);
});

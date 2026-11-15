import { expect, test, request } from "@playwright/test";

const PASSWORD = "e2e-password";
const BASE = "http://127.0.0.1:4174";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Contraseña de la consola").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("link", { name: "Sessions" })).toBeVisible();
}

async function createChat(page: import("@playwright/test").Page, title: string) {
  await page.getByRole("button", { name: "Nuevo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Crear chat" })).toBeEnabled();
  await page.getByLabel("Título").fill(title);
  await page.getByRole("button", { name: "Crear chat" }).click();
  await expect(page.getByText(title).first()).toBeVisible();
}

test.afterAll(async () => {
  const context = await request.newContext({ baseURL: BASE });
  try {
    await context.post("/auth/login", {
      headers: { "x-factory-ui": "1" },
      data: { password: PASSWORD },
    });
    const response = await context.get("/api/session?limit=100");
    if (response.ok()) {
      const body = (await response.json()) as { data?: Array<{ id: string; title?: string }> };
      for (const session of body.data ?? []) {
        if (session.title?.startsWith("E2E ")) {
          await context.delete(`/api/session/${encodeURIComponent(session.id)}`, {
            headers: { "x-factory-ui": "1" },
          });
        }
      }
    }
  } finally {
    await context.dispose();
  }
});

test.describe.serial("flujos críticos de la consola", () => {
  test("login obligatorio y sesión persistente", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("Contraseña de la consola")).toBeVisible();
    await page.getByLabel("Contraseña de la consola").fill("incorrecta");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("alert")).toContainText("Contraseña incorrecta");

    await page.getByLabel("Contraseña de la consola").fill(PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("link", { name: "Sessions" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("link", { name: "Sessions" })).toBeVisible();
  });

  test("crear, cambiar de sesión, conservar borrador y adjunto tras recargar", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Sessions" }).click();

    await createChat(page, "E2E A");
    const composer = page.getByPlaceholder(/Escribe un mensaje/);
    await composer.fill("borrador que debe sobrevivir");

    await page.locator('input[type="file"]').first().setInputFiles({
      name: "nota-e2e.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("adjunto de prueba"),
    });
    await expect(page.getByText("nota-e2e.txt")).toBeVisible();

    await createChat(page, "E2E B");
    await page.getByText("E2E A").first().click();
    await expect(page.getByPlaceholder(/Escribe un mensaje/)).toHaveValue(
      "borrador que debe sobrevivir",
    );
    await expect(page.getByText("nota-e2e.txt")).toBeVisible();

    await page.waitForTimeout(600);
    await page.reload();
    await expect(page.getByPlaceholder(/Escribe un mensaje/)).toHaveValue(
      "borrador que debe sobrevivir",
    );
    await expect(page.getByText("nota-e2e.txt")).toBeVisible();

    await page.getByRole("button", { name: "Eliminar chat" }).click();
    await page.getByRole("button", { name: "Eliminar chat" }).last().click();
    await expect(page.getByText("E2E A")).toHaveCount(0);
  });

  test("PWA: manifest y service worker activos", async ({ page }) => {
    await login(page);
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBe("/manifest.webmanifest");
    const manifest = await page.request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBeTruthy();
    const body = (await manifest.json()) as { display?: string; icons?: unknown[] };
    expect(body.display).toBe("standalone");
    expect(body.icons?.length ?? 0).toBeGreaterThanOrEqual(2);
    const registration = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return null;
      const ready = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      return ready ? "active" : null;
    });
    expect(registration).toBe("active");
  });

  test("la navegación móvil está disponible", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ajustes" }).last()).toBeVisible();
  });
});

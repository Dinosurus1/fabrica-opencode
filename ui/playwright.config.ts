import { defineConfig } from "@playwright/test";

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM ?? "/usr/lib/chromium/chromium";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: chromiumPath,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--ozone-platform=headless"],
    },
  },
  webServer: {
    command:
      "FACTORY_UI_PASSWORD=e2e-password FACTORY_UI_PORT=4174 FACTORY_UI_HOST=127.0.0.1 node server/index.mjs",
    url: "http://127.0.0.1:4174/auth/session",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 20_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173/phenometrix/",
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "pnpm exec tsx e2e/static-server.ts",
    url: "http://127.0.0.1:4173/phenometrix/",
    reuseExistingServer: false,
    timeout: 30_000
  }
});

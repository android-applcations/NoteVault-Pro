import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:4173", serviceWorkers: "allow" },
  webServer: { command: "npm run build && npm run preview -- --port 4173", url: "http://localhost:4173", reuseExistingServer: true, timeout: 180_000 },
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testMatch: "browser.test.mjs",
  workers: 2,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4174",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node server.mjs",
    env: { PORT: "4174" },
    url: "http://127.0.0.1:4174/healthz",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1000 },
        launchOptions: process.env.CHROMIUM_PATH
          ? { executablePath: process.env.CHROMIUM_PATH }
          : {},
      },
    },
    {
      name: "webkit-mobile",
      use: { ...devices["iPhone 13"], browserName: "webkit" },
    },
  ],
});

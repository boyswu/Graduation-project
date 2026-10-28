import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const artifactRoot = path.join(
  os.tmpdir(),
  "codex",
  "Graduation-project",
  "virtual-tryon-playwright",
);

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: path.join(artifactRoot, "artifacts"),
  use: {
    baseURL: "http://127.0.0.1:8766",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    launchOptions: {
      args: [
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--use-angle=d3d11",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "npm run dev -- --port 8766 --strictPort",
    url: "http://127.0.0.1:8766/",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

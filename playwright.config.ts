/**
 * proof:browser — the pencil-boil identity lane, run per engine at DPR2.
 *
 * A second gate alongside `npm test` (Node check + proofs): the browser-only half of the
 * 0.9.0 raster invariant that Node cannot reach (no canvas / ImageBitmap / SVG layout). The
 * fixture server transpiles the SHIPPED `src/raster.ts` on the fly, so the lane exercises the
 * real code. chromium AND webkit — WebKit is the whole reason the bitmap cache exists.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT) || 4337;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './proofs/browser',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    deviceScaleFactor: 2, // DPR2 — the production ratio the WebKit gap shows at
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 2 },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], deviceScaleFactor: 2 },
    },
  ],
  webServer: {
    command: 'node proofs/browser/server.mjs',
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PORT: String(PORT) },
  },
});

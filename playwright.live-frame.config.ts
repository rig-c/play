import { defineConfig } from '@playwright/test';

// Focused source-browser precheck. The normal suite still tests the production build.
export default defineConfig({
  testDir: './tests', testMatch: 'liveFrame.spec.ts', workers: 1, retries: 0,
  timeout: 60_000, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4341', viewport: { width: 900, height: 640 }, deviceScaleFactor: 1 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: { command: 'bunx --no-install vite --host 127.0.0.1 --port 4341 --strictPort', port: 4341, reuseExistingServer: false, timeout: 30_000 },
});

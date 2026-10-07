import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 60_000, workers: 1,
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'chromium-tablet', use: { ...devices['iPad Pro 11'], browserName: 'chromium' } },
    { name: 'webkit-tablet', use: { ...devices['iPad Pro 11'], browserName: 'webkit' } },
  ],
});

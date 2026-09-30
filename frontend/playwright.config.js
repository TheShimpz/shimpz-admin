import os from 'node:os';
import { defineConfig } from '@playwright/test';

const processors = os.availableParallelism();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.GITHUB_ACTIONS ? processors : Math.max(1, Math.floor(processors / 2)),
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { hasTouch: true, viewport: { width: 390, height: 844 } } },
    {
      name: 'firefox-browser-sensitive',
      grep: /@browser-sensitive/,
      use: { browserName: 'firefox', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'webkit-browser-sensitive',
      grep: /@browser-sensitive/,
      use: { browserName: 'webkit', viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    // Serves build/ like Admin's backend; CI copies the shipping UI out of the Admin image into build/.
    command: 'node e2e/serveBuild.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});

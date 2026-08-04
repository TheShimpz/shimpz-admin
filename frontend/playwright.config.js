import os from 'node:os';
import { defineConfig } from '@playwright/test';

const processors = os.availableParallelism();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: process.env.GITHUB_ACTIONS ? processors : Math.max(1, Math.floor(processors / 2)),
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});

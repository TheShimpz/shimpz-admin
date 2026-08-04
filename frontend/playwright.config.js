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
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});

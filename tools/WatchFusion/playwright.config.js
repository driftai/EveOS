import { defineConfig } from '@playwright/test';

const PORT = 19485;

export default defineConfig({
  testDir: './tests/smoke/browser',
  timeout: 30000,
  retries: 0,
  workers: 1, // Deterministic sequential runs for room tests
  reporter: [
    ['line'],
    ['json', { outputFile: 'test-results/playwright-report.json' }]
  ],
  use: {
    baseURL: `http://127-0-0-1.sslip.io:${PORT}`,
    headless: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off'
  },
  webServer: {
    command: `node server.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 10000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1'
    }
  }
});

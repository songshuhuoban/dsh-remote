import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/runtime.integration.test.tsx'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://127.0.0.1:3108/' } },
    testTimeout: 90000,
    hookTimeout: 180000,
    fileParallelism: false,
  },
});

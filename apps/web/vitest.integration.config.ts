import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/console.integration.test.tsx', 'src/control.integration.test.tsx'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://127.0.0.1:3109/' } },
    testTimeout: 30000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['src/runtime.integration.test.tsx'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://127.0.0.1:3108/' } },
    testTimeout: 90000,
    hookTimeout: 180000,
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['src/console.integration.test.tsx', 'src/control.integration.test.tsx'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://127.0.0.1:3109/' } },
    testTimeout: 30000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});

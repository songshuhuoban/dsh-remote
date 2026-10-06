/**
 * Builds the installable plugin: Host half, bundled connector, and the browser half in DSH's
 * client-module format (one registration call around a CommonJS factory).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string };
// Modules the DSH page shares with plugin halves; everything else must be bundled.
const PAGE_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis'];

async function build(options: Parameters<typeof Bun.build>[0]) {
  const result = await Bun.build(options);
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Build failed: ${options.entrypoints.join(', ')}`);
  }
  return result;
}

rmSync(dist, { recursive: true, force: true });
await build({
  entrypoints: [join(root, 'src/index.ts')],
  outdir: dist,
  naming: 'index.js',
  target: 'node',
  format: 'esm',
  // Resolved to DSH's own copies through peer dependencies.
  external: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
});
await build({
  entrypoints: [join(root, '../connector/src/index.ts')],
  outdir: dist,
  naming: 'connector.js',
  target: 'node',
  format: 'esm',
});
const client = await build({
  entrypoints: [join(root, 'src/client/index.tsx')],
  target: 'browser',
  format: 'cjs',
  external: PAGE_MODULES,
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
});
const body = await client.outputs[0]!.text();
writeFileSync(
  join(dist, 'client.js'),
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {\n` +
    'var module = { exports: {} }; var exports = module.exports;\n' +
    body +
    '\nreturn module.exports; } });\n',
);
console.log(`Built ${name} into ${dist}`);

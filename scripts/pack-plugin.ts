/**
 * Packs the DSH plugin into the built web console, so a relay serves the exact plugin it was
 * deployed with: `/plugin/<file>.tgz` for DSH's "add plugin" box and `/plugin/manifest.json`
 * for the console's install link. Run after `build:web`, which empties `apps/web/dist`.
 */
import { $ } from 'bun';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const plugin = join(root, 'packages/dsh-plugin');
const dist = join(root, 'apps/web/dist');
const out = join(dist, 'plugin');
if (!existsSync(join(dist, 'index.html')))
  throw new Error('apps/web/dist is missing; run `bun run build:web` first');

const { name, version } = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await $`bun run build`.cwd(plugin).quiet();
const packed = join(out, 'package.tgz');
await $`bun pm pack --filename ${packed} --quiet`.cwd(plugin).quiet();
const tarball = readFileSync(packed);
// pnpm pins a tarball URL to its integrity, so a URL's content must never change. Packing is
// reproducible, so a content hash in the name changes exactly when the plugin does, even
// without a version bump. Older files are not kept; DSH already has them installed.
const file = `dsh-remote-plugin-${version}-${createHash('sha256').update(tarball).digest('hex').slice(0, 8)}.tgz`;
renameSync(packed, join(out, file));
const manifest = {
  name,
  version,
  file,
  size: tarball.length,
  integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Packed ${name}@${version} into apps/web/dist/plugin/${file}`);

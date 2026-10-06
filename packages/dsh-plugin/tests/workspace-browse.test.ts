import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshAdapter, type AdapterPolicy } from '../src/adapter.ts';
import type { DshHostContext } from '../src/host.ts';

// The remote folder picker: which folders a remote device may list and open sessions in.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-browse-root-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-browse-outside-')));
for (const dir of ['beta', 'alpha', 'alpha/nested', '.hidden']) mkdirSync(join(root, dir));
writeFileSync(join(root, 'notes.txt'), 'not a folder');
mkdirSync(join(outside, 'private'));
let linked = false;
try {
  symlinkSync(outside, join(root, 'escape'), 'junction');
  linked = true;
} catch {
  // Links need extra rights on some Windows setups; the escape check is then covered by paths.
}
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function adapter(policy: { allowedWorkspaceRoots: string[]; allowAnyWorkspace?: boolean }) {
  const created: unknown[] = [];
  const ctx = {
    sessionController: {
      create: async (args: unknown) => {
        created.push(args);
        return { sessionId: 'created' };
      },
    },
    agents: { get: () => undefined },
    fileUploads: {},
    get: () => undefined,
    on: () => () => {},
    logger: { warn: () => {}, error: () => {} },
  } as unknown as DshHostContext;
  return { created, adapter: new DshAdapter(ctx, () => {}, policy as AdapterPolicy) };
}
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'ok';
};

test('lists the allowed folders and browses only inside them, folders only', async () => {
  const { adapter: a } = adapter({ allowedWorkspaceRoots: [root] });
  expect(await a.execute('workspace.list', {})).toEqual({
    roots: [{ name: root.split(/[\\/]/).at(-1)!, path: root }],
    anyWorkspace: false,
  });
  const start = (await a.execute('workspace.browse', {})) as any;
  expect(start.directories.map((d: any) => d.path)).toEqual([root]);
  const top = (await a.execute('workspace.browse', { path: root })) as any;
  // Hidden folders and files are left out; the root has no parent inside the allowed set.
  expect(top.directories.map((d: any) => d.name)).toEqual(
    linked ? ['alpha', 'beta', 'escape'] : ['alpha', 'beta'],
  );
  expect(top.parent).toBeNull();
  const child = (await a.execute('workspace.browse', { path: join(root, 'alpha') })) as any;
  expect(child.parent).toBe(root);
  expect(child.directories.map((d: any) => d.name)).toEqual(['nested']);
  a.dispose();
});

test('folders outside the allowed set cannot be listed or used, however they are spelled', async () => {
  const { adapter: a, created } = adapter({ allowedWorkspaceRoots: [root] });
  expect(await code(a.execute('workspace.browse', { path: outside }))).toBe('workspace_forbidden');
  expect(
    await code(
      a.execute('workspace.browse', { path: join(root, '..', outside.split(/[\\/]/).at(-1)!) }),
    ),
  ).toBe('workspace_forbidden');
  if (linked)
    expect(await code(a.execute('workspace.browse', { path: join(root, 'escape') }))).toBe(
      'workspace_forbidden',
    );
  expect(await code(a.execute('workspace.browse', { path: join(root, 'missing') }))).toBe(
    'not_found',
  );
  expect(await code(a.execute('workspace.browse', { path: join(root, 'notes.txt') }))).toBe(
    'not_a_directory',
  );
  expect(await code(a.execute('session.create', { sessionId: 'x', cwd: outside }, () => {}))).toBe(
    'workspace_forbidden',
  );
  expect(created).toEqual([]);
  a.dispose();
});

test('with "any folder" allowed on the DSH computer, its other folders open too', async () => {
  const { adapter: a, created } = adapter({
    allowedWorkspaceRoots: [root],
    allowAnyWorkspace: true,
  });
  expect(((await a.execute('workspace.list', {})) as any).anyWorkspace).toBe(true);
  const start = (await a.execute('workspace.browse', {})) as any;
  expect(start.directories.map((d: any) => d.path)).toContain(homedir());
  const other = (await a.execute('workspace.browse', { path: outside })) as any;
  expect(other.directories.map((d: any) => d.name)).toEqual(['private']);
  await a.execute('session.create', { sessionId: 'x', cwd: join(outside, 'private') }, () => {});
  expect(created).toEqual([{ sessionId: 'x', cwd: join(outside, 'private') }]);
  a.dispose();
});

test('without any allowed folder, creating a session explains what is missing', async () => {
  const { adapter: a } = adapter({ allowedWorkspaceRoots: [] });
  expect(await code(a.execute('session.create', { sessionId: 'x' }, () => {}))).toBe(
    'no_workspace',
  );
  expect(((await a.execute('workspace.browse', {})) as any).directories).toEqual([]);
  a.dispose();
});

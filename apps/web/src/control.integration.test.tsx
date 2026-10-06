// @vitest-environment-options {"url":"http://127.0.0.1:3110/"}
/** Real Bun relay + rendered React DOM + a fixture connector: how the console takes control. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
let relay: ChildProcess,
  connector: NodeWebSocket | undefined,
  cookie = '';
const request = globalThis.fetch;
const base = 'http://127.0.0.1:3110';
const root = resolve('../..');
const password = 'Synthetic-DOM-Only-2026!';
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dom-control-'));
  relay = spawn(process.env.BUN_PATH ?? 'bun', ['apps/server/src/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '3110',
      HOST: '127.0.0.1',
      REGISTRATION: 'enabled',
      DATABASE_PATH: join(dir, 'relay.sqlite'),
      WEB_DIST: 'apps/web/dist',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((done, reject) => {
    relay.stdout!.on('data', (data) => {
      if (String(data).includes('listening')) done();
    });
    relay.on('error', reject);
    relay.on('exit', (code) => {
      if (code) reject(new Error(`Relay exited ${code}`));
    });
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set('Origin', base);
    if (cookie) headers.set('Cookie', cookie);
    const response = await request(new URL(String(input), base), { ...options, headers });
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0]!;
    return response;
  });
  class AuthWebSocket extends NodeWebSocket {
    constructor(url: string) {
      super(url, { headers: { Origin: base, Cookie: cookie } });
    }
  }
  vi.stubGlobal('WebSocket', AuthWebSocket);
  window.scrollTo = () => {};
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
  HTMLElement.prototype.scrollIntoView = () => {};
  document.body.innerHTML = '<div id="root"></div>';
  await import('./main');
});
afterAll(() => {
  connector?.close();
  relay?.kill('SIGTERM');
  vi.unstubAllGlobals();
});

/** Folders of the fixture host: one allowed root, browsing anywhere switched on. */
const folders: Record<string, { parent: string | null; children: string[] }> = {
  '/srv/proj': { parent: '/srv', children: ['api', 'web'] },
  '/srv/proj/api': { parent: '/srv/proj', children: [] },
};
const created: unknown[] = [];
function answer(action: string, args: Record<string, unknown>): unknown {
  if (action === 'workspace.list')
    return { roots: [{ name: 'proj', path: '/srv/proj' }], anyWorkspace: true };
  if (action === 'workspace.browse') {
    const path = args.path as string | undefined;
    if (!path)
      return {
        path: null,
        parent: null,
        directories: [
          { name: 'proj', path: '/srv/proj' },
          { name: 'me', path: '/home/me' },
        ],
        truncated: false,
      };
    const folder = folders[path]!;
    return {
      path,
      parent: folder.parent,
      directories: folder.children.map((name) => ({ name, path: `${path}/${name}` })),
      truncated: false,
    };
  }
  if (action === 'session.create') {
    created.push(args);
    return { sessionId: args.sessionId };
  }
  return { items: [] };
}
/** A host that acknowledges leases and answers commands from the fixture above. */
function connect(token: string) {
  let epoch = 0;
  const socket = new NodeWebSocket(`${base.replace('http', 'ws')}/ws/connector`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    const send = (value: unknown) => socket.send(JSON.stringify({ v: 1, ...(value as object) }));
    if (frame.type === 'welcome') {
      epoch = frame.connectionEpoch;
      send({
        type: 'hello',
        bootId: 'control-fixture',
        capabilities: ['session.list', 'session.create', 'workspace.list', 'workspace.browse'],
      });
    } else if (frame.type === 'lease')
      send({
        type: 'lease.ack',
        epoch: frame.epoch,
        expiresAt: frame.expiresAt,
        connectionEpoch: epoch,
      });
    else if (frame.type === 'command')
      send({
        type: 'result',
        id: frame.id,
        connectionEpoch: epoch,
        ok: true,
        result: answer(frame.action, frame.args),
      });
  });
  return socket;
}
/** Another device of the same account, driven through the native (bearer) API. */
async function otherDevice(email: string) {
  const login = await request(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, deviceName: '另一台设备' }),
  });
  const { token, controller } = (await login.json()) as {
    token: string;
    controller: { id: string };
  };
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return {
    async takeover() {
      const list = await request(`${base}/api/instances`, { headers: auth });
      const [instance] = ((await list.json()) as { instances: { id: string }[] }).instances;
      const response = await request(`${base}/api/instances/${instance!.id}/lease`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ controllerId: controller.id, takeover: true }),
      });
      expect(response.ok).toBe(true);
    },
  };
}

it('connecting takes free control, a takeover leaves this tab watching, and taking back asks first', async () => {
  const email = `dom-control-${Date.now()}@example.test`;
  expect(await screen.findByRole('heading', { name: '登录' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '创建账户' }));
  fireEvent.change(screen.getByLabelText('邮箱', {}), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('密码', {}), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: '创建账户' }));
  await waitFor(() => expect(document.querySelector('[data-stream="live"]')).not.toBeNull());
  fireEvent.click(await screen.findByRole('button', { name: '连接新实例' }));
  fireEvent.change(screen.getByLabelText('实例名称'), { target: { value: 'Control host' } });
  fireEvent.click(screen.getByRole('button', { name: '创建实例' }));
  const token = ((await screen.findByLabelText('Connector 令牌')) as HTMLTextAreaElement).value;
  fireEvent.click(screen.getByRole('button', { name: '进入实例' }));
  expect(await screen.findByRole('heading', { name: 'Control host' })).toBeTruthy();

  // Free instance: connecting is enough, no "获取控制权" step.
  connector = connect(token);
  expect(await screen.findByRole('button', { name: /控制中/ }, { timeout: 10000 })).toBeTruthy();
  const newSession = screen.getAllByRole('button', { name: /新建会话/ });
  expect(newSession.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);

  // Pushed off by another device: read-only, no prompt, and no grabbing it back.
  await (await otherDevice(email)).takeover();
  expect(await screen.findByText(/另一台设备 已接管控制/, {}, { timeout: 10000 })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: '接管' })).toBeTruthy();

  // Taking it back is explicit and confirmed; "新建会话" leads through the same prompt.
  fireEvent.click(screen.getAllByRole('button', { name: /新建会话/ }).at(-1)!);
  const prompt = within(await screen.findByRole('dialog'));
  expect(prompt.getByText('另一台设备 正在控制')).toBeTruthy();
  fireEvent.click(prompt.getByRole('button', { name: '接管' }));
  expect(await screen.findByRole('heading', { name: '新建会话' })).toBeTruthy();
  // The page behind a modal dialog is hidden from assistive tech, so look past it on purpose.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /控制中/, hidden: true })).toBeTruthy(),
  );

  // The host's allowed folder is offered and chosen; other folders are browsed, never typed.
  const dialog = within(screen.getByRole('dialog'));
  const root = await dialog.findByRole('radio', { name: /proj/ });
  await waitFor(() => expect(root.getAttribute('aria-checked')).toBe('true'));
  expect(dialog.queryByRole('textbox')).toBeNull();
  fireEvent.click(dialog.getByRole('button', { name: '浏览其他目录' }));
  fireEvent.click(await dialog.findByRole('button', { name: /^api/ }));
  // The location reads as breadcrumbs in the host's own style, ending at the current folder.
  const here = await dialog.findByText('api', { selector: '[aria-current]' });
  expect(here.closest('nav')?.textContent).toBe('此电脑/srvprojapi');
  expect(dialog.getByText('没有子文件夹')).toBeTruthy();
  fireEvent.click(dialog.getByRole('button', { name: '使用此目录' }));
  const chosen = await dialog.findByRole('radio', { name: /api/ });
  expect(chosen.getAttribute('aria-checked')).toBe('true');
  await waitFor(() =>
    expect((dialog.getByRole('button', { name: '创建会话' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(dialog.getByRole('button', { name: '创建会话' }));
  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0]).toMatchObject({ cwd: '/srv/proj/api' });
});

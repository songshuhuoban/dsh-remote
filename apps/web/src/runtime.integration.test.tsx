/** Real Bun relay + rendered React DOM; browser layout is deliberately not claimed. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
let relay: ChildProcess,
  cookie = '';
const request = globalThis.fetch;
const base = 'http://127.0.0.1:3108';
const root = resolve('../..');
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dom-e2e-'));
  relay = spawn(process.env.BUN_PATH ?? 'bun', ['packages/dsh-plugin/tests/runtime-smoke.ts'], {
    cwd: root,
    env: {
      ...process.env,
      LIVE_PROVIDER_E2E: '0',
      DSH_E2E_PORT: '3108',
      DSH_E2E_KEEP_RUNNING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((done, reject) => {
    relay.stdout!.on('data', (data) => {
      if (String(data).includes('FIXTURE_READY')) done();
    });
    relay.stderr!.on('data', (data) => process.stderr.write(String(data)));
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
  relay?.kill('SIGTERM');
  vi.unstubAllGlobals();
});
it('actual DSH: login, explicit takeover, create session, prompt, durable response, model config, and bound approval', async () => {
  expect(await screen.findByRole('heading', { name: '登录' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('邮箱', {}), {
    target: { value: 'real-runtime@example.invalid' },
  });
  fireEvent.change(screen.getByLabelText('密码', {}), {
    target: { value: 'local-fixture-password-only' },
  });
  fireEvent.change(screen.getByLabelText('设备名称'), {
    target: { value: 'DOM real DSH controller' },
  });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByRole('heading', { name: /Actual upstream source/ })).toBeTruthy();
  await waitFor(() => expect(document.querySelector('[data-stream="live"]')).not.toBeNull());
  // Connecting asks before pushing the other controller off; declining only watches.
  const prompt = await screen.findByRole('dialog');
  fireEvent.click(within(prompt).getByRole('button', { name: '仅查看' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '接管' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '接管' }));
  expect(await screen.findByRole('button', { name: /控制中/ })).toBeTruthy();
  const newButtons = screen.getAllByRole('button', { name: /新建会话/ });
  fireEvent.click(newButtons.at(-1)!);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '创建会话' }));
  const input = await screen.findByRole('textbox', { name: '消息' });
  const referenceSelect = screen.getByLabelText('添加仓库引用') as HTMLSelectElement;
  await waitFor(() =>
    expect(
      [...referenceSelect.options].some((option) =>
        option.text.includes('dsh-local-fixture/primary'),
      ),
    ).toBe(true),
  );
  for (const name of ['primary', 'secondary']) {
    const value = [...referenceSelect.options].find((option) =>
      option.text.includes(`dsh-local-fixture/${name}`),
    )!.value;
    fireEvent.change(referenceSelect, { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: '预览引用上下文' }));
  expect(screen.getByRole('dialog').textContent).toContain('dsh-local-fixture/primary');
  expect(screen.getByRole('dialog').textContent).toContain('dsh-local-fixture/secondary');
  expect(screen.getByRole('dialog').textContent).not.toContain('REPOSITORY_CONFIG_SECRET');
  fireEvent.click(screen.getByRole('button', { name: '返回草稿' }));
  fireEvent.change(input, { target: { value: 'React DOM drove this real DSH prompt.' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(
    () =>
      expect(document.querySelector('.user-message')?.textContent).toContain(
        'React DOM drove this real DSH prompt.',
      ),
    { timeout: 20000 },
  );
  await waitFor(
    () =>
      expect(
        [...document.querySelectorAll('.message-text')].some((el) =>
          el.textContent?.includes('REAL_DSH_PIPELINE_OK'),
        ),
      ).toBe(true),
    { timeout: 20000 },
  );
  expect(document.querySelectorAll('.user-message')).toHaveLength(1);
  expect(document.querySelector('.user-message')?.textContent).toContain(
    'Selected repository metadata: untrusted data',
  );
  expect(document.querySelector('.runtime-record')).toBeTruthy();
  fireEvent.click(document.querySelector('.model-button')!);
  const dialog = screen.getByRole('dialog');
  expect(await within(dialog).findByLabelText('提供商')).toBeTruthy();
  await waitFor(
    () => expect((within(dialog).getByLabelText('模型') as HTMLSelectElement).value).not.toBe(''),
    { timeout: 10000 },
  );
  fireEvent.click(within(dialog).getByRole('button', { name: '应用配置' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 10000 });
  // Upload is delivered to the actual DSH attachment service before prompt admission.
  fireEvent.change(document.querySelector('input[type=file]')!, {
    target: {
      files: [new File(['UI attachment fixture'], 'ui-fixture.txt', { type: 'text/plain' })],
    },
  });
  expect(await screen.findByText('ui-fixture.txt', {}, { timeout: 10000 })).toBeTruthy();
  fireEvent.change(input, { target: { value: 'Use the uploaded UI fixture.' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(document.querySelector('.attachment-list')).toBeNull(), {
    timeout: 10000,
  });
  await waitFor(
    () =>
      expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    { timeout: 10000 },
  );
  fireEvent.change(input, {
    target: { value: 'APPROVAL_INTEGRATION deny the isolated UI test action.' },
  });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(await screen.findByText('等待你的审批', {}, { timeout: 20000 })).toBeTruthy();
  expect(screen.getByText('remote-e2e-fixture', {})).toBeTruthy();
  // Keep an approval pending so the real inbox can be edited without a consumption race.
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false), {
    timeout: 10000,
  });
  fireEvent.change(input, { target: { value: 'UI pending queue message' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(
    () =>
      expect(document.querySelector('.queue-list')?.textContent).toContain(
        'UI pending queue message',
      ),
    { timeout: 10000 },
  );
  fireEvent.click(await screen.findByRole('button', { name: '编辑队列项' }));
  fireEvent.change(screen.getByRole('textbox', { name: '队列消息' }), {
    target: { value: 'UI edited queue message' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存队列消息' }));
  expect(await screen.findByText('UI edited queue message', {}, { timeout: 10000 })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '移除队列项' }));
  await waitFor(() => expect(screen.queryByText('UI edited queue message')).toBeNull(), {
    timeout: 10000,
  });
  fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
  await waitFor(() => expect(screen.queryByText('等待你的审批', {})).toBeNull(), {
    timeout: 10000,
  });
  fireEvent.click(screen.getByRole('button', { name: /控制中，点击释放/ }));
  // Released on purpose: the console must not take it straight back.
  expect(await screen.findByRole('button', { name: '开始控制' })).toBeTruthy();
  expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

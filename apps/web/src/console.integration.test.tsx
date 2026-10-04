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
const base = 'http://127.0.0.1:3109';
const root = resolve('../..');
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dom-e2e-'));
  relay = spawn(process.env.BUN_PATH ?? 'bun', ['apps/server/src/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '3109',
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
  relay?.kill('SIGTERM');
  vi.unstubAllGlobals();
});
it('registers through React, creates an offline instance, safely disables writes, closes a modal, and logs out', async () => {
  const email = `dom-e2e-${Date.now()}@example.test`;
  expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '创建账户' }));
  fireEvent.change(screen.getByLabelText('邮箱', {}), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText('密码', {}), {
    target: { value: 'Synthetic-DOM-Only-2026!' },
  });
  fireEvent.change(screen.getByLabelText('当前设备名称'), { target: { value: 'DOM 测试设备' } });
  fireEvent.click(screen.getByRole('button', { name: '创建账户' }));
  expect(await screen.findByRole('heading', { name: '连接你的第一台 DSH' })).toBeTruthy();
  expect(await screen.findByText('实时同步', {})).toBeTruthy();
  expect(Object.keys(localStorage)).toEqual([]);
  expect(Object.keys(sessionStorage)).toEqual(['dsh.controller']);
  const create = screen.getAllByRole('button', { name: '连接新实例' }).at(-1)!;
  fireEvent.click(create);
  fireEvent.change(screen.getByLabelText('实例名称'), { target: { value: 'Cancelled instance' } });
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(create);
  fireEvent.change(screen.getByLabelText('实例名称'), { target: { value: 'DOM real relay' } });
  fireEvent.click(screen.getByRole('button', { name: '创建实例' }));
  expect(await screen.findByRole('heading', { name: '实例已创建' })).toBeTruthy();
  expect(
    (screen.getByLabelText('Connector 令牌') as HTMLTextAreaElement).value.length,
  ).toBeGreaterThan(20);
  fireEvent.click(screen.getByRole('button', { name: '我已保存，进入实例' }));
  expect(await screen.findByRole('heading', { name: /DOM real relay/ })).toBeTruthy();
  expect((screen.getByRole('button', { name: '获取控制权' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  for (const element of screen.getAllByRole('button', { name: /新建会话/ }))
    expect((element as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'GitHub 仓库' }));
  expect(await screen.findByText('此部署尚未配置 GitHub App')).toBeTruthy();
  expect((screen.getByRole('button', { name: '连接 GitHub' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: '手动映射' }));
  fireEvent.change(screen.getByLabelText('GitHub 仓库 URL'), {
    target: { value: 'https://github.com/example/local-repo' },
  });
  fireEvent.change(screen.getByLabelText('已有工作树绝对路径'), {
    target: { value: '/allowed/../escape' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存映射' }));
  expect(await screen.findByText(/请输入已有工作树的规范绝对路径/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('已有工作树绝对路径'), {
    target: { value: '/allowed/existing-repo' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存映射' }));
  expect(await screen.findByText('example/local-repo')).toBeTruthy();
  expect(screen.getByText('待主机验证 · 手动声明')).toBeTruthy();
  expect((screen.getByRole('button', { name: '验证工作树' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByLabelText('供消息引用'));
  await waitFor(() =>
    expect((screen.getByLabelText('供消息引用') as HTMLInputElement).checked).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '返回会话' }));
  fireEvent.click(screen.getByRole('button', { name: '实例状态' }));
  expect(screen.getByText(/最近心跳：尚未观测到/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^返回$/ }));
  fireEvent.click(screen.getByRole('button', { name: '实例连接凭据' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '实例连接凭据' }));
  fireEvent.click(screen.getByRole('button', { name: '确认更换' }));
  expect(await screen.findByRole('heading', { name: '新的连接令牌' })).toBeTruthy();
  expect(
    (screen.getByLabelText('Connector 令牌') as HTMLTextAreaElement).value.length,
  ).toBeGreaterThan(20);
  fireEvent.click(screen.getByRole('button', { name: '我已保存' }));
  fireEvent.click(screen.getByRole('button', { name: /控制设备/ }));
  expect(within(screen.getByRole('dialog')).getByText('DOM 测试设备')).toBeTruthy();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
  expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeTruthy();
  await waitFor(() => expect(sessionStorage.getItem('dsh.controller')).toBeNull());
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('密码'), {
    target: { value: 'Synthetic-DOM-Only-2026!' },
  });
  fireEvent.change(screen.getByLabelText('当前设备名称'), { target: { value: '待撤销设备' } });
  fireEvent.click(screen.getByRole('button', { name: '登录控制台' }));
  expect(await screen.findByRole('heading', { name: /DOM real relay/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /控制设备/ }));
  fireEvent.click(await screen.findByRole('button', { name: '撤销登录' }));
  expect(screen.getByText(/这是当前设备，确认后你将退出登录/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
  expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeTruthy();
});

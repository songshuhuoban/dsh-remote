import { afterAll, expect, test } from 'bun:test';
import { createRelay } from '../apps/server/src/server.ts';
import type { GitHubOptions } from '../apps/server/src/github.ts';

// "Sign in with GitHub" against deterministic GitHub fixtures, not a live OAuth E2E.
const github: GitHubOptions = {
  clientId: 'Iv1_fixture',
  clientSecret: 'fixture-secret-not-production',
  appSlug: 'dsh-fixture',
  callbackUrl: 'http://127.0.0.1:3000/github/callback',
  tokenEncryptionKey: Buffer.alloc(32, 9).toString('base64'),
};
let gitHubUser = { id: 4001, login: 'octo-fixture' };
const transport = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes('/login/oauth/access_token'))
    return Response.json({ access_token: 'ghu_FIXTURE_SIGNIN', expires_in: 28800 });
  if (url === 'https://api.github.com/user') return Response.json(gitHubUser);
  throw new Error(`Unexpected fixture request ${url}`);
}) as typeof fetch;
const relay = createRelay({
  databasePath: ':memory:',
  port: 0,
  registration: true,
  inviteCode: 'invite-fixture',
  github,
  githubTransport: transport,
});
const base = String(relay.server.url).replace(/\/$/, '');
afterAll(() => relay.stop());

const cookieOf = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith(`${name}=`));
async function post(path: string, body: unknown, cookie?: string) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}
/** Starts a GitHub flow in a "browser" and returns its state and flow cookie. */
async function start(body: Record<string, unknown> = {}) {
  const response = await post('/api/auth/github', { deviceName: 'Fixture browser', ...body });
  expect(response.status).toBe(200);
  const { authorizationUrl } = (await response.json()) as { authorizationUrl: string };
  return {
    state: new URL(authorizationUrl).searchParams.get('state')!,
    flow: cookieOf(response, 'dsh_github_flow')!,
  };
}
async function callback(state: string, flow: string) {
  const response = await fetch(`${base}/github/callback?state=${state}&code=fixture-code`, {
    headers: { cookie: flow },
    redirect: 'manual',
  });
  expect(response.status).toBe(303);
  return {
    outcome: new URL(response.headers.get('location')!).searchParams.get('github'),
    session: cookieOf(response, 'dsh_session'),
  };
}
const me = async (session: string) =>
  (await (await fetch(`${base}/api/me`, { headers: { cookie: session } })).json()) as {
    user: { id: string; email: string; github: string | null };
    controller: { id: string };
  };

test('health advertises GitHub sign-in once the GitHub App is configured', async () => {
  const health = (await (await fetch(`${base}/health`)).json()) as { githubSignIn: boolean };
  expect(health.githubSignIn).toBe(true);
});

test('an unknown GitHub account needs the invite code; a linked one signs straight in', async () => {
  gitHubUser = { id: 4001, login: 'octo-fixture' };
  expect((await post('/api/auth/github', { inviteCode: 'wrong' })).status).toBe(403);

  const uninvited = await start();
  expect(await callback(uninvited.state, uninvited.flow)).toEqual({
    outcome: 'INVITE_REQUIRED',
    session: undefined,
  });

  const invited = await start({ inviteCode: 'invite-fixture' });
  const first = await callback(invited.state, invited.flow);
  expect(first.outcome).toBe('signed_in');
  const account = await me(first.session!);
  expect(account.user.github).toBe('octo-fixture');
  // Signing in also connects GitHub for repository access.
  const status = await fetch(`${base}/api/github/status`, { headers: { cookie: first.session! } });
  expect(((await status.json()) as { state: string }).state).toBe('connected');
  // GitHub-created accounts have no password to guess.
  const password = await post('/api/auth/login', {
    email: account.user.email,
    password: 'any-password-at-all',
  });
  expect(password.status).toBe(401);

  // Returning user: no invite needed, same relay account, a new controller.
  const again = await start();
  const second = await callback(again.state, again.flow);
  expect(second.outcome).toBe('signed_in');
  const returning = await me(second.session!);
  expect(returning.user.id).toBe(account.user.id);
  expect(returning.controller.id).not.toBe(account.controller.id);
});

test('a sign-in state is single use and bound to the starting browser', async () => {
  gitHubUser = { id: 4001, login: 'octo-fixture' };
  const flow = await start();
  const other = await start();
  expect((await callback(flow.state, other.flow)).outcome).toBe('GITHUB_INVALID_STATE');
  expect((await callback(flow.state, flow.flow)).outcome).toBe('signed_in');
  expect((await callback(flow.state, flow.flow)).outcome).toBe('GITHUB_INVALID_STATE');
});

test('connecting GitHub from a password account links it for later sign-in', async () => {
  gitHubUser = { id: 5002, login: 'linked-fixture' };
  const registered = await post('/api/auth/register', {
    email: 'linker@example.invalid',
    password: 'synthetic-password-only',
    inviteCode: 'invite-fixture',
  });
  const session = cookieOf(registered, 'dsh_session')!;
  const owner = await me(session);
  const authorize = await post(
    '/api/github/authorize',
    { controllerId: owner.controller.id },
    session,
  );
  const { authorizationUrl } = (await authorize.json()) as { authorizationUrl: string };
  const connected = await callback(
    new URL(authorizationUrl).searchParams.get('state')!,
    cookieOf(authorize, 'dsh_github_flow')!,
  );
  expect(connected).toEqual({ outcome: 'connected', session: undefined });

  const signIn = await start();
  const result = await callback(signIn.state, signIn.flow);
  expect(result.outcome).toBe('signed_in');
  expect((await me(result.session!)).user.id).toBe(owner.user.id);
});

test('native clients cannot start a browser-bound GitHub sign-in', async () => {
  const response = await fetch(`${base}/api/auth/github`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(409);
});

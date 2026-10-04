import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { openStore } from '../apps/server/src/store.ts';
import {
  createGitHubService,
  canonicalGitHubUrl,
  repositoryBranch,
  repositoryPath,
  type GitHubAuth,
  type GitHubOptions,
} from '../apps/server/src/github.ts';
import { createRelay } from '../apps/server/src/server.ts';

// These are deterministic protocol fixtures, not a live OAuth or GitHub E2E test.
const fixtureOptions: GitHubOptions = {
  clientId: 'Iv1_fixture',
  clientSecret: 'fixture-secret-not-production',
  appSlug: 'dsh-fixture',
  callbackUrl: 'http://127.0.0.1:3000/github/callback',
  tokenEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
};
const fixtures: ReturnType<typeof openStore>[] = [];
afterEach(() => {
  for (const db of fixtures.splice(0)) db.close();
});
function fixture(transport?: typeof fetch, options = fixtureOptions) {
  const db = openStore(':memory:');
  fixtures.push(db);
  for (const user of ['alice', 'bob']) {
    db.query('INSERT INTO users VALUES(?,?,?,?)').run(
      user,
      `${user}@fixture.invalid`,
      'not-a-real-password-hash',
      1,
    );
    db.query('INSERT INTO controllers VALUES(?,?,?,?)').run(`ctl-${user}`, user, 'Fixture', 1);
    db.query('INSERT INTO auth_sessions VALUES(?,?,?,?)').run(
      `session-${user}`,
      user,
      `ctl-${user}`,
      Date.now() + 60_000,
    );
    db.query('INSERT INTO instances(id,user_id,name,token_hash,created_at) VALUES(?,?,?,?,?)').run(
      `ins-${user}`,
      user,
      'Fixture',
      `connector-${user}`,
      1,
    );
  }
  const auth = (name: string): GitHubAuth => ({
    userId: name,
    controllerId: `ctl-${name}`,
    tokenHash: `session-${name}`,
  });
  return {
    db,
    github: createGitHubService(db, options, transport),
    alice: auth('alice'),
    bob: auth('bob'),
  };
}
const installation = {
  id: 81,
  app_slug: 'dsh-fixture',
  account: { id: 91, login: 'fixture-org' },
  permissions: { contents: 'read', metadata: 'read' },
  repository_selection: 'selected',
  suspended_at: null,
};
const repo = {
  id: 101,
  full_name: 'fixture-org/project',
  html_url: 'https://github.com/fixture-org/project',
  default_branch: 'main',
  private: true,
  archived: false,
};
function transportFixture(
  overrides: Record<string, unknown> = {},
  requests: Array<{ url: string; init?: RequestInit }> = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes('/login/oauth/access_token'))
      return Response.json({
        access_token: 'ghu_FIXTURE_SECRET',
        expires_in: 28800,
        refresh_token: 'ghr_DISCARDED_FIXTURE',
        ...overrides,
      });
    if (url === 'https://api.github.com/user')
      return Response.json({ id: 4, login: 'fixture-user' });
    if (url.includes('/user/installations/81/repositories'))
      return Response.json({ repositories: [repo], total_count: 1 });
    if (url.includes('/user/installations?'))
      return Response.json({ installations: [installation], total_count: 1 });
    throw new Error('Unexpected fixture request');
  }) as typeof fetch;
}
async function connect(f: ReturnType<typeof fixture>) {
  const flow = f.github.authorize(f.alice),
    url = new URL(flow.authorizationUrl);
  const req = new Request(
    `${fixtureOptions.callbackUrl}?state=${url.searchParams.get('state')}&code=fixture-code`,
    { headers: { cookie: flow.cookie.split(';')[0]! } },
  );
  await f.github.finishAuthorization(req);
  return { flow, req, url };
}
const mapping = {
  source: 'manual',
  url: 'https://github.com/fixture-org/project.git',
  defaultBranch: 'main',
  localPath: '/allowed/project',
};
const inspection = {
  path: '/allowed/project',
  name: 'fixture-org/project',
  remote: { owner: 'fixture-org', name: 'project', url: 'https://github.com/fixture-org/project' },
  branch: 'main',
  commit: 'a'.repeat(40),
};

describe('GitHub configuration and repository input', () => {
  test('unconfigured auth fails explicitly while manual mapping works', async () => {
    const f = fixture(undefined, {});
    expect(f.github.status('alice').configured).toBe(false);
    expect(() => f.github.authorize(f.alice)).toThrow('Configure');
    const { repository } = await f.github.register(f.alice, 'ins-alice', mapping);
    expect(repository.localState).toBe('declared');
    expect(repository.authorization).toBe('manual');
    expect(repository.cloned).toBe(false);
  });
  test('rejects insecure config, credentials, traversal and branch option injection', () => {
    const f = fixture(undefined, {
      ...fixtureOptions,
      callbackUrl: 'http://unsafe.example/github/callback',
    });
    expect(f.github.status('alice').configured).toBe(false);
    for (const value of [
      'https://user:pass@github.com/a/b',
      'https://github.com/a/b?token=secret',
      'http://github.com/a/b',
      'https://evil.example/a/b',
      'https://github.com/a/..',
      'https://github.com/a/b/../../c',
    ])
      expect(() => canonicalGitHubUrl(value)).toThrow();
    for (const value of [
      '/allowed/../secret',
      '/allowed//repo',
      'relative',
      '/allowed/repo/',
      '/allowed/repo\n',
    ])
      expect(() => repositoryPath(value)).toThrow();
    for (const value of [
      '--upload-pack=evil',
      'main;\ncommand',
      'a..b',
      'a@{b',
      'a.lock',
      '/main',
      'a\\b',
    ])
      expect(() => repositoryBranch(value)).toThrow();
    expect(repositoryBranch('feature/repository-context')).toBe('feature/repository-context');
  });
});

describe('GitHub OAuth protocol fixture', () => {
  test('PKCE, HttpOnly callback cookie, encrypted short-lived token and replay prevention', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [],
      f = fixture(transportFixture({}, requests));
    const { flow, req, url } = await connect(f);
    expect(flow.cookie).toContain('HttpOnly');
    expect(flow.cookie).toContain('SameSite=Lax');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const exchange = requests.find((r) => r.url.includes('access_token'))!;
    const form = new URLSearchParams(String(exchange.init?.body));
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
      url.searchParams.get('code_challenge')!,
    );
    expect(exchange.init?.redirect).toBe('error');
    expect(f.github.status('alice').state).toBe('connected');
    const rows = JSON.stringify(f.db.query('SELECT * FROM github_accounts').all());
    expect(rows).not.toContain('ghu_');
    expect(rows).not.toContain('ghr_');
    expect(JSON.stringify(f.github.status('alice'))).not.toContain('token_ciphertext');
    await expect(f.github.finishAuthorization(req)).rejects.toThrow('another browser');
    const result = await f.github.repositories('alice', 81);
    expect(result.repositories[0]?.fullName).toBe('fixture-org/project');
  });
  test('wrong browser, expired state, expired session and cancelled flow never exchange', async () => {
    let calls = 0;
    const f = fixture((async () => {
      calls++;
      throw new Error();
    }) as unknown as typeof fetch);
    const flow = f.github.authorize(f.alice),
      url = new URL(flow.authorizationUrl);
    const callback = `${fixtureOptions.callbackUrl}?state=${url.searchParams.get('state')}&code=fixture`;
    await expect(f.github.finishAuthorization(new Request(callback))).rejects.toThrow(
      'another browser',
    );
    f.github.cancelAuthorization(f.alice);
    await expect(
      f.github.finishAuthorization(new Request(callback, { headers: { cookie: flow.cookie } })),
    ).rejects.toThrow('another browser');
    const cancelled = f.github.authorize(f.alice),
      cancellation = new URL(cancelled.authorizationUrl);
    expect(
      await f.github.finishAuthorization(
        new Request(
          `${fixtureOptions.callbackUrl}?state=${cancellation.searchParams.get('state')}&error=access_denied`,
          { headers: { cookie: cancelled.cookie } },
        ),
      ),
    ).toEqual({ outcome: 'cancelled' });
    const expired = f.github.authorize(f.alice),
      expiredUrl = new URL(expired.authorizationUrl);
    f.db.query('UPDATE github_auth_states SET expires_at=0').run();
    await expect(
      f.github.finishAuthorization(
        new Request(
          `${fixtureOptions.callbackUrl}?state=${expiredUrl.searchParams.get('state')}&code=x`,
          { headers: { cookie: expired.cookie } },
        ),
      ),
    ).rejects.toThrow('expired');
    f.db.query('UPDATE auth_sessions SET expires_at=0').run();
    expect(() => f.github.authorize(f.alice)).toThrow('session expired');
    expect(calls).toBe(0);
  });
  test('rejects non-expiring tokens and redacts provider errors', async () => {
    const f = fixture(transportFixture({ expires_in: undefined }));
    await expect(connect(f)).rejects.toThrow('expiring user token');
    expect(f.github.status('alice').state).toBe('disconnected');
  });
  test('disconnect during pending exchange cannot restore grant', async () => {
    let release!: () => void, seen!: () => void;
    const started = new Promise<void>((resolve) => (seen = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    const fixtureTransport = transportFixture();
    const f = fixture((async (input, init) => {
      if (String(input).includes('access_token')) {
        seen();
        await gate;
      }
      return fixtureTransport(input, init);
    }) as typeof fetch);
    const pending = connect(f);
    await started;
    f.github.disconnect(f.alice);
    release();
    await expect(pending).rejects.toThrow('cancelled or replaced');
    expect(f.github.status('alice').state).toBe('disconnected');
  });
  test('excess installation permissions are rejected and no arbitrary provider URL is followed', async () => {
    const fixtureTransport = transportFixture();
    const f = fixture((async (input, init) =>
      String(input).includes('/user/installations?')
        ? Response.json({
            installations: [
              { ...installation, permissions: { contents: 'write', metadata: 'read' } },
            ],
            total_count: 1,
          })
        : fixtureTransport(input, init)) as typeof fetch);
    await connect(f);
    await expect(f.github.repositories('alice', 81)).rejects.toThrow('only Contents read');
  });
});

describe('instance-owned local mappings', () => {
  test('cannot cross user or instance, requires host verification, separates authorization', async () => {
    const f = fixture(transportFixture());
    const { repository } = await f.github.register(f.alice, 'ins-alice', mapping);
    expect(() => f.github.references('bob', 'ins-alice')).toThrow('Instance not found');
    expect(() => f.github.inspectArguments('bob', 'ins-bob', repository.id)).toThrow(
      'Repository reference not found',
    );
    expect(() => f.github.repositoryContext('alice', 'ins-alice', [repository.id])).toThrow(
      'Verify',
    );
    expect(() =>
      f.github.recordInspection('alice', 'ins-alice', repository.id, {
        ...inspection,
        path: '/secret',
      }),
    ).toThrow('immutable');
    expect(() =>
      f.github.recordInspection('alice', 'ins-alice', repository.id, {
        ...inspection,
        commit: 'not-a-hash',
      }),
    ).toThrow('immutable');
    f.github.recordInspection('alice', 'ins-alice', repository.id, inspection);
    expect(f.github.repositoryContext('alice', 'ins-alice', [repository.id])).toEqual([
      {
        referenceId: repository.id,
        path: inspection.path,
        expectedRemoteUrl: inspection.remote.url,
      },
    ]);
    expect(() =>
      f.github.repositoryContext('alice', 'ins-alice', [repository.id, repository.id]),
    ).toThrow('distinct');
    expect(f.github.references('alice', 'ins-alice').repositories[0]?.authorization).toBe('manual');
    f.github.markInspectionStale('alice', 'ins-alice', repository.id);
    expect(() => f.github.repositoryContext('alice', 'ins-alice', [repository.id])).toThrow(
      'Verify',
    );
    await expect(f.github.register(f.alice, 'ins-alice', mapping)).rejects.toThrow(
      'already exists',
    );
  });
  test('GitHub selection is checked live and token expiry/disconnect are visible', async () => {
    const f = fixture(transportFixture());
    await connect(f);
    await expect(
      f.github.register(f.alice, 'ins-alice', {
        source: 'github',
        installationId: 81,
        repositoryId: 999,
        localPath: '/allowed/repo',
      }),
    ).rejects.toThrow('authorized repository page');
    const { repository } = await f.github.register(f.alice, 'ins-alice', {
      source: 'github',
      installationId: 81,
      repositoryId: 101,
      localPath: '/allowed/repo',
    });
    expect(repository.authorization).toBe('github_authorized');
    expect(repository.localState).toBe('declared');
    f.db.query('UPDATE github_accounts SET token_expires_at=0').run();
    expect(f.github.references('alice', 'ins-alice').repositories[0]?.authorization).toBe(
      'github_expired',
    );
    f.github.disconnect(f.alice);
    expect(f.github.references('alice', 'ins-alice').repositories[0]?.authorization).toBe(
      'github_disconnected',
    );
  });
});

test('repository HTTP routes enforce controller, user, origin and explicit unconfigured status', async () => {
  const relay = createRelay({ databasePath: ':memory:', port: 0, registration: true, github: {} });
  const base = relay.server.url;
  try {
    const registered = await fetch(new URL('/api/auth/register', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'github-fixture@example.invalid',
        password: 'long-fixture-password',
      }),
    });
    const identity = (await registered.json()) as { token: string; controller: { id: string } };
    const headers = {
      Authorization: `Bearer ${identity.token}`,
      'Content-Type': 'application/json',
    };
    const instanceResponse = await fetch(new URL('/api/instances', base), {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Fixture' }),
    });
    const { instance } = (await instanceResponse.json()) as { instance: { id: string } };
    const path = new URL(`/api/instances/${instance.id}/repositories`, base);
    const wrong = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...mapping, controllerId: 'other' }),
    });
    expect(wrong.status).toBe(403);
    const create = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...mapping, controllerId: identity.controller.id }),
    });
    expect(create.status).toBe(201);
    const result = (await create.json()) as { repository: { localState: string } };
    expect(result.repository.localState).toBe('declared');
    const unavailable = await fetch(new URL('/api/github/authorize', base), {
      method: 'POST',
      headers: {
        cookie: `dsh_session=${identity.token}`,
        Origin: new URL(base).origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ controllerId: identity.controller.id }),
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('cache-control')).toBe('no-store');
    const noOrigin = await fetch(new URL('/api/github/cancel', base), {
      method: 'POST',
      headers: { cookie: `dsh_session=${identity.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ controllerId: identity.controller.id }),
    });
    expect(noOrigin.status).toBe(403);
  } finally {
    await relay.stop();
  }
});

test('native OAuth fails explicitly; same-browser flow remains bound after logout', async () => {
  const relay = createRelay({
    databasePath: ':memory:',
    port: 0,
    registration: true,
    github: fixtureOptions,
  });
  const base = relay.server.url;
  try {
    const registration = await fetch(new URL('/api/auth/register', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'native-fixture@example.invalid',
        password: 'long-fixture-password',
      }),
    });
    const identity = (await registration.json()) as { token: string; controller: { id: string } };
    const native = {
      Authorization: `Bearer ${identity.token}`,
      'Content-Type': 'application/json',
    };
    const status = await fetch(new URL('/api/github/status', base), { headers: native });
    expect(((await status.json()) as { nativeOAuthSupported: boolean }).nativeOAuthSupported).toBe(
      false,
    );
    const unsupported = await fetch(new URL('/api/github/authorize', base), {
      method: 'POST',
      headers: native,
      body: JSON.stringify({ controllerId: identity.controller.id }),
    });
    expect(unsupported.status).toBe(409);
    expect(((await unsupported.json()) as { error: { code: string } }).error.code).toBe(
      'GITHUB_BROWSER_REQUIRED',
    );
    const browser = {
      cookie: `dsh_session=${identity.token}`,
      Origin: new URL(base).origin,
      'Content-Type': 'application/json',
    };
    const start = await fetch(new URL('/api/github/authorize', base), {
      method: 'POST',
      headers: browser,
      body: JSON.stringify({ controllerId: identity.controller.id }),
    });
    expect(start.status).toBe(200);
    const { authorizationUrl } = (await start.json()) as { authorizationUrl: string };
    const state = new URL(authorizationUrl).searchParams.get('state');
    const callback = new URL(`/github/callback?state=${state}&code=fixture`, base);
    // A separate native/external browser has no flow cookie: no exchange can happen.
    const wrongBrowser = await fetch(callback, { redirect: 'manual' });
    expect(wrongBrowser.status).toBe(303);
    expect(wrongBrowser.headers.get('location')).toEndWith('github=GITHUB_INVALID_STATE');
    await fetch(new URL('/api/auth/logout', base), { method: 'POST', headers: browser });
    const revoked = await fetch(callback, {
      redirect: 'manual',
      headers: { cookie: start.headers.get('set-cookie')!.split(';')[0]! },
    });
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get('location')).toEndWith('github=UNAUTHENTICATED');
    expect(revoked.headers.get('referrer-policy')).toBe('no-referrer');
    expect(relay.db.query('SELECT * FROM github_accounts').all()).toHaveLength(0);
  } finally {
    await relay.stop();
  }
});

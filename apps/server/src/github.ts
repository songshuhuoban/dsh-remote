import type { Database } from 'bun:sqlite';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { initializeGitHubStore } from './github-store.ts';

type Row = Record<string, string | number | null>;
export type GitHubAuth = { userId: string; controllerId: string; tokenHash: string };
export type RepositoryContext = { referenceId: string; path: string; expectedRemoteUrl: string };
export interface GitHubOptions {
  clientId?: string;
  clientSecret?: string;
  appSlug?: string;
  callbackUrl?: string;
  tokenEncryptionKey?: string;
}
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (status: number, code: string, message: string): never => {
  throw new GitHubError(status, code, message);
};
function text(value: unknown, name: string, max = 255): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    return fail(
      400,
      'INVALID_REPOSITORY_INPUT',
      `${name} must be nonempty bounded text without controls`,
    );
  return value;
}
function integer(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    return fail(400, 'INVALID_REPOSITORY_INPUT', `${name} must be a positive integer`);
  return value;
}
export function canonicalGitHubUrl(value: unknown): { url: string; fullName: string } {
  const raw = text(value, 'url', 600);
  const match = raw.match(
    /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/,
  );
  if (!match)
    return fail(
      400,
      'INVALID_REPOSITORY_URL',
      'Use an HTTPS github.com owner/repository URL without credentials, query or fragment',
    );
  const name = match[2]!.replace(/\.git$/, '');
  if (!name || name === '.' || name === '..')
    return fail(400, 'INVALID_REPOSITORY_URL', 'Invalid repository name');
  const fullName = `${match[1]}/${name}`;
  return { url: `https://github.com/${fullName}`, fullName };
}
export function repositoryBranch(value: unknown): string {
  const branch = text(value, 'defaultBranch');
  if (
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    /[\s~^:?*\[\\]/.test(branch) ||
    branch === '@' ||
    branch.split('/').some((p) => !p || p.startsWith('.') || p.endsWith('.lock'))
  )
    return fail(400, 'INVALID_REPOSITORY_BRANCH', 'Invalid repository branch');
  return branch;
}
export function repositoryPath(value: unknown): string {
  const path = text(value, 'localPath', 4096);
  if (
    !path.startsWith('/') ||
    path === '/' ||
    path.includes('\\') ||
    path
      .split('/')
      .slice(1)
      .some((p) => !p || p === '.' || p === '..')
  )
    return fail(
      400,
      'INVALID_REPOSITORY_PATH',
      'Use a canonical absolute host path without traversal or trailing slash',
    );
  return path;
}
export function gitHubOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): GitHubOptions {
  return {
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    appSlug: env.GITHUB_APP_SLUG,
    callbackUrl: env.GITHUB_CALLBACK_URL,
    tokenEncryptionKey: env.GITHUB_TOKEN_ENCRYPTION_KEY,
  };
}

/** Network transport injection is for deterministic protocol tests, never a production mock mode. */
export function createGitHubService(
  db: Database,
  options: GitHubOptions = gitHubOptionsFromEnv(),
  transport: typeof fetch = fetch,
) {
  initializeGitHubStore(db);
  const get = (sql: string, ...args: (string | number | null)[]) =>
    db.query(sql).get(...args) as Row | null;
  const all = (sql: string, ...args: (string | number | null)[]) =>
    db.query(sql).all(...args) as Row[];
  const run = (sql: string, ...args: (string | number | null)[]) => db.query(sql).run(...args);
  const missing = Object.entries({
    GITHUB_APP_CLIENT_ID: options.clientId,
    GITHUB_APP_CLIENT_SECRET: options.clientSecret,
    GITHUB_APP_SLUG: options.appSlug,
    GITHUB_CALLBACK_URL: options.callbackUrl,
    GITHUB_TOKEN_ENCRYPTION_KEY: options.tokenEncryptionKey,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  let key: Buffer | undefined;
  let callback: URL | undefined;
  let configError: string | undefined;
  if (!missing.length) {
    try {
      key = Buffer.from(options.tokenEncryptionKey!, 'base64');
      callback = new URL(options.callbackUrl!);
      if (
        key.length !== 32 ||
        key.toString('base64') !== options.tokenEncryptionKey ||
        !/^[A-Za-z0-9_-]+$/.test(options.clientId!) ||
        !/^[a-z0-9-]+$/.test(options.appSlug!) ||
        callback.pathname !== '/github/callback' ||
        callback.search ||
        callback.hash ||
        callback.username ||
        callback.password ||
        (callback.protocol !== 'https:' &&
          !(
            callback.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)
          ))
      )
        configError =
          'GitHub configuration needs a canonical 32-byte base64 encryption key and a secure /github/callback URL';
    } catch {
      configError = 'GitHub configuration is invalid';
    }
  }
  const configured = () => {
    if (missing.length || configError)
      fail(
        503,
        'GITHUB_NOT_CONFIGURED',
        configError ?? `Configure ${missing.join(', ')} before connecting GitHub`,
      );
  };
  function seal(value: string, owner: string): string {
    configured();
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key!, iv);
    cipher.setAAD(Buffer.from(owner));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  }
  function unseal(value: string, owner: string): string {
    configured();
    try {
      const [version, iv, tag, data] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !data) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', key!, Buffer.from(iv, 'base64url'));
      cipher.setAAD(Buffer.from(owner));
      cipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        cipher.update(Buffer.from(data, 'base64url')),
        cipher.final(),
      ]).toString('utf8');
    } catch {
      return fail(
        401,
        'GITHUB_REAUTHORIZE',
        'Stored GitHub authorization cannot be opened; reconnect GitHub',
      );
    }
  }
  function assertSession(auth: GitHubAuth) {
    if (
      !get(
        'SELECT 1 FROM auth_sessions WHERE token_hash=? AND user_id=? AND controller_id=? AND expires_at>?',
        auth.tokenHash,
        auth.userId,
        auth.controllerId,
        Date.now(),
      )
    )
      fail(401, 'UNAUTHENTICATED', 'Relay session expired; sign in again');
  }
  function ownedInstance(userId: string, instanceId: string) {
    if (!get('SELECT 1 FROM instances WHERE id=? AND user_id=?', instanceId, userId))
      fail(404, 'NOT_FOUND', 'Instance not found');
  }
  function account(userId: string): Row {
    configured();
    const row = get('SELECT * FROM github_accounts WHERE user_id=?', userId);
    if (!row || Number(row.token_expires_at) <= Date.now())
      fail(401, 'GITHUB_REAUTHORIZE', 'Connect GitHub again to access repositories');
    return row!;
  }
  async function request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await transport(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      return fail(502, 'GITHUB_UNAVAILABLE', 'GitHub did not respond; try again');
    }
    if (!response.ok) {
      // Never include provider bodies, tokens, request parameters or headers in errors/logs.
      if (response.status === 401)
        return fail(
          401,
          'GITHUB_REAUTHORIZE',
          'GitHub authorization was revoked or expired; reconnect',
        );
      if (response.status === 403 || response.status === 429)
        return fail(
          403,
          'GITHUB_ACCESS_DENIED',
          'GitHub denied access or its request limit was reached',
        );
      if (response.status === 404)
        return fail(404, 'GITHUB_NOT_FOUND', 'GitHub installation or repository is not accessible');
      return fail(502, 'GITHUB_UNAVAILABLE', 'GitHub request failed');
    }
    const raw = await response.text();
    if (raw.length > 4 * 1024 * 1024)
      return fail(502, 'GITHUB_INVALID_RESPONSE', 'GitHub response was too large');
    try {
      const result: unknown = JSON.parse(raw);
      if (isObject(result)) return result;
    } catch {
      /* redact provider response */
    }
    return fail(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned an invalid response');
  }
  async function api(userId: string, path: string) {
    const row = account(userId);
    try {
      const result = await request(`https://api.github.com${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${unseal(String(row.token_ciphertext), `account:${userId}`)}`,
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'DSH-Remote',
        },
      });
      // Disconnect/account switches during an in-flight request cannot restore the old grant.
      if (
        get('SELECT token_ciphertext FROM github_accounts WHERE user_id=?', userId)
          ?.token_ciphertext !== row.token_ciphertext
      )
        fail(409, 'GITHUB_AUTH_CHANGED', 'GitHub authorization changed; retry');
      return result;
    } catch (error) {
      if (error instanceof GitHubError && error.code === 'GITHUB_REAUTHORIZE')
        run(
          'DELETE FROM github_accounts WHERE user_id=? AND token_ciphertext=?',
          userId,
          String(row.token_ciphertext),
        );
      throw error;
    }
  }
  function status(userId: string) {
    const row = get('SELECT * FROM github_accounts WHERE user_id=?', userId);
    return {
      configured: !missing.length && !configError,
      missingConfiguration: missing,
      configurationError: configError ?? null,
      state: !row
        ? 'disconnected'
        : Number(row.token_expires_at) > Date.now()
          ? 'connected'
          : 'expired',
      account: row
        ? {
            id: Number(row.github_id),
            login: String(row.login),
            connectedAt: Number(row.connected_at),
            expiresAt: Number(row.token_expires_at),
          }
        : null,
      permissions: { contents: 'read', metadata: 'read' },
      cloningSupported: false,
      nativeOAuthSupported: false,
      browserOAuthSupported: !missing.length && !configError,
    };
  }
  function authorize(auth: GitHubAuth) {
    configured();
    assertSession(auth);
    const state = random(),
      browser = random(),
      verifier = random(),
      expiresAt = Date.now() + 10 * 60_000;
    // The grant is user-global, so only the newest flow across all logins may win.
    // Otherwise a delayed callback from another controller can replace a newer account.
    run('DELETE FROM github_auth_states WHERE user_id=? OR expires_at<=?', auth.userId, Date.now());
    run(
      'INSERT INTO github_auth_states(state_hash,browser_hash,user_id,controller_id,session_hash,verifier_ciphertext,expires_at) VALUES(?,?,?,?,?,?,?)',
      hash(state),
      hash(browser),
      auth.userId,
      auth.controllerId,
      auth.tokenHash,
      seal(verifier, `state:${hash(state)}`),
      expiresAt,
    );
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: options.clientId!,
      redirect_uri: callback!.href,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return {
      authorizationUrl: url.href,
      expiresAt,
      cookie: `dsh_github_flow=${browser}; HttpOnly; Path=/github/callback; SameSite=Lax; Max-Age=600${callback!.protocol === 'https:' ? '; Secure' : ''}`,
    };
  }
  async function finishAuthorization(req: Request) {
    configured();
    const url = new URL(req.url),
      state = text(url.searchParams.get('state'), 'state', 100);
    const browser =
      req.headers
        .get('cookie')
        ?.split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith('dsh_github_flow='))
        ?.slice('dsh_github_flow='.length) ?? '';
    const row = get('SELECT * FROM github_auth_states WHERE state_hash=?', hash(state));
    if (
      !row ||
      row.consumed !== 0 ||
      !timingSafeEqual(Buffer.from(String(row.browser_hash)), Buffer.from(hash(browser))) ||
      Number(row.expires_at) <= Date.now()
    )
      return fail(
        400,
        'GITHUB_INVALID_STATE',
        'GitHub authorization expired or belongs to another browser; start again',
      );
    const auth = {
      userId: String(row.user_id),
      controllerId: String(row.controller_id),
      tokenHash: String(row.session_hash),
    };
    assertSession(auth);
    // Consume before exchange: simultaneous callbacks and failed exchanges cannot replay.
    if (
      run('UPDATE github_auth_states SET consumed=1 WHERE state_hash=? AND consumed=0', hash(state))
        .changes !== 1
    )
      return fail(400, 'GITHUB_INVALID_STATE', 'GitHub authorization was already consumed');
    if (url.searchParams.has('error')) {
      run('DELETE FROM github_auth_states WHERE state_hash=?', hash(state));
      return { outcome: 'cancelled' };
    }
    const code = text(url.searchParams.get('code'), 'code', 1000);
    const token = await request('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: options.clientId!,
        client_secret: options.clientSecret!,
        code,
        redirect_uri: callback!.href,
        code_verifier: unseal(String(row.verifier_ciphertext), `state:${hash(state)}`),
      }).toString(),
    });
    if (
      token.error ||
      typeof token.access_token !== 'string' ||
      !/^ghu_[A-Za-z0-9_]+$/.test(token.access_token) ||
      typeof token.expires_in !== 'number' ||
      token.expires_in < 1 ||
      token.expires_in > 28800
    )
      return fail(
        502,
        'GITHUB_TOKEN_REJECTED',
        'GitHub must issue an expiring user token; restart authorization',
      );
    const user = await request('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token.access_token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'DSH-Remote',
      },
    });
    const githubId = integer(user.id, 'GitHub account ID'),
      login = text(user.login, 'GitHub login', 100);
    assertSession(auth);
    // A newer authorization started while exchange was pending wins; this callback cannot overwrite it.
    if (
      !get(
        'SELECT 1 FROM github_auth_states WHERE state_hash=? AND session_hash=? AND consumed=1',
        hash(state),
        auth.tokenHash,
      )
    )
      fail(409, 'GITHUB_AUTH_CHANGED', 'GitHub connection was cancelled or replaced; start again');
    run(
      'INSERT INTO github_accounts(user_id,github_id,login,token_ciphertext,token_expires_at,controller_id,connected_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET github_id=excluded.github_id,login=excluded.login,token_ciphertext=excluded.token_ciphertext,token_expires_at=excluded.token_expires_at,controller_id=excluded.controller_id,connected_at=excluded.connected_at',
      auth.userId,
      githubId,
      login,
      seal(token.access_token, `account:${auth.userId}`),
      Date.now() + token.expires_in * 1000,
      auth.controllerId,
      Date.now(),
    );
    run('DELETE FROM github_auth_states WHERE state_hash=?', hash(state));
    // Refresh tokens are intentionally discarded; users reconnect after eight hours.
    return { outcome: 'connected' };
  }
  function cancelAuthorization(auth: GitHubAuth) {
    assertSession(auth);
    run('DELETE FROM github_auth_states WHERE session_hash=?', auth.tokenHash);
    return { ok: true };
  }
  function disconnect(auth: GitHubAuth) {
    assertSession(auth);
    db.transaction(() => {
      run('DELETE FROM github_accounts WHERE user_id=?', auth.userId);
      run('DELETE FROM github_auth_states WHERE user_id=?', auth.userId);
    })();
    return {
      ok: true,
      revokedOnGitHub: false,
      manageUrl: 'https://github.com/settings/apps/authorizations',
    };
  }
  function installationView(value: unknown) {
    if (!isObject(value) || !isObject(value.account) || !isObject(value.permissions))
      return fail(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned an invalid installation');
    if (
      value.app_slug !== options.appSlug ||
      value.suspended_at ||
      Object.entries(value.permissions).some(
        ([k, v]) => !['metadata', 'contents'].includes(k) || v !== 'read',
      ) ||
      value.permissions.contents !== 'read'
    )
      return fail(
        403,
        'GITHUB_PERMISSION_MISMATCH',
        'Installation must be active and grant only Contents read and Metadata read',
      );
    return {
      id: integer(value.id, 'installation ID'),
      account: {
        id: integer(value.account.id, 'account ID'),
        login: text(value.account.login, 'account login', 100),
      },
      repositorySelection: value.repository_selection === 'selected' ? 'selected' : 'all',
      permissions: { contents: 'read', metadata: 'read' },
    };
  }
  async function installations(userId: string, page = 1) {
    integer(page, 'page', 10000);
    const result = await api(userId, `/user/installations?per_page=100&page=${page}`);
    if (!Array.isArray(result.installations))
      return fail(502, 'GITHUB_INVALID_RESPONSE', 'GitHub did not return installations');
    return {
      installations: result.installations.map(installationView),
      page,
      hasMore: page * 100 < Number(result.total_count),
    };
  }
  async function requireInstallation(userId: string, installationId: number, installationPage = 1) {
    const result = await installations(userId, installationPage);
    if (!result.installations.some((v) => v.id === installationId))
      fail(
        403,
        'GITHUB_INSTALLATION_DENIED',
        'Installation is not in the accessible installation page',
      );
  }
  function repositoryView(raw: unknown, installationId: number) {
    if (!isObject(raw))
      return fail(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned an invalid repository');
    const canonical = canonicalGitHubUrl(raw.html_url);
    if (raw.full_name !== canonical.fullName)
      return fail(502, 'GITHUB_INVALID_RESPONSE', 'Repository identity is inconsistent');
    return {
      id: integer(raw.id, 'repository ID'),
      installationId,
      ...canonical,
      defaultBranch: repositoryBranch(raw.default_branch),
      private: raw.private === true,
      archived: raw.archived === true,
    };
  }
  async function repositories(
    userId: string,
    installationId: number,
    page = 1,
    installationPage = 1,
  ) {
    integer(installationId, 'installationId');
    integer(page, 'page', 10000);
    await requireInstallation(userId, installationId, installationPage);
    const result = await api(
      userId,
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
    );
    if (!Array.isArray(result.repositories))
      return fail(502, 'GITHUB_INVALID_RESPONSE', 'GitHub did not return repositories');
    return {
      repositories: result.repositories.map((v) => repositoryView(v, installationId)),
      page,
      installationPage,
      hasMore: page * 100 < Number(result.total_count),
    };
  }
  function reference(userId: string, instanceId: string, id: unknown): Row {
    ownedInstance(userId, instanceId);
    const row = get(
      'SELECT * FROM github_repository_refs WHERE id=? AND user_id=? AND instance_id=?',
      text(id, 'referenceId', 100),
      userId,
      instanceId,
    );
    if (!row) return fail(404, 'NOT_FOUND', 'Repository reference not found');
    return row;
  }
  function referenceView(row: Row) {
    const grant = get(
      'SELECT github_id,token_expires_at FROM github_accounts WHERE user_id=?',
      String(row.user_id),
    );
    const authorization =
      row.source === 'manual'
        ? 'manual'
        : !grant || grant.github_id !== row.github_account_id
          ? 'github_disconnected'
          : Number(grant.token_expires_at) <= Date.now()
            ? 'github_expired'
            : 'github_authorized';
    return {
      id: String(row.id),
      instanceId: String(row.instance_id),
      source: String(row.source),
      url: String(row.url),
      fullName: String(row.full_name),
      defaultBranch: String(row.default_branch),
      localPath: String(row.local_path),
      githubId: row.github_id,
      installationId: row.installation_id,
      authorization,
      authorizationCheckedAt: row.authorized_at,
      selected: row.selected === 1,
      localState: String(row.local_state),
      verifiedAt: row.verified_at,
      head: row.head,
      branch: row.branch,
      cloned: false,
      createdAt: Number(row.created_at),
    };
  }
  function references(userId: string, instanceId: string) {
    ownedInstance(userId, instanceId);
    return {
      repositories: all(
        'SELECT * FROM github_repository_refs WHERE user_id=? AND instance_id=? ORDER BY created_at,id',
        userId,
        instanceId,
      ).map(referenceView),
    };
  }
  async function register(auth: GitHubAuth, instanceId: string, input: Record<string, unknown>) {
    assertSession(auth);
    ownedInstance(auth.userId, instanceId);
    const localPath = repositoryPath(input.localPath);
    let url: string,
      fullName: string,
      defaultBranch: string,
      githubId: number | null = null,
      installationId: number | null = null,
      accountId: number | null = null;
    if (input.source === 'manual') {
      ({ url, fullName } = canonicalGitHubUrl(input.url));
      defaultBranch = repositoryBranch(input.defaultBranch);
    } else if (input.source === 'github') {
      installationId = integer(input.installationId, 'installationId');
      githubId = integer(input.repositoryId, 'repositoryId');
      const result = await repositories(
        auth.userId,
        installationId,
        input.page === undefined ? 1 : integer(input.page, 'page', 10000),
        input.installationPage === undefined
          ? 1
          : integer(input.installationPage, 'installationPage', 10000),
      );
      const repo = result.repositories.find((v) => v.id === githubId);
      if (!repo)
        return fail(
          403,
          'GITHUB_REPOSITORY_DENIED',
          'Repository is not in the authorized repository page',
        );
      ({ url, fullName, defaultBranch } = repo);
      accountId = Number(account(auth.userId).github_id);
    } else return fail(400, 'INVALID_REPOSITORY_INPUT', 'source must be manual or github');
    assertSession(auth);
    ownedInstance(auth.userId, instanceId);
    if (
      Number(
        get(
          'SELECT COUNT(*) AS count FROM github_repository_refs WHERE user_id=? AND instance_id=?',
          auth.userId,
          instanceId,
        )?.count,
      ) >= 100
    )
      fail(409, 'REPOSITORY_QUOTA', 'Each instance supports up to 100 references');
    if (
      get(
        'SELECT 1 FROM github_repository_refs WHERE instance_id=? AND url=? AND local_path=?',
        instanceId,
        url,
        localPath,
      )
    )
      fail(409, 'REPOSITORY_EXISTS', 'This repository mapping already exists');
    const id = `repo_${crypto.randomUUID()}`;
    run(
      'INSERT INTO github_repository_refs(id,user_id,instance_id,controller_id,source,url,full_name,default_branch,local_path,github_id,installation_id,github_account_id,authorized_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      auth.userId,
      instanceId,
      auth.controllerId,
      String(input.source),
      url,
      fullName,
      defaultBranch,
      localPath,
      githubId,
      installationId,
      accountId,
      input.source === 'github' ? Date.now() : null,
      Date.now(),
    );
    return { repository: referenceView(reference(auth.userId, instanceId, id)) };
  }
  function select(auth: GitHubAuth, instanceId: string, id: string, selected: unknown) {
    assertSession(auth);
    reference(auth.userId, instanceId, id);
    if (typeof selected !== 'boolean')
      fail(400, 'INVALID_REPOSITORY_INPUT', 'selected must be a boolean');
    run(
      'UPDATE github_repository_refs SET selected=?,controller_id=? WHERE id=? AND user_id=? AND instance_id=?',
      selected ? 1 : 0,
      auth.controllerId,
      id,
      auth.userId,
      instanceId,
    );
    return { repository: referenceView(reference(auth.userId, instanceId, id)) };
  }
  function repositoryContext(
    userId: string,
    instanceId: string,
    ids: unknown,
  ): RepositoryContext[] {
    if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length)
      return fail(
        400,
        'INVALID_REPOSITORY_INPUT',
        'Choose up to eight distinct repository reference IDs',
      );
    return ids.map((id) => {
      const row = reference(userId, instanceId, id);
      if (row.local_state !== 'verified')
        fail(
          409,
          'REPOSITORY_NOT_VERIFIED',
          'Verify the repository on its DSH host before adding message context',
        );
      return {
        referenceId: String(row.id),
        path: String(row.local_path),
        expectedRemoteUrl: String(row.url),
      };
    });
  }
  function inspectArguments(userId: string, instanceId: string, id: unknown) {
    const row = reference(userId, instanceId, id);
    return { path: String(row.local_path), expectedRemoteUrl: String(row.url) };
  }
  function recordInspection(userId: string, instanceId: string, id: unknown, result: unknown) {
    const row = reference(userId, instanceId, id);
    if (
      !isObject(result) ||
      !isObject(result.remote) ||
      result.path !== row.local_path ||
      result.name !== row.full_name ||
      result.remote.url !== row.url ||
      `${result.remote.owner}/${result.remote.name}` !== row.full_name ||
      (result.commit !== null &&
        (typeof result.commit !== 'string' ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.commit))) ||
      (result.branch !== null && typeof result.branch !== 'string')
    )
      return fail(
        409,
        'REPOSITORY_VERIFICATION_MISMATCH',
        'Host inspection did not match the immutable repository reference',
      );
    if (result.branch !== null) repositoryBranch(result.branch);
    run(
      "UPDATE github_repository_refs SET local_state='verified',verified_at=?,head=?,branch=? WHERE id=? AND user_id=? AND instance_id=?",
      Date.now(),
      result.commit as string | null,
      result.branch as string | null,
      String(row.id),
      userId,
      instanceId,
    );
  }
  function markInspectionStale(userId: string, instanceId: string, id: unknown) {
    const row = reference(userId, instanceId, id);
    run(
      "UPDATE github_repository_refs SET local_state='stale' WHERE id=? AND user_id=? AND instance_id=?",
      String(row.id),
      userId,
      instanceId,
    );
  }
  function install(auth: GitHubAuth) {
    configured();
    assertSession(auth);
    account(auth.userId);
    return {
      installationUrl: `https://github.com/apps/${options.appSlug}/installations/new`,
      returnUrl: `${callback!.origin}/?github=installation`,
      permissions: { contents: 'read', metadata: 'read' },
    };
  }
  return {
    status,
    authorize,
    finishAuthorization,
    cancelAuthorization,
    disconnect,
    installations,
    repositories,
    references,
    register,
    select,
    repositoryContext,
    inspectArguments,
    recordInspection,
    markInspectionStale,
    install,
    callbackOrigin: callback?.origin,
  };
}
export type GitHubService = ReturnType<typeof createGitHubService>;

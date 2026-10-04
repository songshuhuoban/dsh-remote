import { GitHubError, type GitHubAuth, type GitHubService } from './github.ts';

const response = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers },
  });
const page = (url: URL, name = 'page') => {
  const value = url.searchParams.get(name) ?? '1';
  if (!/^[1-9][0-9]{0,6}$/.test(value))
    throw new GitHubError(400, 'INVALID_REPOSITORY_INPUT', `${name} must be a positive integer`);
  return Number(value);
};
export async function githubCallback(
  req: Request,
  github: GitHubService,
): Promise<Response | null> {
  if (new URL(req.url).pathname !== '/github/callback') return null;
  if (req.method !== 'GET')
    return response({ error: { code: 'METHOD_NOT_ALLOWED', message: 'GET required' } }, 405);
  let outcome: string;
  try {
    outcome = (await github.finishAuthorization(req)).outcome;
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    // The callback never echoes codes, tokens, state, or provider error text.
    if (!github.callbackOrigin)
      return response({ error: { code: error.code, message: error.message } }, error.status);
    outcome = error.code;
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${github.callbackOrigin}/?github=${encodeURIComponent(outcome)}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      // Do not clear the shared browser cookie here: a delayed callback response
      // can arrive after a newer flow has replaced it, invalidating that flow.
      // It expires after ten minutes; consumed/removed server state prevents replay.
    },
  });
}
export async function githubRoutes(
  req: Request,
  auth: GitHubAuth,
  github: GitHubService,
  body: (req: Request) => Promise<Record<string, unknown>>,
): Promise<Response | null> {
  const url = new URL(req.url),
    path = url.pathname;
  if (
    !path.startsWith('/api/github/') &&
    !/^\/api\/instances\/[^/]+\/repositories(?:\/[^/]+\/select)?$/.test(path)
  )
    return null;
  const write = async () => {
    const input = await body(req);
    if (input.controllerId !== auth.controllerId)
      throw new GitHubError(
        403,
        'CONTROLLER_MISMATCH',
        'This login is bound to a different controller',
      );
    // Existing relay auth supports native bearer clients and same-origin HttpOnly cookies.
    // Cookie mutations additionally require an Origin, preventing ambient-cookie form CSRF.
    if (!req.headers.get('authorization')?.startsWith('Bearer ') && !req.headers.has('origin'))
      throw new GitHubError(
        403,
        'ORIGIN_REQUIRED',
        'Browser repository changes require an Origin header',
      );
    return input;
  };
  try {
    if (path === '/api/github/status' && req.method === 'GET')
      return response(github.status(auth.userId));
    if (path === '/api/github/authorize' && req.method === 'POST') {
      await write();
      if (req.headers.has('authorization'))
        throw new GitHubError(
          409,
          'GITHUB_BROWSER_REQUIRED',
          'Connect GitHub from the signed-in web app in the same browser; native OAuth is not supported yet',
        );
      const { cookie, ...data } = github.authorize(auth);
      return response(data, 200, { 'Set-Cookie': cookie });
    }
    if (path === '/api/github/cancel' && req.method === 'POST') {
      await write();
      return response(github.cancelAuthorization(auth));
    }
    if (path === '/api/github/disconnect' && req.method === 'POST') {
      await write();
      return response(github.disconnect(auth));
    }
    if (path === '/api/github/install' && req.method === 'POST') {
      await write();
      return response(github.install(auth));
    }
    if (path === '/api/github/installations' && req.method === 'GET')
      return response(await github.installations(auth.userId, page(url)));
    if (path === '/api/github/repositories' && req.method === 'GET') {
      const installationId = Number(url.searchParams.get('installationId'));
      return response(
        await github.repositories(
          auth.userId,
          installationId,
          page(url),
          page(url, 'installationPage'),
        ),
      );
    }
    const references = path.match(/^\/api\/instances\/([^/]+)\/repositories$/);
    if (references && req.method === 'GET')
      return response(github.references(auth.userId, references[1]!));
    if (references && req.method === 'POST')
      return response(await github.register(auth, references[1]!, await write()), 201);
    const select = path.match(/^\/api\/instances\/([^/]+)\/repositories\/([^/]+)\/select$/);
    if (select && req.method === 'POST')
      return response(github.select(auth, select[1]!, select[2]!, (await write()).selected));
    return response(
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'Unsupported repository route or method' } },
      405,
    );
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    return response({ error: { code: error.code, message: error.message } }, error.status);
  }
}

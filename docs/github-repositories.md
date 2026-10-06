# GitHub access and local repository context

## Scope and verified status

This feature connects a **deployment-configured GitHub App** to an existing DSH Remote account, discovers repositories, and stores immutable references to existing checkouts on one owned DSH instance. Local mapping works with no GitHub credentials. GitHub authorization, local mapping, and host verification are separate states. Nothing in the relay clones, fetches, checks out, executes shell commands, or forwards GitHub credentials to DSH.

Deterministic GitHub protocol fixtures exercise the OAuth exchange, state, PKCE, expiry, permissions, and denial cases. They are **not a live GitHub OAuth E2E**. Deployment credentials, actual consent, organization approval, and a real GitHub callback still require operator/user setup and a live acceptance run. This implementation does not create a GitHub App, grant external access, or publish this project's source repository.

## Sign in with GitHub

The same GitHub App also signs people in. `POST /api/auth/github` starts a browser-bound flow with
the same state, PKCE, cookie and one-time rules as repository authorization below, and the shared
`/github/callback` tells the two apart by state. The relay keys accounts by the immutable GitHub
user ID in `github_identities`, never by email: a linked GitHub user signs in to that account, and
an unlinked one gets a new, password-less account only when registration allows it (in invite mode,
the invite code must accompany the start request). Connecting GitHub for repositories from a
password account links that GitHub user too, so either sign-in method reaches the same account. A
link is created only when neither side is linked yet and is never re-pointed; disconnecting
repository access leaves it in place. Sign-in stores the repository grant as well, so a fresh
GitHub sign-in can list repositories immediately. Native clients cannot start it, for the same
cookie-binding reason as below.

## Why a GitHub App

A GitHub App lets its installer choose repositories and use targeted read permissions. The selected deployment must request only **Contents: read** and **Metadata: read**. Traditional OAuth `repo` scope is broader than this product needs. The server uses a short-lived **GitHub App user access token**, so discovery is bounded by the intersection of the app's installation grant and the signed-in GitHub user's access. No app private key or installation token is needed for this read-only discovery flow.

References: [GitHub App versus OAuth permissions](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps), [choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

## Operator configuration

Supply these variables through the deployment secret/configuration system, never a client bundle, source file, committed dotenv file, or logs:

| Variable                      | Value                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `GITHUB_APP_CLIENT_ID`        | Client ID of the registered GitHub App                                               |
| `GITHUB_APP_CLIENT_SECRET`    | Operator-managed client secret                                                       |
| `GITHUB_APP_SLUG`             | App slug used in its GitHub installation URL                                         |
| `GITHUB_CALLBACK_URL`         | Exact public `https://your-relay.example/github/callback` URL registered with GitHub |
| `GITHUB_TOKEN_ENCRYPTION_KEY` | Canonical base64 encoding of a cryptographically random 32-byte key                  |

The callback must be HTTPS, except explicit loopback HTTP development URLs. It must have exactly `/github/callback` as its path and no query, fragment or credentials. The web app and relay must share the callback origin for the flow cookie. Terminate TLS correctly and configure the relay's existing origin allowlist and secure cookie settings. A partial or invalid configuration disables GitHub authorization with `GITHUB_NOT_CONFIGURED`; it never selects a fake production adapter. Configure Contents read and Metadata read only, opt into expiring user tokens, and let the user select specific repositories on GitHub. Do not enable automatic OAuth-during-installation as a substitute for the explicit state-bound authorization flow. A setup URL may point to the web UI home; the UI must refresh installations afterward and must not treat returned `installation_id` as proof of access.

The server deliberately rejects installations with additional/write permissions or suspended status. An overprivileged deployment must be corrected by its operator rather than silently accepted.

## Browser login and token lifetime

1. Sign in to DSH Remote in the web browser.
2. POST `/api/github/authorize` with the authenticated controller ID. The relay sets an HttpOnly, path-scoped, SameSite=Lax OAuth nonce cookie and returns an authorization URL.
3. Navigate to that URL in the **same browser**. State and PKCE verifier are generated by the server. State is one-use, expires after ten minutes, and is bound to the existing user, controller, relay session, and browser nonce.
4. GitHub redirects to the callback. The relay exchanges the code using PKCE, reads `/user`, rechecks the relay session and active flow, encrypts the token, and redirects to `/?github=connected`. Denials return `cancelled`; other failures return a bounded application error code.
5. List accessible installations and repositories, select one or more, and map their existing host paths.

The ordinary relay cookie remains SameSite=Strict. The separate callback cookie handles the cross-site top-level return without loosening the relay session cookie. Callback responses are no-store and no-referrer and redirect away from the authorization code. The cookie expires naturally after ten minutes; callback responses do not clear it, because a delayed response could otherwise erase a newer flow's cookie. There is one connected GitHub account per relay user: starting authorization invalidates that user's older flows across every controller/login, so the newest start wins. Cancellation remains scoped to its originating relay login; disconnection invalidates all of the user's flows. Cancellation/disconnection/logout while a callback is in flight cannot restore authorization. Concurrent callbacks cannot replay a consumed state.

Access tokens are AES-256-GCM encrypted with per-value random nonces and user-bound authenticated data. PKCE verifiers are also encrypted. Tokens and verifier plaintext are never returned to clients or written to ordinary logs. Requests go only to fixed GitHub authorization/API hosts, prohibit redirects, and have bounded timeouts. Provider error text is not echoed. Access tokens must expire within eight hours. Refresh tokens are discarded; reconnect when the access token expires. Changing the encryption key requires reconnecting accounts. Disconnect removes the locally stored grant and pending flows, but does **not** revoke the GitHub App's authorization or uninstall it; the response provides GitHub's authorization settings URL.

Reference: [GitHub user token web flow, PKCE and expiry](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

### Native mobile limitation

`GET /api/github/status` explicitly returns `nativeOAuthSupported: false`. Native bearer calls to authorize return `409 GITHUB_BROWSER_REQUIRED`. A Dart/native HTTP client's cookie jar is not shared with the external browser, so opening its returned OAuth URL would lose the nonce binding. No such broken flow is advertised. Connect GitHub using the signed-in web app in one browser, then the native app can use the same relay account for repository discovery and selection. Secure native OAuth would need a separately designed browser-start/deferred-completion protocol; weakening the state or browser binding is not an acceptable workaround.

## API contract

All API routes require an existing relay login. All POST bodies include `controllerId`, exactly matching that login. Instance routes enforce ownership. Cookie-authenticated mutations require an allowed Origin; native bearer requests are supported for mapping/list/select/install-link/disconnect, but not browser OAuth initiation.

- `GET /api/github/status`: `{configured, missingConfiguration, configurationError, state, account, permissions, cloningSupported:false, nativeOAuthSupported:false, browserOAuthSupported}`. State is `disconnected|connected|expired`; account is `null` or `{id,login,connectedAt,expiresAt}`
- `POST /api/github/authorize`: `{controllerId}` -> `{authorizationUrl,expiresAt}` plus the HttpOnly flow cookie
- `POST /api/github/cancel`: `{controllerId}` -> `{ok:true}`; invalidates this relay login's unfinished flow
- `POST /api/github/install`: `{controllerId}` -> `{installationUrl,returnUrl,permissions}`. The user chooses/approves repositories on GitHub. This does not grant permissions through the API
- `POST /api/github/disconnect`: `{controllerId}` -> `{ok:true,revokedOnGitHub:false,manageUrl}`
- `GET /api/github/installations?page=1`: `{installations:[{id,account:{id,login},repositorySelection,permissions}],page,hasMore}`
- `GET /api/github/repositories?installationId=81&page=1&installationPage=1`: `{repositories:[{id,installationId,url,fullName,defaultBranch,private,archived}],page,installationPage,hasMore}`

Pagination is 100 items/page. Installation and repository pages are explicit; selection re-fetches the specified pages live and fails if an ID moved or is no longer accessible. Refresh the page and retry when that happens. No arbitrary GitHub URL supplied by a client is fetched. Repository listing uses the user-token installation endpoints and rechecks that the configured app has read-only permissions.

Reference: [installation and repository discovery endpoints](https://docs.github.com/en/rest/apps/installations).

### Local references

`POST /api/instances/:instanceId/repositories` accepts either:

```json
{
  "controllerId": "ctl_…",
  "source": "manual",
  "url": "https://github.com/owner/repo",
  "defaultBranch": "main",
  "localPath": "/allowed/existing/repo"
}
```

or, after GitHub connection:

```json
{
  "controllerId": "ctl_…",
  "source": "github",
  "installationId": 81,
  "repositoryId": 101,
  "page": 1,
  "installationPage": 1,
  "localPath": "/allowed/existing/repo"
}
```

The second form derives URL/name/default branch from GitHub rather than trusting browser metadata. Both return `201 {repository:…}`. Paths must be canonical absolute POSIX paths with no traversal, redundant slash, backslash, control characters, or trailing slash. This relay syntax check is **not host filesystem verification**. The DSH plugin must resolve the path under its configured allowlisted roots, verify a Git checkout, compare its actual remote, and inspect actual branch/HEAD. GitHub default branch is descriptive; nothing checks it out.

`GET /api/instances/:instanceId/repositories` returns `{repositories:[…]}`. Each reference has:

```json
{
  "id": "repo_…",
  "instanceId": "ins_…",
  "source": "manual",
  "url": "https://github.com/owner/repo",
  "fullName": "owner/repo",
  "defaultBranch": "main",
  "localPath": "/allowed/existing/repo",
  "githubId": null,
  "installationId": null,
  "authorization": "manual",
  "authorizationCheckedAt": null,
  "selected": true,
  "localState": "declared",
  "verifiedAt": null,
  "head": null,
  "branch": null,
  "cloned": false,
  "createdAt": 0
}
```

`authorization` is `manual|github_authorized|github_expired|github_disconnected`. `github_authorized` means the most recent selection check, timestamped by `authorizationCheckedAt`, with a currently stored nonexpired grant; it is not a perpetual promise that GitHub permissions have not changed. Every GitHub discovery/selection rechecks live access. Local file availability does not depend on keeping a GitHub credential because the server performs no remote fetch.

`localState` is `declared|verified|stale`. `verified` is a timestamped host observation; every prompt re-inspects the checkout. `cloned:false` means this service did not clone it. Selection is a persisted UI preference: `POST /api/instances/:id/repositories/:referenceId/select` with `{controllerId,selected:true|false}` returns `{repository}`. Metadata/path identity is immutable; mapping a different path creates a new reference. Each instance has at most 100 references.

### Commands and message context

Normal command/lease fencing applies. Browser clients request `repository.inspect` with empty `args` and top-level `repositoryId`. The relay resolves only owned instance-bound references and injects `{path,expectedRemoteUrl}`. It records verification only from that exact successful command's result, with the expected canonical path, remote identity and validated branch/commit. Failed inspection makes the snapshot stale.

For `session.prompt`, top-level `repositoryIds` is an optional list of up to eight unique, already verified references. The relay injects `args.repositoryContext = [{referenceId,path,expectedRemoteUrl}]`. Clients cannot supply raw repositoryContext or arbitrary inspect paths. Host validation runs again, realpaths stay within operator allowlists, actual remotes are compared, and only bounded metadata is appended to the user message. Repository content is not automatically read or sent. No field is passed as a shell command or used to silently change the session working directory.

The host must provide an executable Git on its deployment-managed `PATH` outside every allowed workspace root. Inspection resolves and invokes Git by its canonical absolute path and excludes checkout-local `PATH` entries, including package-manager `node_modules/.bin` entries and symlink aliases into allowed roots. No suitable external Git produces `repository_git_unavailable`; it never falls back to a repository-supplied executable. Keep workspace roots narrowly scoped and the remaining host `PATH` directories trusted. Standard Linux and macOS system/Homebrew Git installations remain supported.

## Acceptance checks before enabling externally

- Run unit/integration tests and the real-host repository inspection/prompt smoke flow
- Configure a dedicated read-only GitHub App with selected repositories
- Test actual browser consent, cancellation, replay, expired login and revoked authorization
- Confirm organization approval/policies, TLS callback origin, and no secret exposure in logs/backups
- Test repository removal from installation and local checkout/remote changes
- Native client must show the web-connect instruction and `nativeOAuthSupported:false`

A passing fixture test alone does not establish any of the external setup/consent checks.

# Relay API, version 1

All non-public routes require a session cookie or `Authorization: Bearer …`. No credential may appear in URL query parameters. Every route derives tenant identity from authentication. Times are milliseconds since Unix epoch.

## HTTP

- `GET /health`: readiness, protocol version, `registration` (`open`, `invite` or `closed`) and `githubSignIn` (the GitHub App is configured)
- `POST /api/auth/register`: `{email,password,deviceName,inviteCode?}`; requires explicit operator registration enablement, and the invite code in invite mode. Passwords need at least 8 characters
- `POST /api/auth/login`: same fields; returns `{user,controller}` and an HttpOnly cookie; originless native callers also receive `token`
- `POST /api/auth/github`: `{deviceName,inviteCode?}` from a browser (an `Origin` is required; native callers get `409 GITHUB_BROWSER_REQUIRED`). Returns `{authorizationUrl,expiresAt}` plus the HttpOnly flow cookie; navigate to the URL in the same browser. GitHub returns to `/github/callback`, which signs in the account linked to that GitHub user and redirects to `/?github=signed_in` with the session cookie. An unlinked GitHub user gets a new account only when registration is open, or in invite mode when a valid `inviteCode` was sent at start; otherwise the redirect carries `INVITE_REQUIRED` or `REGISTRATION_DISABLED`. A wrong invite code fails the start with `403 INVITE_REQUIRED`. Accounts created this way have no password. Sign-in also stores the GitHub repository grant, and connecting GitHub from a password account links that GitHub user for later sign-in (never re-pointing an existing link). `GET /api/me` includes `user.github`, the linked login or `null`
- `POST /api/auth/logout`: revokes the login/controller session, event sockets and owned writer lease
- `GET /api/me`: `{user:{id,email},controller:{id,name,createdAt}}`
- `GET /api/controllers`: `{controllers:[…]}`; a controller is registered through login on that device
- `POST /api/controllers/:id/revoke`: revokes owned controller sessions, stream sockets and leases
- `GET /api/instances`: `{instances:[{id,name,online,bootId,connectionEpoch,lease,capabilities,createdAt}]}`
- `POST /api/instances`: `{name}` → `{instance,connectorToken}`. Raw token is displayed only in this response
- `POST /api/instances/:id/rotate-credential`: replaces the old connector credential, disconnects it and invalidates writer control; returns `{connectorToken}` once
- `POST /api/instances/:id/pairing`: issues a single-use pairing code valid for 10 minutes (only the newest code per instance is valid) → `{code,expiresAt,pairingUrl}`
- `POST /api/connector/pair` (no session; rate limited): `{code}` → `{instance:{id,name},connectorToken}`. Consumes the code and rotates the instance credential, like `rotate-credential`
- `GET /api/connector/me` (connector bearer): `{instance:{id,name}}`, or 401 when the credential was rotated or revoked
- `GET /api/instances/:id/state`: authoritative `{instance,pendingApprovals}` after reconnect/reset
- `POST /api/instances/:id/lease`: `{controllerId,takeover?:true}` → `{controllerId,epoch,expiresAt,pending:false}` after host fence acknowledgement. Offline instances return 409. A withheld first-acquisition/takeover ACK returns `FENCE_PENDING`; writes remain blocked. Same-epoch renewal keeps the previous acknowledged authority until its old expiry, and command deadlines cannot use the extension until the Host acknowledges it
- `DELETE /api/instances/:id/lease`: `{controllerId}`; only the current controller can release
- `POST /api/instances/:id/commands`: `{id,controllerId,leaseEpoch?,action,args}` → command row, usually 202. `id` is a stable client-generated value; retries with changed arguments return 409
- `GET /api/commands/:id`: same-user command status and optional result/error

Command states: `dispatched`, `succeeded`, `failed`, `indeterminate` (the type also reserves `queued`). A succeeded `session.prompt` means the DSH inbox accepted the prompt. Observe real session events/status for turn completion.

Errors use `{error:{code,message}}` and a non-2xx HTTP status. Maximum wire frame is 8 MiB; attachment base64 is limited to 6 MiB encoded. Control arguments have bounded depth/count, allowlisted keys and action-specific requirements. Maximum 64 simultaneously dispatched commands per account.

## Allowlisted actions

Passive: `capabilities`, `session.list`, `session.read`, `session.page`, `session.projections`, `settings.describe`, `workspace.list`, `workspace.browse`.

Folder picker: `workspace.list` returns `{roots:[{name,path}],anyWorkspace}`, the canonical folders the DSH computer allows. `workspace.browse {path?}` returns one level, `{path,parent,directories:[{name,path}],truncated}`: subfolders only (no files, hidden or Windows system folders), at most 500. Without `path` it returns the starting places: the roots, plus the home folder and drives when the DSH computer has switched on "允许远程选择本机任意目录" (`anyWorkspace`). The Host resolves every path canonically and refuses (`workspace_forbidden`) anything a session could not be opened in; `parent` is `null` at the edge of what may be listed. Plugins that predate the picker do not advertise these capabilities, and the console then falls back to a typed path.

Writer: `session.create`, `session.prompt`, `session.cancel`, `session.resume`, `session.queue.update`, `model.select`, `attachment.upload`, `approval.respond`, `settings.update`.

There is no arbitrary RPC, shell, file read, provider credential, plugin install or raw global-settings route. Session-scoped configuration has a positive preset allowlist and optimistic revision matching. `session.create` requires an explicit stable `sessionId`; the host additionally enforces configured canonical workspace roots (or any existing folder when `anyWorkspace` is on), and answers `no_workspace` when none is configured.

Exact compile-time envelopes are in `packages/protocol/src/index.ts`; host command argument checks are in `packages/dsh-plugin/src/adapter.ts`, and relay checks in `apps/server/src/validation.ts`.

## WebSocket

### Controllers: `/ws/events?after=<sequence>`

Cookie or Authorization header authenticates the stream. Sockets are receive-only. Durable event frames: `{v:1,type:'event',seq,instanceId,kind,payload,createdAt}`. Sequence is global and tenant-filtered; gaps are normal. DSH events use payload `{sessionId,data}`. Command/lifecycle/lease event payloads use their own fields.

If replay exceeds 1,000 events, the server emits `{type:'reset',cursor,reason}`. Reconcile authoritative current state rather than silently skipping history. Replay/reset is followed by `{v:1,type:'snapshot',instances,pendingApprovals}`, then `{v:1,type:'ready'}`. Historical approvals must be replaced with this live pending set.

### Instances: `/ws/connector`

Authorization bearer token is mandatory. The connector sends `hello` with boot identity/capabilities. The server sends `welcome` with instance and connection generation. Commands and live leases carry fencing fields. A `lease.ack` only follows installation of that fence inside the actual host shim.

Results are journaled before transmission and acknowledged with `result.ack`. Durable events have stable source IDs and `event.ack`; acknowledged outbox records can be pruned. Reconnect resends unacknowledged results/events, never blindly reruns a possibly applied command. A new host boot invalidates historical approval handles.

## Instance liveness and repository references

Instance status exposes connecting/online/stale/offline plus observation timestamps; see [instance connection status](instance-status.md). GitHub read-only discovery, existing-checkout mapping, fenced inspection and metadata-only prompt context are specified in [repository access](github-repositories.md). These new backend paths are separate from the original engineering-base UI snapshot.

# dsh-remote: security and protocol architecture

Status: implementation specification, not an implementation or test-pass report. Prepared 2026-10-04. Project name is provisional. A later evidence report must name the actual tested commit and toolchain.

## 1. Scope and decisions

Build a multi-user service in a standalone monorepo. A user owns several controlled DeepSeek Harness (DSH) instances and several controller devices. Any authenticated owner device may read an owned instance; **exactly one controller device may hold its write lease at a time, per instance**. Explicit takeover is allowed. The user confirmed this per-instance model; it is not a global one-device limit.

Required main flow: authenticate → register/pair an instance → see real sessions and redacted configuration → create a real session → submit queued and next-step priority input → stream actual runtime events → answer an exact live approval → attach real bytes → reconnect without duplicating work. Web and Flutter must both complete this flow against the real integration. A mock-backed demo does not satisfy acceptance.

Decisions:

- Backend: Bun with native HTTP/WebSocket handlers. The initial recommendation was Hono plus Zod; the first implementation uses native Bun routing and explicit runtime validators, so it must not claim Hono/Zod integration or generated schema coverage. Prefer a shared strict validator package consumed at both network and Host boundaries; a later Hono/Zod adoption is optional and must preserve the tested contract. This keeps the non-TypeScript Flutter client on an explicit versioned JSON protocol. [Bun WebSockets](https://bun.sh/docs/runtime/http/websockets)
- Web: React + TanStack Router + TanStack Query + Vite. Server state is queried and reconciled by identity/cursor; optimistic UI never fabricates runtime completion. [Router](https://tanstack.com/router/latest/docs/overview), [Query](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)
- Mobile: Flutter with the same versioned JSON contract; its event connection is suspended/recreated across app lifecycle transitions. The standard WebSocket stream is a transport, not persistence. [Flutter](https://docs.flutter.dev/cookbook/networking/web-sockets)
- Persistence: SQLite/WAL for the initial **single gateway process on one host** and for the connector command journal. All multi-user isolation, leases, and restart tests run against this real database. No unsupported multi-replica claim. Backups include the proper SQLite backup procedure, not copying only a live main database file. [SQLite deployment guidance](https://www.sqlite.org/whentouse.html), [WAL](https://www.sqlite.org/wal.html)
- PostgreSQL is a future, separately tested scale-out migration. Do not use SQLite locally and silently assume production Postgres is equivalent. Multi-gateway operation also needs connector ownership/routing, cross-process invalidation, and durable event fanout; changing the database alone does not supply them.
- DSH's supported host is Node. Its installed Cordis plugin supplies a thin in-process adapter to real host services and manages a **local Bun connector child** over private stdio. The connector's WAN transport is Bun. Do not advertise that DSH itself runs under Bun without a separate compatibility test.
- Each registered DSH home/profile belongs to one service owner/trust domain. A shared physical host may run different homes under different OS users, but one unrestricted DSH process is not a tenant sandbox.

### Component layout

    browser controller ---- HTTPS / authenticated event WSS ----+
                                                               |
    Flutter controller ---- HTTPS / authenticated event WSS ----+-- Bun gateway -- SQLite/WAL
                                                               |
    local Bun connector -------- outbound WSS through NAT ------+
             |
        private stdio (bounded framed JSON / binary transfer)
             |
    installed Cordis adapter inside official Node DSH host
             |
    SessionController, SettingsController, fileUploads, approval waterfall

No public listener on the controlled computer is required. There is no generic remote shell, raw Typert proxy, arbitrary file-read endpoint, or command-by-module-name interface.

## 2. Verified upstream baseline and caveats

Pin DSH commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, reported package version `0.2.1-alpha.1`. Versions must be pinned in the lockfile and recorded in test evidence; current documentation is not a compatibility guarantee.

Primary source links below refer to this exact commit:

- [SessionController](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/api/session-controller/src/index.ts): real session list/create/page/follow/projections/prompt/updateQueue/cancel/selectModel/attachment operations
- [Command implementations](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/api/session-controller/src/commands.ts): creation can use an explicit session ID; prompt accepts client request ID; model selection additionally attempts to save the default asynchronously
- [Session types](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/api/session-controller/src/types.ts): queue/steer modes, history envelopes, file receipt and image payload shapes
- [History implementation](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/api/session-controller/src/history.ts): follow starts with a snapshot and has no `afterSeq` request parameter; cold ordinary follow can promote/resume an agent after the snapshot
- [SettingsController](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/api/settings-controller/src/index.ts): redacted reads, expected revisions on writes, separate credentials namespace that the bridge must not expose
- [Approval service](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/interaction/user-approval/src/index.ts): scoped live waterfall, one-action outcomes and abort cancellation
- [File uploads](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/file-upload/src/index.ts): streaming intake, session-owned receipt scope, receipts held in a live Session-keyed map
- [Runtime requirements](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/package.json): official Node engine and pnpm build path

Important semantic constraints:

1. `steer` is next-step priority input. It does not interrupt the currently executing model request or tool. Idle steer can open a turn; after cancellation it can become next-turn input. The UI label should say "Next step / priority", and expose cancel separately.
2. Prompt retry dedup searches accepted user messages and pending inbox, but is not an in-flight reservation before asynchronous attachment admission. Serialize mutation admission per session in the adapter. Do not serialize all sessions globally.
3. A follow snapshot is not a passive subscription for a cold session: it can resume pending work. Passive viewers use `inspect`, `page`, `projections` and a read-only observer; explicit activate/resume requires the write lease. Avoid waking a session simply by opening its detail screen.
4. DSH durable event sequence and transient assistant stream revision are distinct. Stream revisions can restart with agent lifecycle. Store durable event identity as `(instanceId, sessionId, sessionSeq)`; stream identity additionally carries boot/stream generation.
5. The public live approval request does not expose the durable audit ID as a pending-response token. The adapter must mint a live capability token and bind it to that exact callback generation. Historical `approval/asked` records must never become actionable.
6. `selectModel` has an instance-default side effect. Either disclose "also updates the default for new sessions" and test it, or implement a narrower officially supported adapter operation and prove its behavior. Do not promise session-only mutation while calling the broader operation.

## 3. Identity, registration and revocation

### Human and controller identity

The current implementation API uses email/password registration and login. Store only an adaptive password hash (Argon2id), never plaintext; normalize the login identifier without over-normalizing its provider-specific meaning. Rate-limit login/registration, return non-enumerating login failures, and rotate the session after authentication. Disable open registration when the self-hosted operator intends invite-only use. Password recovery, email verification and abuse policy must be stated before internet deployment.

Each authenticated session is bound server-side to `(userId, controllerId, sessionId, authEpoch, expiresAt)`. A client-supplied `controllerId` must equal the identity bound to its current cookie/token. Merely checking that it belongs to the same account allows a second device to impersonate the writer.

- Web: Secure, HttpOnly, SameSite cookie; protect every mutation with an exact Origin check and CSRF token. Prefer same-origin UI/API. Do not store bearer tokens in localStorage, query strings, or logs.
- Flutter: short-lived access token and rotating refresh token in OS secure storage. Treat app backgrounding and OS termination as normal reconnects. Never bundle a shared user/connector secret in the app.
- If migrating to OIDC, use Authorization Code + PKCE in the external browser for native apps, exact redirect matching, issuer/audience validation and state/nonce checks. This is an optional future authentication implementation, not something already tested. [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252), [OAuth security BCP](https://datatracker.ietf.org/doc/html/rfc9700)

### Controlled instance identity

Instance creation generates an opaque high-entropy connector token shown once, scoped only to a specific registered instance and owner. Store its hash, credential ID, creation/revocation timestamps, and auth epoch on the server; do not store the raw token. The token authenticates connector transport, not controller API access.

The owner installs/configures the real DSH plugin locally with the exact backend origin and token. Bind the backend origin in saved connector configuration and require explicit local re-pairing to change it. Never take a server URL from a remote session message or model output.

This one-time token workflow is v1 pairing. A future display-code flow may use an expiring random private pairing handle plus rate-limited short human code and authenticated owner confirmation. The short public code alone must never mint a credential. Pairing must describe that the service receives session content, redacted config and attachment bytes and can send allowed control operations.

Keep the connector credential in a private local file/OS store. The plugin configuration contains `connectorTokenFile`, never the raw token: read a regular, non-symlink, size-bounded owner-only credential file inside the Node shim, then pass bytes to the managed child through private stdin. Do not put them in command-line arguments, resolved plugin configuration or diagnostic output. The current POSIX file guard requires owner UID and private file/parent modes. Windows file mode bits do not prove ACL privacy: fail closed until a Windows secure-storage or SID-based ACL implementation is tested, and state that controlled-instance platform limitation explicitly. Scrub inherited environment. Model API keys stay in DSH and are not passed to the Bun child.

### Revocation semantics

Revoking an instance credential or controller session must invalidate future HTTP requests, close matching live sockets, release its write lease, and reject queued but unexecuted commands. Recheck current auth/ownership before dispatch and before processing each actionable frame, not only at WebSocket upgrade. Connector rotation should explicitly replace or revoke the old credential; do not silently give two connectors concurrent authority.

Revocation cannot undo an action already admitted to DSH. UI and audit distinguish "new control disabled" from "active turn cancelled". Cancellation is its own user command. If the connector is unreachable, show revocation locally recorded and execution acknowledgement pending; do not claim the machine has stopped.

## 4. Multi-user authorization

Use owner-scoped resource keys throughout:

- users; controller_sessions with bound controller; instances with immutable owner
- connector_credentials; instance_connections with monotonic connection epoch
- instance_leases with controller, epoch, expiry and state
- commands with owner, instance, session address, principal, idempotency key/hash and result
- event_log with owner/instance and stream cursor; attachments with owner/instance/session, digest and upload state
- audit rows containing actor/action/target/status, not full prompt or secret-bearing payload

Every lookup and write uses `(owner_user_id, resource_id)` or a joined ownership predicate. Composite foreign keys prevent a command, attachment, lease, or event from referencing another owner's instance. Opaque IDs reduce accidental discovery; they are not authorization.

Authorization must apply independently to list/detail, command status, events and replay, uploads/downloads, pending approvals, configuration, and live subscriptions. Return a uniform not-found/forbidden result for unowned IDs without revealing another tenant's name, online state, sequence count or existence. Clients never choose event bus topic strings. The gateway derives subscription topics from authenticated ownership.

The connector trusts only its authenticated instance binding. It rejects a command naming any other instance and validates the same action/argument schema as the gateway. A registered instance exposes the sessions in that DSH trust domain; if the owner wants only selected workspaces, configure a local workspace allowlist and apply it to enumeration as well as mutations.

## 5. Single-writer lease and fencing

Read-only viewers do not need a write lease. Creation, prompts, queue mutation, cancel/resume, model/config mutation, attachment admission and approval responses require it.

Suggested defaults: 30-second lease, renewal every 10 seconds, clearly displayed device name and expiration. These are configurable engineering defaults, not an upstream requirement. A disconnected controller loses write authority on expiry; its active model turn continues.

Lease acquire/renew/release/takeover runs in one SQLite transaction. Use a unique lease row per instance and increment a monotonic epoch for each new holder/takeover. Renewal checks holder, epoch, authenticated device and expiry. The lease token is scoped to device and instance; copying an `epoch` number is insufficient authority.

For explicit takeover:

1. Gateway locks new mutation admission for the instance, increments epoch and records the new candidate holder.
2. It sends the new fencing epoch over the authenticated current connector connection.
3. Adapter installs that fence before accepting any later mutation and acknowledges it.
4. Gateway marks the new lease active and notifies all viewers. Until this acknowledgement, UI says "Taking control"; if offline, it must not show active control.

Commands carry both the connector connection epoch and lease epoch. The connector rejects a superseded connection/lease and expired command. Already-admitted actions remain in progress; takeover does not implicitly cancel them. Per-session serial admission gives a defined boundary between the fence and effects, while independent sessions can progress concurrently.

If implementation initially omits the connector acknowledgement or fence check, its lease is only a gateway-side arbitration mechanism and must be reported as incomplete distributed fencing. A database lease alone cannot invalidate a command already in an old socket buffer.

## 6. Versioned command and event protocol

Keep human API HTTPS and connector WSS distinct. Negotiate `v: 1` plus capabilities. Unknown actions/fields, illegal JSON shapes, excessive nesting/length, duplicate semantic IDs, and unsupported versions fail closed. Maintain machine-checkable JSON Schema and exhaustive fixtures for the shared validator, or generate them from strict Zod objects if Zod is adopted; Flutter fixtures must validate the exact same wire shapes. Use JSON-compatible strings for large counters if they can exceed JavaScript's safe integer range. [Zod schema conversion](https://zod.dev/json-schema)

### Version 1 implementation contract

These interfaces define the version 1 boundary. Endpoint-level verification is recorded separately in [verification status](../verification.md):

| Endpoint | Purpose |
|---|---|
| POST `/api/auth/register`, `/api/auth/login` | `{email,password,deviceName}` → principal/controller, secure cookie; native token only as needed |
| GET `/api/me` | Current identity/device/session status |
| GET `/api/controllers` | List devices; a new login registers a new controller identity |
| POST `/api/controllers/:id/revoke` | Revoke an owned controller and its current write lease |
| POST `/api/instances/:id/rotate-credential` | Invalidate old connector credential and reveal its replacement once |
| GET `/api/instances/:id/state` | Owned instance state and current pending approvals |
| GET/POST `/api/instances` | List owned instances / register one and reveal connector token once |
| POST `/api/instances/:id/lease` | `{controllerId,takeover?}` → `{epoch,expiresAt,controllerId,pending}` |
| DELETE `/api/instances/:id/lease` | Release exact held lease |
| POST `/api/instances/:id/commands` | `{id,controllerId,leaseEpoch?,action,args}` → `202` command receipt |
| GET `/api/commands/:id` | Owner-scoped command state/result |
| WSS `/ws/connector` | Authorization bearer connector token, no browser cookies |
| WSS `/ws/events?after=...` | Controller auth plus owner-scoped replay cursor |

Connector hello: `{v:1,type:"hello",bootId,capabilities}`.

Gateway command: `{v:1,type:"command",id,instanceId,connectionEpoch,leaseEpoch,action,args,expiresAt}`. Lease changes use `lease` and a Host-confirmed `lease.ack` containing epoch, expiry and connection epoch.

Connector result: `{v:1,type:"result",id,connectionEpoch,ok,result?,error?}`; socket identity supplies the connection binding. Server accepts results only for a command previously dispatched to that exact bound instance/connection, with a documented policy for late results of already-admitted commands.

Connector event: `{v:1,type:"event",id,sessionId?,kind,payload}`. Gateway durable event: `{v:1,type:"event",seq,instanceId,kind,payload,createdAt}`. The connector event ID supplies source identity; stable durable events use session+seq, and live events include a generation or fresh identity. Gateway `seq` alone cannot deduplicate connector replays. Connector event kinds cannot impersonate gateway-owned lease/command/instance events. A duplicate source event must not reapply its state projection; event insert plus projection update is one transaction.

Required bounded action set:

- `session.list`, `session.read`, `session.page`, `session.projections`
- `session.create`, `session.prompt` with `mode: queue|steer`, `session.queue.update`, `session.cancel`, explicit `session.resume` if needed
- `model.list`, `model.select` with disclosed actual default behavior
- `settings.describe`, narrow revision-checked `settings.update`
- `attachment.upload`, ownership-checked attachment read/download
- `approval.respond` to an exact live request

Names may be consolidated, but each required behavior must exist and have an acceptance case. A generic arbitrary method string is not an acceptable shortcut.

### Command delivery and idempotency

State machine: `accepted → dispatched → running/admitted → succeeded|failed|cancelled|expired|indeterminate`. Receiving a `202`, a WebSocket acknowledgement, or an inbox receipt does not mean the model turn completed. Expose those separate states to the UI.

Store a canonical argument hash bound to owner, instance and command identity. The current API namespaces a caller-selected request ID by owner internally; the ID therefore cannot be reused for a different instance within that owner. It is independent of another owner using the same request ID. Same ID + same payload returns the original command; same ID + different payload is `409 idempotency_conflict`. Durable connector journal records command identity/hash/phase/result. Retry transport delivery with the same ID, never mint a new command to conceal a timeout.

- Creation uses one server-minted deterministic DSH session ID retained with the command, then calls the explicit-ID upstream create/adopt path.
- Prompt maps stable command ID to upstream `requestId`; serialize admission per session, then reconcile by inbox/history on recovery.
- Queue/config/model operations need operation-specific reconciliation, expected revision, or a safe indeterminate state. A generic result cache does not make arbitrary external effects exactly once.
- There is an unavoidable crash window between DSH side effect and connector result persistence unless the operation provides its own idempotency/reconciliation evidence. Do not automatically repeat unresolved non-idempotent mutations.
- Offline mutation requests fail with `instance_offline` by default. If a command was already accepted and becomes disconnected, retain its state and expiry; reconnect must recheck current lease/authorization and never execute stale approvals automatically.

### Replay and snapshots

Gateway durably commits an event before broadcasting it. Cursor replay is scoped to the same owner and instance/subscription. A valid cursor resumes after its last delivered durable event; expired/unknown/foreign cursors return an explicit reset response with a fresh snapshot/watermark. Never silently skip missing history.

The relay cursor, DSH session event sequence, and transient token-stream revision are different fields. On connector restart: snapshot the session inventory and live control state, recover missing DSH durable events by `page`/read-only observation, deduplicate by source event identity, and replace transient generation state. A new upstream follow opens a new snapshot; do not invent an unsupported upstream `afterSeq` parameter.

Transient assistant chunks may be coalesced under load. They must be replaced by the actual committed assistant message or attempt; UI cannot display coalesced chunks as independently durable output. Pending approvals and command terminal outcomes are lossless logical state. If any queue exceeds limits, disconnect/reset and reconstruct from authoritative snapshots rather than silently dropping durable events.

## 7. Approvals are live capabilities

The installed adapter registers an `approval/request` answerer within its authorized DSH scope. For each live request create an unguessable `requestToken`, current `bootId`, session ID, tool name/call ID and a hash of the decision presentation. Retain the exact pending resolver and abort listener in a bounded registry.

Send a structured, escaped presentation: reason, tool/action, known target/arguments and requested scope. Untrusted tool/model text is display content, never instructions for the controller. Never turn a prompt saying "approve everything" into authority.

`approval.respond` includes token, boot generation, session ID, decision (`allowed-once` or `rejected`) and presentation hash. Gateway checks owner and current writer; adapter checks exact registry entry, unchanged presentation, current generation, signal not aborted and unresolved state. Resolve atomically once. Late/duplicate/conflicting responses return the original decision or a stale error, and cannot approve another request.

Upstream outcomes are `allowed-once`, `rejected`, `cancelled`, `unavailable`. There is no implicit permanent "always allow" in this bridge. Disconnect may leave an existing request pending within a bounded timeout; it must never grant automatically. Plugin unload/restart cancels/fails closed and invalidates all old tokens. A history replay is display-only, including old approval audit records.

## 8. Attachments, workspace and configuration safeguards

### Attachments

Prefer streaming HTTPS upload to the gateway plus a bounded binary/chunk transfer over the connector, then `ctx.fileUploads.uploadStream` inside DSH. Inline base64 is acceptable only for an explicitly small enforced limit, accounting for base64/JSON overhead. The implementation must report its real tested maximum rather than claim an unimplemented streaming path.

Implemented wire limits in the shared validator: 6 MiB canonical base64 characters per upload and per prompt image aggregate (about 4.5 MiB decoded), four attachment parts, 32 total content parts and 100,000 text characters per prompt. Names are bounded display filenames. A streamed-upload successor may support 8 MiB per file and 20 MiB per message. Two concurrent uploads per user, a global memory bound, transfer expiry and a per-owner disk quota remain operational requirements to verify. These limits may be lowered for the first tested build, but must be visible and consistent in all three layers. Control frames should normally remain at or below 256 KiB; byte transfer uses separate bounded frames. Do not set a small frame cap and then silently rely on larger base64 payloads.

File names are display labels, never storage paths. Generate storage keys; reject NULs, traversal, absolute/UNC paths, drive letters, alternate separators and unsafe symlinks. Do not extract archives server-side. Validate bytes/size/digest and MIME signatures where meaningful; serve risky types as download with `nosniff`, never executable inline HTML/SVG. Do not follow arbitrary remote URLs (SSRF).

Bind staged uploads to `(owner,instance,session,uploadId,digest)` and a single prompt/request. An attachment receipt belonging to another session or owner fails even if the token is known. Upstream staged receipts are live-memory scoped; after host restart, an unconsumed upload may need re-staging from retained bytes. Reconcile an already accepted prompt before re-upload/re-send. Expose expiry/retry honestly.

Attachment download requires ownership each time; no public durable URLs. Garbage-collect unbound/expired bytes; revoke access promptly with the owning instance/account. Include hash and actual byte comparison in E2E, not only a thumbnail screenshot.

### Workspace paths

Prefer locally registered workspace IDs for creation. Do not relay arbitrary `cwd` or expose native-open/native-file-manager actions. If directory selection is needed, choose only within an explicit locally configured allowlist and canonicalize real paths to defeat traversal/symlink escape. The DSH user's underlying tool permissions still apply.

### Configuration and secret minimization

For a future generic configuration view, only call redacted SettingsController reads and project allowed fields. The current implemented surface is narrower: model catalog plus allowed permission/agent presets and session projections; it does not claim arbitrary plugin-namespace configuration coverage. Exclude `credentials` methods, environment dumps, raw config files, process metadata containing tokens and arbitrary plugin configuration. Use a positive allowlist of safe settings and schema paths; annotations alone cannot guarantee an unknown plugin classified its secrets correctly.

Return credential presence (`set: true/false`) only where useful; never actual provider API keys or connector bearer material. Sanitize errors and audit logs. Configuration writes require the current writer, allowed namespace/path/type, and a mandatory expected revision; reject stale writes. Forbid remote writes to credentials, executable/plugin install paths, network endpoints, auth/access policy and sandbox escalation settings by default. Do not replace a redacted config object wholesale, because redacted placeholders must not overwrite real secrets.

The service necessarily sees the session content it relays. HTTPS/WSS is transport encryption, not end-to-end encryption against the gateway operator. Arbitrary tool output may already contain a secret; no scanner can promise perfect transcript redaction. Avoid collecting known credential surfaces, apply tested defense-in-depth filtering, minimize retention, and make this trust boundary clear.

## 9. Operational bounds and observability

- Strict TLS outside localhost development; validate exact browser Origin on WebSocket upgrade, not wildcard/substring checks. Authenticate before upgrade or send no private data before authenticated handshake. [OWASP WebSocket guidance](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- Explicit frame/payload/message-depth bounds; outbound queue byte/count limits; rate limits per account, instance and connection. Disable compression initially. Bun defaults are not a security policy.
- Heartbeat every approximately 20 seconds, unhealthy after missed acknowledgements; reconnect exponential backoff with jitter and a cap. Network recovery does not imply command retry authorization.
- SQLite transactions protect auth/lease/idempotency updates. Enable foreign keys and busy timeouts, keep write transactions short, and prevent unsupported concurrent gateway processes. Record migrations and backup/restore tests.
- Adapter cleanup is a Cordis effect: stop taking commands, settle live approvals fail-closed, abort subscriptions, stop the local child and await shutdown. Use a scrubbed environment; the DSH execution-world subprocess provider may be remote, so deliberately launch the connector locally.
- Log correlation ID, user pseudonymous ID, instance/session/command ID, action and result code. Do not log passwords, cookies, tokens, prompt bodies, attachment bytes or complete tool arguments. Protect audit read permissions.
- Health/metrics expose aggregate operational data without tenant metadata. Admin diagnostics do not acquire implicit permission to read transcripts.

## 10. Completion boundary

Architecture and passing unit/fixture tests are not delivery. The companion acceptance checklist requires a real installed plugin, real DSH session persistence/events/approval path/attachment intake, both actual controller UIs, network interruption and tenant isolation tests. Run deterministic provider-backed real-runtime tests for reproducibility and separately run a real model-provider test with authorized credentials. Missing model access or mobile runtime is a named blocking stage, never a substituted success.

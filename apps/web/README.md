# DSH Remote Web

Responsive Chinese-language control console using React, TanStack Router and TanStack Query. The production bundle is served by the Bun relay on the same origin.

## Development

From the repository root, install the workspace with `bun install` and start the relay. Then:

```sh
bun run --cwd apps/web dev
```

Vite listens on `127.0.0.1:5173`; `/api` and `/ws` proxy to the relay on port 3000. Registration is available only when the relay has `REGISTRATION=enabled`.

```sh
bun run --cwd apps/web build
bun run --cwd apps/web test
bun run --cwd apps/web test:integration
```

The unit suite checks DSH wire presentation, fenced lease availability, cookie transport and command failure handling. The DOM integration suite starts a real isolated Bun relay, renders React in JSDOM, and tests account creation, HTTP/WebSocket synchronization, cancellation, instance setup, offline safeguards, credential rotation, device revocation and logout. JSDOM is not browser rendering or visual QA.

## Real DSH integration

`bun run --cwd apps/web test:runtime` uses `packages/dsh-plugin/tests/runtime-smoke.ts` and requires the actual upstream source checkout, its dependencies, and a built DSH plugin. Set `DSH_UPSTREAM` to that checkout. The test exercises the real DSH runtime and connector with the upstream deterministic model fixture. It covers explicit takeover, session creation, prompt delivery, durable assistant history, model selection, actual file upload, queue editing/removal, scoped approval rejection and lease release.

## Browser tests

After building the web app:

```sh
bun run --cwd apps/web test:browser
# Requires the prepared real DSH checkout and built plugin:
bun run --cwd apps/web test:browser:runtime
```

The runtime Playwright suite uses the same real DSH fixture and checks session creation, takeover, reload/history, prompts, attachments, model changes, queue edits, approvals and cancellation. It records desktop and mobile screenshots. Set `BUN_PATH` if Bun is not on PATH.

The standard Playwright suite starts a real relay with an isolated temporary database. It includes desktop and 390 px mobile cases and saves screenshots. Use `PLAYWRIGHT_EXECUTABLE_PATH` when needed; otherwise it uses system Chromium if present or Playwright's installed browser. Restricted containers may prevent Chromium from opening its local sockets; in that case these tests cannot provide browser/visual verification.

## Control and safety

- Authentication uses same-origin HttpOnly cookies; no auth or connector token is written to web storage
- Each authenticated login is bound to its returned controller ID
- Instance creation and credential rotation show the connector token once, in memory only; store it in a host file with mode 0600 inside a mode 0700 directory, and configure only its absolute `connectorTokenFile` path
- Device revocation and connector credential rotation require explicit confirmation; revoking the current device logs it out
- Read-only session selection never resumes a cold DSH session
- Writes require a live, acknowledged lease and its fencing epoch; takeover is explicit
- A foreground owner renews the lease every 10 seconds; hidden tabs allow it to expire
- WebSocket snapshots replace pending approval state; replay cursors and capped live streams handle reconnects
- Approval decisions echo the exact session, boot ID and presentation hash
- Permission/preset writes include the projection revision and only offer host-allowed values
- Command retries for an unchanged prompt preserve command and DSH request IDs
- A model switch also changes the DSH default model; the dialog discloses this side effect
- Text and tool output are rendered as text, never injected as HTML

## Harness UI and repositories

The web application adopts the browser-reviewed prototype's pinned DeepSeek Harness semantic theme, local Montserrat assets, core icon artwork, conversation width, composer and approval geometry. It supports system/light/dark appearance, desktop and 390px mobile navigation, keyboard dismissal/focus restoration, and reduced motion. Upstream license and provenance are under `src/vendor/`. Runtime-generated context and time records are collapsed separately from real user messages; their text remains inspectable.

`实例状态` queries real relay observations: connecting, online, stale and offline, last heartbeat, connection/disconnection timestamps and connection epoch. Stale or unsynchronized observations cannot grant writes. A disconnected observer stream suspends local write availability until explicit lease acquisition after reconnect.

`GitHub 仓库` supports the deployment-configured GitHub App's browser authorization, explicit cancellation, installation pages, repository pages, multi-selection and mappings to existing local worktrees. Each mapping shows authorization provenance separately from declared/verified/stale local state. A deployment without GitHub configuration still supports manual mappings. Verification requires the live host and current lease. Message references are removable, previewable, limited to eight unique verified IDs, and admitted as top-level `repositoryIds`; the browser never supplies raw `repositoryContext` or inspection paths. This feature does not clone, fetch, check out, or automatically read repository content. See `docs/github-repositories.md` for operator setup and live OAuth acceptance gates.

## Interrupted work and browser storage

Before a write command is posted, its UUID, exact admitted body and lease epoch are saved in this tab's session storage. Network failure, timeout or stopped local waiting retains that original identity and blocks new writes to the affected instance. `查询原命令` performs only a GET; even an initial 404 cannot authorize a new mutation. Unknown outcomes remain queryable while navigation and logout stay available. There is no automatic mutation replay.

A bounded, account- and origin-scoped local-storage journal stores only unresolved command/instance/controller IDs and action names. It preserves read-only reconciliation after the original tab is closed. It contains no prompt text, files, repository paths, authentication tokens or connector credentials. Exact bodies and unsent drafts remain tab-scoped; terminal confirmation removes recovery records. If browser storage cannot record a command safely, the UI fails before dispatch. Clearing browser storage discards this local recovery information, so operators should inspect host state before retrying uncertain work.

The extended test suite covers metadata-only recovery across tab recreation, 404 races, late OAuth responses after cancellation, stale status, source-page-bound GitHub mappings, real-relay unconfigured/manual flows, and real-host multi-reference prompt admission. GitHub UI unit fixtures are deterministic contract tests, not live GitHub consent. Authenticated external OAuth and paid/live-provider acceptance remain separate operator-run gates.

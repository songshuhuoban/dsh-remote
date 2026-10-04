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

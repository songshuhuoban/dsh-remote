# DSH Remote

[中文说明](README.zh-CN.md)

An independent multi-user control plane for DeepSeek Harness (DSH): a Bun relay, an outbound Bun connector managed by a real Node/Cordis plugin, a TanStack React web console, and a Flutter mobile controller.

**Work in progress. This is not yet a completed live-provider end-to-end acceptance.** See [the acceptance contract](docs/design/e2e-acceptance.md) and [verification status](docs/verification.md). No deployment or production credential is included.

## UI/UX design status

The [clickable prototype](docs/prototype/README.md) uses DeepSeek Harness's own semantic styles and covers takeover, approval, reconnect, failed upload, cancellation, repository references and navigation. Its 54 local checks and 24 actual Chromium walkthroughs passed; representative desktop/mobile light/dark pixels were reviewed. It remains a labelled simulation. The real Web and Flutter clients now adopt this design and pass their local real-DSH/DOM or widget checks. Hosted browser and APK validation of this newer snapshot remains a separate final gate.

## Repository

| Path                  | Purpose                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`         | Bun HTTP/WebSocket service with SQLite/WAL, tenant isolation, hashed credentials, controller leases and durable event replay |
| `packages/dsh-plugin` | Real DSH Cordis plugin running inside the supported Node host; allowlisted SessionController calls                           |
| `packages/connector`  | Bun outbound transport over private plugin stdio; SQLite command/result journal and reconnect outbox                         |
| `packages/protocol`   | Versioned wire envelopes, capabilities and action names                                                                      |
| `apps/web`            | TanStack Router + Query, React and Vite console                                                                              |
| `apps/mobile`         | Flutter native HTTP/WebSocket controller                                                                                     |
| `tests`               | Explicitly labelled protocol/unit tests and integration runners                                                              |

The DSH host is pinned to `0.2.1-alpha.1`, commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`. DSH remains on Node; the plugin does not pretend that upstream supports Bun as its host runtime. There is no dependency on Nuto or other personal projects.

## Local quick start

Prerequisites: Bun 1.4+, Node 24+, a supported DSH checkout/install, and Flutter stable for the mobile app. Install tools from their official distributions. The `.tools` directories used for local verification are not part of the source distribution.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test tests
bun run build:web
# Explicit, temporary local registration bootstrap. Default registration is closed.
REGISTRATION=enabled bun run dev
```

Open `http://127.0.0.1:3000`. Use a synthetic or locally managed account with a password of at least 8 characters. Create an instance and save its one-time connector token in the private credential file described below; configure only the file path in the DSH plugin. After provisioning the intended accounts, restart without `REGISTRATION=enabled`.

For frontend development, `bun run --cwd apps/web dev` proxies `/api` and `/ws` to the relay on port 3000.

Never expose the development listener directly to the internet. Production operation needs TLS termination (`SECURE_COOKIES=true` behind a TLS proxy), explicit origins, a closed account-provisioning policy, reviewed deployment/backup/retention controls, and the outstanding acceptance gates.

## Connect a DSH instance

Install the DSH Remote plugin from DSH's **Plugins** page by pasting the plugin address the relay serves (`https://<relay>/plugin/dsh-remote-plugin-<version>-<hash>.tgz`), then pair it: create an instance in the console, copy its one-time pairing link, and paste it on the plugin's page in DSH. The console's pairing dialog shows both, each with a copy button. The plugin stores the issued credential in DSH's credential store and runs the connector with DSH's own runtime; workspace folders that remote devices may use are chosen on the same page. Details, headless configuration and storage locations are in the [plugin README](packages/dsh-plugin/README.md).

The connector makes an outbound WebSocket connection and opens no network listener. Model-provider keys remain on the DSH host and are excluded from the connector's environment.

A real model provider must already be configured on the DSH host for live-generation acceptance. Never paste provider secrets into this repository, browser chat, test fixtures or public issue reports.

## Control semantics

- Each account owns multiple instances and multiple authenticated controller sessions
- Every instance has one current writer; other controllers can observe. A different controller must explicitly take over
- A lease lasts 30 seconds. Foreground clients renew it. Takeover is not active until the connector and host acknowledge the new fence
- Commands carry instance, connection generation, lease generation, deadline and stable idempotency ID. The server derives ownership from authenticated credentials
- A command receipt means dispatch/acceptance, not model turn completion. A transport interruption can yield `indeterminate`; clients must not blindly resubmit with a new ID
- Cold session inspection uses actual passive inspect/page/projection APIs. Viewing a session must not activate pending work
- Explicit resume is a writer operation. Steering takes effect at the next step boundary; it does not interrupt an already executing tool/model request
- Upstream model selection also updates the host's default asynchronously; this side effect is surfaced to users
- Approval buttons represent a live pending request bound to boot, session, presentation and call. Historical approvals are not actionable
- Uploaded file receipts belong to the same live DSH agent. A restart or disposal may require staging the file again

## API and authentication

Both clients use the same allowlisted command API. Web uses an HttpOnly, SameSite cookie; native clients use a bearer session bound to one controller. Owner IDs and controller impersonation are never accepted from command payloads.

See [API details](docs/api.md), [architecture](docs/design/architecture.md), [acceptance gates](docs/design/e2e-acceptance.md), and [verification](docs/verification.md).

## Cloudflare deployment

The same relay core also runs on Cloudflare Workers: a Worker serves the web console and a single SQLite-backed Durable Object holds relay state and every WebSocket. Registration can require an invite code. See [Cloudflare deployment](docs/deploy-cloudflare.md), including free-plan limits.

## Data and operations

The relay is deliberately a single-process SQLite service. Horizontal scaling is unsupported. The relay persists account password hashes, token hashes, command metadata/results, event history and pending approvals. Local conversations and attachments crossing the remote channel are sensitive user data: protect both relay storage and connector journals, configure disk limits/retention/backups before deployment, and never publish runtime databases.

`.data/`, `.env`, local toolchains, app build outputs and test auth state are ignored. Use synthetic content for public evidence. Never commit an instance token, provider key, session cookie or real conversation history.

## Repository access and instance observations

The backend exposes timestamped connecting/online/stale/offline status, plus an operator-configured read-only GitHub App integration and verified references to existing local Git worktrees. Authorization, local path declaration, and Host verification are separate states. Each selected reference is rechecked before metadata is admitted to a DSH user message; no credentials or repository file contents are injected. Automatic cloning and native OAuth initiation are not implemented. See [repository access](docs/github-repositories.md) and [instance status](docs/instance-status.md). Both clients implement these flows; hosted validation of this newer adoption snapshot is tracked separately.

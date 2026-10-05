# Deploying the relay on Cloudflare

The relay runs on Cloudflare Workers with no server to manage:

- **Worker** (`apps/server/cloudflare/worker.ts`) serves the web console as static assets and forwards `/api/*`, `/ws/*`, `/health` and `/github/*` to the relay.
- **One SQLite-backed Durable Object** (`RelayObject`) runs the same relay core as the Bun server (`apps/server/src/relay-core.ts`). Like the Bun process, it is the single writer for leases, fences and command admission and owns every live WebSocket. Its SQLite database stores accounts, instances, commands, events and approvals.
- Passwords use PBKDF2-SHA256 (WebCrypto, 100,000 iterations) because argon2 is unavailable in Workers. The Bun relay verifies both formats.

The Bun server (`bun run dev`) remains the local development and self-hosting path; both share the core and the test suite.

## Configuration

`apps/server/cloudflare/wrangler.jsonc`:

| Setting | Meaning |
| --- | --- |
| `routes` | Custom domain, e.g. `dsh.sqmem.top`. The zone must be in the same account |
| `REGISTRATION` | `disabled`, `enabled` (open sign-up) or `invite`. `invite` fails closed: without the secret, registration is off |
| `ALLOWED_ORIGINS` | Extra browser origins, comma-separated. The deployment's own origin is always allowed |
| `EVENT_RETENTION_DAYS` | Durable event history kept for replay (default 7) |

Secrets (never in the repository):

```sh
wrangler secret put REGISTRATION_INVITE_CODE -c cloudflare/wrangler.jsonc
# Optional read-only GitHub App, see docs/github-repositories.md:
# GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_SLUG,
# GITHUB_CALLBACK_URL (https://<domain>/github/callback), GITHUB_TOKEN_ENCRYPTION_KEY
```

## Deploy

```sh
bun install --frozen-lockfile
bun run build:web
cd apps/server
bunx wrangler login
bun run cf:typecheck
bun run cf:deploy
```

Local Workers runtime: `bun run --cwd apps/server cf:dev -- --var REGISTRATION:enabled`.

## Connecting clients

- Web: open `https://<domain>`. In invite mode, the sign-up form asks for the invite code.
- DSH plugin: `relayUrl: wss://<domain>/ws/connector`, with the instance's one-time connector token in `connectorTokenFile`.
- Flutter: use `https://<domain>` as the relay address.

## Free-plan limits

On the Workers Free plan, Durable Objects include 100,000 requests, 13,000 GB-s of duration and 100,000 SQLite row writes per day; operations past a limit fail until 00:00 UTC.

- **Duration:** WebSockets are not hibernated, so the object stays active while any host or client is connected. One object uses at most ~10,800 GB-s/day, which fits the allowance.
- **Row writes:** the binding limit. Every relay event is stored with its indexes, and the DSH plugin forwards each assistant streaming frame as an event, so long streamed replies dominate. Host heartbeats are written at most once a minute and old events are pruned daily. For sustained use, move to Workers Paid, or batch stream frames before they are stored.
- **Scale:** a single object is the relay's consistency boundary, matching the single-process Bun design. Sharding per account is a possible future step.

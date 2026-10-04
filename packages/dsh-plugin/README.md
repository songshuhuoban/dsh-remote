# DSH plugin and Bun connector

Pinned Host: DeepSeek Harness `0.2.1-alpha.1`, upstream commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`.

This package is a real Cordis plugin. Its small Host entry runs inside DSH's supported Node runtime and owns a Bun subprocess over private JSONL stdin/stdout. The Bun process makes the outbound authenticated WebSocket connection; no additional local HTTP listener is opened. DSH itself is not claimed to run on Bun. Controlled-instance hosts currently require POSIX credential-file protection (tested on Linux); Windows Host activation fails closed until a verified Windows credential/ACL adapter is implemented. This restriction concerns the controlled DSH Host, not the Flutter client's target platforms.

## Build and load

From this repository, run `bun install`, then `bun run --cwd packages/dsh-plugin build`. Configure an absolute overlay with the built `packages/dsh-plugin/dist/index.js` as the plugin `name`, or install a built package through `dsh plugin --profile web add /absolute/path/to/packages/dsh-plugin`. The manifest declares a DSH bundle. Restart DSH after adding it.

The plugin's config requires:

- `relayUrl`: `wss://your-relay/ws/connector`; plain `ws://` is accepted only for loopback testing
- `connectorTokenFile`: absolute owner-only credential file for this exact relay instance, inside a private directory (0600 file / 0700 directory on POSIX); store the token without a trailing newline
- `connectorPath`: absolute path to `packages/connector/src/index.ts`
- `journalPath`: absolute private SQLite path for this instance only
- `bunPath`: executable path, or `bun` on the DSH process's PATH
- `allowedWorkspaceRoots`: explicit absolute workspace directories; symlinks are canonicalized
- Optional `allowedPermissionPresets`: default `workspace-write`, `read-only`
- Optional `allowedAgentPresets`: default empty; current-session preset writes are disabled until explicitly configured
- Optional `approvalTimeoutMs`: default 600000

The bundled overlay reads `DSH_REMOTE_RELAY_URL`, `DSH_REMOTE_CONNECTOR_TOKEN_FILE`, `DSH_REMOTE_CONNECTOR_PATH`, `DSH_REMOTE_JOURNAL_PATH`, `DSH_REMOTE_BUN_PATH`, and `DSH_REMOTE_ALLOWED_ROOTS` (a JSON array). Inline credentials are refused so DSH configuration introspection cannot reveal them. The credential is loaded inside the Host shim and sent only over private child stdin and the authenticated relay connection. Ambient model keys are scrubbed from the child environment. Do not commit configuration containing real credentials.

## Behavior limits

- Listing and reading include permitted live and persisted sessions and do not activate a cold Agent. Explicit resume is a write action. There is no global “selected session” in DSH: client selection changes only the viewed session.
- Queue starts another turn. Steer is consumed at the next step boundary and does not interrupt an in-flight model request or tool. Cancel is a separate operation.
- `model.select` uses the real DSH method, which also saves its default model. Agent presets can change only before the first turn. Permission changes use DSH's `/permission` command, a configured allowlist, and optimistic session revision.
- No arbitrary shell, arbitrary RPC, credential export, plugin installation, raw YAML/profile write, or unrestricted settings write is exposed.
- Approvals require the current boot ID, session ID, random live approval ID and exact presentation hash. They are one-shot, expire, and fail closed when cancelled or unloaded. An outage leaves a request pending until its timeout; reconnection republishes it.
- Text-file uploads yield same-Agent receipts. Image intake uses DSH's native prompt admission; `attachment.read` checks that the session log references the image. Upload transport is bounded to 6 MiB encoded per attachment and 8 MiB frames.
- Durable events have stable session/sequence identities. Streaming tokens are transient and are not replayed after a lost process; canonical session pages restore settled text. `session.read` returns a 100-message window, cursor, and `hasMore`; use `session.page` for older records.
- Source entry validation is shared with the relay. Mutation admission checks the currently acknowledged writer fence immediately before calling the DSH public method. A method admitted before a transfer may finish afterwards; a new fence does not cancel the old turn automatically.
- The connector keeps command identities/results durably. A crash after admission but before result storage is reported indeterminate instead of blindly executing it again. Never change its journal to another instance.

## Verification

`bun test packages/dsh-plugin/tests/adapter.test.ts` runs focused adapter safety tests. This alone does not prove the product workflow.

Prepare the official source checkout with `bash packages/dsh-plugin/scripts/bootstrap-upstream.sh`. It defaults to `.tools/dsh-upstream`; `DSH_UPSTREAM` may point to an existing pinned checkout. It installs lockfile dependencies with lifecycle scripts disabled. Linux x64 uses the same-version official native npm package for its ignored binary outputs; other platforms need the upstream build's Node headers/compiler prerequisites.

Then run `bun run --cwd packages/dsh-plugin build` and `bun packages/dsh-plugin/tests/runtime-smoke.ts`. The runner boots the real shipped DSH `web` profile, the actual plugin, Bun sidecar, authenticated relay, real session controllers/agent loop/attachment storage/approval service/persistence. Only the external model endpoint is replaced by upstream's scripted Messages HTTP server. A test-only plugin exercises the real approval waterfall with an isolated file side effect. The source-only overlay disables generated Typert/browser artifact loaders; installed production DSH uses its normal built artifacts. It does not modify upstream source.

For the real browser/DOM client fixture, set `DSH_E2E_PORT=3108 DSH_E2E_KEEP_RUNNING=1`; the runner serves `apps/web/dist`, prints only synthetic loopback test credentials, and stays up until SIGINT/SIGTERM.

### Live provider gate

Live-provider testing is separate and never runs in the default tests. After explicitly authorizing provider use and setting an operator-owned `DEEPSEEK_API_KEY` (and optional `DEEPSEEK_BASE_URL`), run `LIVE_PROVIDER_E2E=1 bun packages/dsh-plugin/tests/runtime-smoke.ts`. Missing prerequisites fail with `BLOCKED`; they do not produce a green skipped run. The variant uses the actual provider and caps output at 512 tokens per request with thinking disabled. This is a per-request cap, not a monetary budget; configure the provider account's spending limit separately. The runner does not collect or print the key. Results go to `docs/live-provider-result.json` only after successful execution.

The current checked-in evidence is the local-model real-harness lane. It does not certify a paid live model, Chromium rendering, mobile simulator, or production deployment.

# DSH Remote plugin

Pinned Host: DeepSeek Harness `0.2.1-alpha.1`, upstream commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`.

A Cordis plugin that connects a DSH computer to a DSH Remote relay, so the web console and the mobile app can watch and control its sessions. Everything is managed from DSH's **Plugins** page; no terminal, environment variables or credential files are needed.

## Install and pair

1. In DSH, open **Plugins → Add plugin** and paste the release tarball URL, for example `https://github.com/songshuhuoban/dsh-remote/releases/download/dsh-plugin-v0.2.0/dsh-remote-plugin-0.2.0.tgz`. Enable it. (DSH `0.2.1-alpha.1` may fail to reload a newly enabled plugin live on Windows; restart DSH once if its page does not appear.)
2. In the relay console, choose **连接新实例** (or **配对** on an offline instance) and copy the pairing link. It works once and expires after 10 minutes.
3. On the plugin's page in DSH, paste the link and choose **配对**. The status turns to **已连接**.
4. Add the workspace folders remote devices may use. Sessions outside them are invisible and cannot be created remotely.

Pairing, unpairing and folder changes are accepted only from a browser on the DSH computer itself; remote browsers see the page read-only.

## How it runs

- **Credential.** Pairing exchanges the one-time code for this computer's connector token and stores it, with the relay address and instance, as a record in DSH's credential store (`$DSH_HOME/.credentials.yaml`, owner-only). It never enters profile YAML or the browser. Pairing again replaces it; the relay revokes the previous token.
- **Policy.** Workspace folders and the permission/agent preset allowlists live in `$DSH_HOME/dsh-remote/settings.json` and apply to the next permission check without a reconnect.
- **Connector.** A bundled connector (`dist/connector.js`) runs as a private child process of DSH's own runtime (Node, or Electron in Node mode on desktop), with secrets and `DSH_*` variables removed from its environment. It opens no listener, keeps a per-instance SQLite journal in `$DSH_HOME/dsh-remote/`, and honours `HTTPS_PROXY`.
- **Status.** The page shows connecting, connected, credential rejected (pair again) or relay unreachable, and offers reconnect and unpair.

## Headless and development setups

A profile may instead configure the row directly, which locks the corresponding fields on the page:

- `relayUrl` + `connectorTokenFile`: manual connection with a token saved in an owner-only file inside a private directory (POSIX 0600/0700; not supported on Windows). Inline tokens are refused.
- `allowedWorkspaceRoots`, `allowedPermissionPresets`, `allowedAgentPresets`: non-empty lists override the page.
- `journalPath`, `approvalTimeoutMs` (default 600000).
- `connectorPath` + `bunPath`: development only; run the connector source with Bun instead of the bundled build.

`cordis.patch.yml` inserts the row with no configuration. The repository test runners add rows like this through `--patch` overlays.

## Build

```sh
bun install --frozen-lockfile
bun run --cwd packages/dsh-plugin build   # dist/index.js, dist/connector.js, dist/client.js
cd packages/dsh-plugin && npm pack        # installable tarball
```

`@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are peer dependencies resolved to DSH's own copies. The browser half (`dist/client.js`) is a single script in DSH's client-module format; it relies only on `react` from the page. Tagging `dsh-plugin-v<version>` publishes the tarball as a GitHub release (`.github/workflows/release-plugin.yml`).

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

## Existing GitHub repository references

`repository.inspect` is a writer-lease-gated, offline inspection of a pre-existing local checkout. The relay resolves a user-owned, instance-bound reference ID to its canonical path and expected GitHub URL. The Host requires the exact working-tree root within `allowedWorkspaceRoots`; it does not discover parent repositories, clone, fetch, check out branches, or use GitHub credentials. A successful local inspection establishes a usable local mapping, not a GitHub OAuth grant. Manual mappings remain labeled manual.

Before each prompt, the Host rechecks up to eight selected mappings and appends only the reference ID, repository name, canonical local path, branch, local HEAD object ID and canonical GitHub link. The section explicitly marks all values as untrusted metadata. No README, instructions, file contents, raw remote configuration, credentials, hooks or credential helpers enter this section. The Host strips the relay-only reference field before calling DSH. All mappings are rechecked synchronously after asynchronous Git inspection, and the writer fence is checked again immediately before prompt admission.

Inspection runs fixed Git arguments without a shell, with bounded output, a timeout and a scrubbed environment. Git metadata must also stay within the allowed roots. Path traversal, symlink aliases, configuration includes, `core.worktree` redirects, non-files ref storage, credential-bearing origins and unsafe branch display strings fail closed. Linked worktrees work when their shared Git directory is also inside an allowed root. Inspection resolves local HEAD refs without reading object contents or triggering partial-clone lazy fetching; it is not an object-integrity audit or a cleanliness check. Supported origins are credential-free GitHub HTTPS, `git@github.com:owner/repo.git`, and `ssh://git@github.com/owner/repo.git`; returned links always use HTTPS. Branch display names are limited to 255 ASCII letters, digits, dots, underscores, slashes and hyphens, with Git-invalid patterns rejected.

An operator must prepare private checkouts through their existing secure local Git workflow. This version deliberately does not deliver GitHub tokens to hosts or claim that any repository has been cloned.

## Verification

`bun test packages/dsh-plugin/tests/adapter.test.ts` runs focused adapter safety tests. This alone does not prove the product workflow.

Prepare the official source checkout with `bash packages/dsh-plugin/scripts/bootstrap-upstream.sh`. It defaults to `.tools/dsh-upstream`; `DSH_UPSTREAM` may point to an existing pinned checkout. It installs lockfile dependencies with lifecycle scripts disabled. Linux x64 uses the same-version official native npm package for its ignored binary outputs; other platforms need the upstream build's Node headers/compiler prerequisites.

Then run `bun run --cwd packages/dsh-plugin build` and `bun packages/dsh-plugin/tests/runtime-smoke.ts`. The runner boots the real shipped DSH `web` profile, the actual plugin, Bun sidecar, authenticated relay, real session controllers/agent loop/attachment storage/approval service/persistence. Only the external model endpoint is replaced by upstream's scripted Messages HTTP server. A test-only plugin exercises the real approval waterfall with an isolated file side effect. The source-only overlay disables generated Typert/browser artifact loaders; installed production DSH uses its normal built artifacts. It does not modify upstream source.

For the real browser/DOM client fixture, set `DSH_E2E_PORT=3108 DSH_E2E_KEEP_RUNNING=1`; the runner serves `apps/web/dist`, prints only synthetic loopback test credentials, and stays up until SIGINT/SIGTERM.

### Live provider gate

Live-provider testing is separate and never runs in the default tests. After explicitly authorizing provider use and setting an operator-owned `DEEPSEEK_API_KEY` (and optional `DEEPSEEK_BASE_URL`), run `LIVE_PROVIDER_E2E=1 bun packages/dsh-plugin/tests/runtime-smoke.ts`. Missing prerequisites fail with `BLOCKED`; they do not produce a green skipped run. The variant uses the actual provider and caps output at 512 tokens per request with thinking disabled. This is a per-request cap, not a monetary budget; configure the provider account's spending limit separately. The runner does not collect or print the key. Results go to `docs/live-provider-result.json` only after successful execution.

The current checked-in evidence is the local-model real-harness lane. It does not certify a paid live model, Chromium rendering, mobile simulator, or production deployment.

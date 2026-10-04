# dsh-remote: end-to-end acceptance contract

Status: required tests, **not executed results**. All boxes below are initially unchecked. A passing architecture review or mock-only UI demonstration does not satisfy this contract.

## 1. Test levels and honest result language

Record each level independently:

1. **Static/unit**: type checks, schema validation, reducer/lease/idempotency tests. Useful, not E2E.
2. **Real transport integration**: actual Bun backend + real SQLite + actual Bun connector transport. A fake DSH adapter can test protocol failure handling here; label it clearly.
3. **Deterministic real-DSH E2E**: official pinned DSH launcher loads the installed Cordis plugin; a deterministic test model adapter replaces only model-provider responses. Real sessions, durable log, agent loop, queue, tools, approval service and attachment intake execute. This is reproducible runtime E2E, not a real-LLM pass.
4. **Live-provider E2E**: the same main flow with an actual supported model provider and authorized existing/test credentials on the DSH host. No prerecorded assistant response or fake session adapter. Provider usage is recorded without exposing credentials.
5. **Actual client acceptance**: Playwright or equivalent drives the TanStack web UI; Flutter integration_test or equivalent drives a running Android/iOS app. Widget tests and successful compilation alone do not establish mobile main-flow acceptance.

Delivery is "complete" only when required functionality passes levels 3, 4 and 5, with the negative/security/recovery gates below. If credentials, model service, emulator/device or platform toolchain are absent, mark the dependent stage **blocked / not run**, identify the exact missing prerequisite, and keep the result incomplete. Do not change a required case to optional because the environment cannot run it.

## 2. Fixture topology and evidence

Use synthetic content and temporary workspaces. Minimum topology:

- User A owns two independent DSH instances A1 and A2, each with a different home/workspace and distinctive files/content
- User B owns B1; no membership or sharing with A
- A has web and Flutter controller devices; a second browser profile supplies a third viewer where needed
- Actual backend database and connector journals persist across process restarts
- Real plugin loaded through the supported DSH launcher/profile mechanism, with the managed Bun child visible in the process tree
- A bounded local test tool asks approval through the real DSH approval service, then writes a random nonce to a temporary allowlisted fixture file only after approval
- One ordinary text file and one small image with precomputed hashes; filenames include Unicode and spaces

Evidence bundle includes exact application commit, DSH commit/version, Bun/Node/Flutter/browser/OS versions, command line without secrets, test commands and exit codes, run start/end timestamps, screenshots/video where useful, sanitized correlated command/event logs, before/after DSH durable records, and attachment byte hashes. Record runtime/provider level for every case. Do not publish tokens, cookies, passwords, machine paths containing private data, real prompt history or credential-bearing screenshots in a public repository.

A test report must distinguish passed, failed, skipped and blocked. Zero executed tests cannot be a green suite. A scripted runner exits nonzero on an unmet mandatory gate and reports blocked prerequisites explicitly.

## 3. Main-flow gate (run from each actual client)

| ID | Action | Required proof |
|---|---|---|
| MF-01 | Register/login, restart the client, authenticate as the same controller device | Real session/token validation; web HttpOnly cookie or mobile secure storage; no hard-coded identity |
| MF-02 | Create instance registration and configure/install its plugin locally | Token shown once; real plugin loaded; real Bun child establishes outbound connection; instance online only after hello/capability handshake |
| MF-03 | Browse A1 and A2 session lists including a persisted/cold session and subagent records | Matches the actual DSH stores; instance identities never mix; cold read does not start a model request |
| MF-04 | Open a session, paginate older records, inspect pending queue/status/model and redacted configuration | Real persisted history with stable order; visible fields match host state; secret sentinel absent |
| MF-05 | Acquire write control on A1, create a session in a locally registered workspace | Exactly one real DSH session exists with the receipt ID; session visible in local DSH and after restart |
| MF-06 | Send a normal message | Gateway receipt, connector admission, durable user event and actual assistant/tool response correlate by ID; UI shows streaming and terminal outcome separately |
| MF-07 | While a known step is active, send queue input then priority input | DSH inbox/order evidence establishes next-step priority; active step is not falsely shown as interrupted; both messages appear exactly once |
| MF-08 | Edit/reorder/remove a pending queue item within supported operations | Actual inbox projection and durable behavior match; claimed/nonexistent item produces explicit error, not silent success |
| MF-09 | Trigger a real approval, inspect exact action, allow it once | Pending request was emitted by live DSH service; exact temporary file/tool effect occurs once; durable decision audit matches |
| MF-10 | Trigger a second approval and reject it | Tool side effect does not occur; rejection reaches the real agent and UI |
| MF-11 | Upload text + image, attach to a prompt and submit | Hash of host-stored bytes matches source; receipt belongs to same session; real model/runtime receives the admitted attachment; meaningful model use tested in live-provider stage |
| MF-12 | Change allowed model/config values with expected revision | Real host value and returned revision change; effective timing and model default side effect are accurately shown; stale update fails |
| MF-13 | Cancel active work | Real agent reaches the appropriate cancelled/stopped state; no false "finished"; later new prompt remains usable |
| MF-14 | Close/reopen app or browser and reconnect during an active turn | Snapshot and replay reconstruct actual state; committed messages appear once; no fabricated continuation of obsolete token stream |
| MF-15 | Switch from A1 to A2 and back while events arrive | Correct session/instance routing and cache keys; no A2 content in A1; unsent text stays scoped to its draft |

Run the complete MF suite through the web UI and at least one real Flutter mobile runtime. If both Android and iOS are release targets, include both in the release matrix; passing on one does not verify the other.

## 4. Single-writer and multiple-device gate

- [ ] WR-01: A web controller holds A1; Flutter sees live history and holder name but cannot mutate without takeover
- [ ] WR-02: An authenticated device sends the other same-user device's controller ID; rejected before relay
- [ ] WR-03: Two devices race to acquire the same free instance; exactly one active holder results
- [ ] WR-04: Takeover invalidates old epoch; old buffered commands, renewal attempts and approval clicks fail; new holder is active only after connector fencing acknowledgement
- [ ] WR-05: Takeover while a model/tool action is already admitted does not silently cancel it; UI continues to show its actual status
- [ ] WR-06: Kill holder connection and wait through the configured TTL; another device can acquire, while old device's late renewal cannot revive its lease
- [ ] WR-07: Web holds A1 while Flutter holds A2; both can independently control their own instance
- [ ] WR-08: Backend restart preserves monotonic epochs; an old lease cannot be replayed as new
- [ ] WR-09: Instance offline during takeover is "pending/unavailable", not falsely active
- [ ] WR-10: Two sockets claiming the same connector credential cannot execute commands concurrently; older connection is fenced

## 5. Tenant isolation and authentication gate

For every test inspect both the HTTP/API response and the receiving connector/host log to prove rejection happened before effect.

- [ ] AU-01: B guesses A's instance, session, command, attachment, pending approval and event cursor IDs; each read/mutation/replay is denied without metadata leakage
- [ ] AU-02: A's connector attempts to register events/results for B's instance or session mapping; rejected
- [ ] AU-03: Anonymous/expired/revoked cookie or bearer receives no private snapshot or event, including immediately after WS upgrade
- [ ] AU-04: Cookie-auth HTTP mutations and WebSocket upgrades from unapproved Origin fail; allowed exact Origin works
- [ ] AU-05: Revoking a controller closes its sockets, disables its token and releases its lease; reconnect cannot regain access
- [ ] AU-06: Revoking/rotating connector token closes/fences prior connections and prevents new command dispatch with the old token
- [ ] AU-07: Login/register/pairing attempts are rate-limited; logs have no password/token; password database contains only adaptive hashes
- [ ] AU-08: Malformed, unknown-version, unknown-action and extra-authority-field messages fail schema validation; JSON prototype keys/nesting/oversize are bounded
- [ ] AU-09: Owner checks apply to attachment HEAD/range/download, command polling, pagination and event resets, not just list endpoints
- [ ] AU-10: Browser storage inspection finds no bearer/connector credential in localStorage, history URL, referrer or console

## 6. Replay, durability, idempotency and disruption gate

- [ ] RC-01: Repeat the exact create command after dropping the response; one DSH session and one original result
- [ ] RC-02: Concurrent identical prompt retries during async attachment admission; one inbox/durable user message and one associated model turn contribution
- [ ] RC-03: Reuse command ID with changed arguments or instance; conflict, with no effect of new arguments
- [ ] RC-04: Drop connector WAN connection mid-stream, continue DSH work, reconnect; authoritative final output and durable events reconcile once
- [ ] RC-05: Drop controller connection mid-stream; reconnect using saved cursor; correct ordered suffix, no duplicates in rendered state
- [ ] RC-06: Resume from an expired/unknown cursor; explicit reset and fresh snapshot, never silent event loss
- [ ] RC-07: Kill gateway after durable command insert and before send; recovery yields valid retry or terminal expiry according to current lease, never stale unauthorized execution
- [ ] RC-08: Kill connector after DSH side effect but before result persistence; create/prompt recover from real upstream evidence; other operations reconcile or report indeterminate instead of blind rerun
- [ ] RC-09: Restart DSH with an unconsumed file receipt and pending approval; old receipt/token does not become foreign authority; client gets explicit re-stage/stale response
- [ ] RC-10: Cold session detail/history read does not activate pending work; explicit resume does
- [ ] RC-11: Change agent lifecycle mid-stream; transient revisions/generations reset safely while durable seq remains authoritative
- [ ] RC-12: DSH local UI and remote controller both change state; projections reconcile and stale config revision is rejected
- [ ] RC-13: Bring gateway back after a long offline interval; obsolete prompts/approvals past expiry do not execute automatically
- [ ] RC-14: Disable plugin/reload Cordis; streams and Bun child close, pending approvals fail closed, no orphan subprocess reconnects

## 7. Approval-specific security gate

- [ ] AP-01: Two simultaneous approvals in different sessions; answering one cannot answer the other
- [ ] AP-02: A duplicated reply returns same decision/stale result and cannot produce a second tool effect
- [ ] AP-03: An allow reply races with tool abort/cancel; aborted request wins where already withdrawn, late reply is discarded
- [ ] AP-04: Restart plugin/host then replay previous allow token; denied by boot generation and missing live request
- [ ] AP-05: Change/reuse presentation hash, tool identity, session or call ID; denied
- [ ] AP-06: A read-only viewer or expired writer sends allow; denied before resolver invocation
- [ ] AP-07: Historical approval audit entry is read-only in web and Flutter; it has no active button/token
- [ ] AP-08: Disconnect with approval pending; no implicit allow on timeout/reconnect

## 8. Attachment, config and untrusted-content gate

- [ ] DS-01: Over-limit bytes, too many files and excessive concurrent uploads fail predictably without unbounded memory growth
- [ ] DS-02: Traversal/absolute/UNC/NUL/Unicode-confusable filename cases cannot choose disk paths; symlink escape is rejected
- [ ] DS-03: Cross-session/cross-instance/cross-user receipt substitution fails even with a known valid receipt ID
- [ ] DS-04: Incomplete/corrupted/hash-mismatched transfers never become usable receipts; retry/expiry frees temporary bytes
- [ ] DS-05: HTML/SVG/script-looking payload is displayed/downloaded without executing active content; external URL attachments cannot cause arbitrary backend/host fetch
- [ ] DS-06: Secret sentinel placed in DSH provider config, plugin secret field and environment never appears in settings wire payloads, events, errors, logs or generated public artifacts
- [ ] DS-07: Remote raw credentials/file/env/config-dump methods and forbidden config paths are rejected, even if an upstream API supports them
- [ ] DS-08: Redacted values are never submitted as actual secret replacements; expectedRevision conflicts preserve real secrets and existing values
- [ ] DS-09: Configuration native-open/plugin-install/sandbox/auth changes are excluded unless explicitly added with separate policy and tests
- [ ] DS-10: Tool/prompt text containing control-envelope-looking JSON or "approve all" is inert rendered content
- [ ] DS-11: Registered-workspace selection is enforced; arbitrary cwd and symlink traversal cannot widen visibility or execution scope

## 9. Performance and lifecycle gate

Declare the tested hardware, concurrency, payload and thresholds in the report; do not claim arbitrary scale.

- [ ] OP-01: Slow controller and high-rate model stream respect queue byte/count bounds; reconnect/reset recovers authoritative state
- [ ] OP-02: A slow attachment transfer cannot indefinitely block approvals, cancel or heartbeat messages
- [ ] OP-03: Multiple independent sessions remain responsive while one session is awaiting tool/approval/model I/O
- [ ] OP-04: Gateway/connector memory stabilizes over a bounded soak at the declared workload; per-user/disk quotas are enforced
- [ ] OP-05: NAT/outbound-only requirement is demonstrated with no externally listening connector port; if tested only on loopback, report loopback verification separately from actual network reachability
- [ ] OP-06: SQLite foreign keys, transactional leases, busy behavior, backup/restore and single-process guard are verified
- [ ] OP-07: Flutter background/resume, screen lock/network change and process termination recover without repeating a send; web refresh/back/forward/two-tab behavior is consistent
- [ ] OP-08: Accessibility labels, disabled/pending states and explicit confirmation/takeover controls exist in both clients; receipt means accepted, terminal response means completed

## 10. Release decision template

- Application commit:
- DSH commit/version:
- Toolchain and platform matrix:
- Runtime integration mode:
- Actual model provider and model (no credential):
- Web E2E result:
- Flutter Android E2E result:
- Flutter iOS E2E result (if targeted):
- MF/WR/AU/RC/AP/DS/OP passed, failed, blocked counts:
- Known behavior differences from architecture:
- Evidence paths / CI run URLs:
- Blocking prerequisites and exact smallest next action:
- Overall: incomplete / accepted for stated local test scope / release candidate

"Release candidate" additionally requires internet-facing auth/abuse policy, TLS/origin/cookie configuration, secrets handling and deployment packaging to be reviewed. Local E2E completion alone does not authorize deployment, creation of real access grants, or use of production credentials.

# Interaction transition model

This is a bounded **simulation specification**, not a formal distributed-system proof. `model.mjs` owns transitions; `app.mjs` renders that model and provides deterministic synthetic outcomes. No timeout silently retries a mutation.

## Invariants represented in the prototype

1. A signed-in controller can write only when the selected instance is online, its writer state is `writer`, and no instance operation is pending
2. Acquisition/takeover first enters `pendingAck`. Only the matching request ID and current authentication epoch can grant writer state
3. Switching instances or sessions does not move a pending response to another instance/session
4. Disconnect, stale status, logout and revocation remove local write authority. Replayed events do not reacquire it
5. A dispatched mutation that fails, times out or is abandoned becomes `indeterminate`. Its stable original ID is retained; new mutations are blocked until query reconciliation
6. Approvals are actionable only while live and bound to the current request. An expired or historical card has no allow/deny controls
7. Viewing cold history never resumes it. Resume is an explicit writer mutation
8. Repository authorization, instance binding and verified local readiness are separate. Unknown or stale local readiness prevents reference injection at send time
9. A late verification response after disconnect or an authentication epoch change cannot restore ready state
10. Credentials never enter any simulated message or reference context; repository text is untrusted input

The real backend must additionally enforce tenant ownership, boot/connection generations, current fence, lease validity, request deadlines, canonical roots and approval identifiers. UI gating is not a security boundary.

## Transition / recovery table

| Starting state | Action / next state | Success | Fail / timeout | Safe exit |
|---|---|---|---|---|
| Signed out / revoked | Simulate login → signing in | Signed in, observer | Signed out with retry | Cancel ignores late login result |
| Instance absent | Register → offline record | Explicit connection → connecting → online | Offline; record retained | Close pairing, reopen from instance list |
| Online observer | Acquire / confirmed takeover → pending ACK | Matching host ACK → writer | Observer or denied; owner retained | Stop waiting; late ACK ignored |
| Writer | Release | Observer; other readers unaffected | No spinner in this synthetic action | Continue viewing |
| Writer | Open cold session | Still cold and passive | Existing history retained | Select another session |
| Cold session + writer | Resume → pending mutation | Live session | Indeterminate original command | Stop waiting, query original result |
| Writer | Create / config / send | Confirmed result | Indeterminate original command | Cancel wait, retain draft, query |
| Running turn | Steer / queue | Boundary note / queue entry | Indeterminate original command | Query; don't resend |
| Queue entry | Edit / delete | Updated / removed entry | Original data retained | Close editor or query original operation |
| Pending approval | Allow once / deny | Terminal approval | Unknown command, not fresh approval | Query; stale cards stay non-actionable |
| Upload absent / failed | Add sample / retry → uploading | Ready | Failed with retained draft | Cancel / remove / retry |
| Online + active mutation | Disconnect | Offline + observer + unknown result | N/A | View retained data; reconnect |
| Offline / stale | Reconnect → replaying | Online observer | Offline, retryable | Stop waiting; retain last snapshot |
| Unknown result | Query existing ID | Reflect original result once | Still unknown | Retry read-only query or navigate away |
| GitHub disconnected | Consent simulation → authorizing | Authorized repo metadata | Reauth / timeout | Cancel ignores late callback |
| GitHub unconfigured | Open connection help | Administrator guidance | No endless login loop | Return without entering credentials |
| Authorized repo list | Search/select multiple | Selection only | Empty list / inaccessible grant | Clear search, return / reconnect |
| Selected repos + target writer | Bind explicit local paths | Declared local refs | Validation remains pending | Cancel path dialog |
| Declared/stale ref | Check local path + remote → checking | Verified/ready | Retained ref + error | Cancel check, inspect path, retry |
| Ready ref | Add to draft | Removable reference chip | Nonready ref cannot attach | Preview context / remove |
| Ready ref later stale | Send | Blocked until recheck/remove | No injection | Recheck local worktree / remove chip |
| Connected GitHub | Disconnect grant confirmation | Grant disconnected; local files untouched | N/A in simulation | Cancel confirmation |
| Current device | Revoke confirmation | Revoked + signed out | N/A in simulation | Cancel before confirming |

“Cloning” in the test drawer is a **future-design-only state**. It has bounded failure/cancel behavior but is not a backend-supported operation. The production reference flow verifies existing local worktrees.

## Wait bounds and timer ownership

- Authentication, GitHub authorization, instance commands and local-reference checks each carry an explicit synthetic deadline of 8,000 ms
- The timeout tick runs independently of modal visibility or current route; closing or changing a view cannot leave a pending spinner forever
- Replies are matched by request ID; authentication epoch protects logout/revocation; instance generation protects disconnect-sensitive local verification
- Dismissing a dialog that owns a submitted command stops waiting and makes its result unknown. Closing unrelated Settings does not cancel a background operation
- A retry button starts a new attempt only for a read/query, authorization handshake or safe staging/verification step. Dispatched non-idempotent commands are reconciled by original ID, rather than blindly retried
- User decisions (for example an approval prompt) intentionally have no fabricated auto-approve deadline. Expiry comes from the host; the test drawer can simulate it

## What is and is not established

The local tests exercise concrete safe-return and failure paths. In particular they assert no local pending state remains after its deadline, stale responses cannot reclaim writer state, and query reconciliation does not enqueue a duplicate command. They do **not** exhaust arbitrary interleavings of the relay, connector, host, native client, OAuth provider and browser.

Browser suites are authored separately for layout, focus, touch-sized viewports, modal dismissal and screenshot evidence. They must run in a permitted browser environment before claims about rendered UI can be made. Backend protocol tests and live-provider E2E remain separate from this prototype.

# Security review and bounded verification

This reviews an in-progress local tree on 2026-10-04. It is not a production security certification, real-DSH E2E report, live-model pass, or native-mobile pass. Final release evidence must rerun the required suite on a fixed commit.

## Reproduced defects and passing rechecks

1. Initial loopback/in-memory SQLite probes reproduced registration enabled by default, offline lease activation, and a lease surviving logout. Recheck: default registration 403; offline lease 409; withheld connector acknowledgement 409/FENCE_PENDING; mutation while fence pending 409; acknowledged lease 200/pending=false; logout expires lease and old token returns 401. [Results](evidence/relay-security-probe-recheck.json)
2. Real Bun relay plus actual Bun connector subprocess, with a synthetic Host stdio stand-in: a result completed during the relay outage is journaled and reported after reconnect; identical retry retains succeeded state; Host dispatch count is one. This tests transport recovery only. [Results](evidence/connector-reconnect-probe-recheck.json)
3. A pending-approval replay defect initially resurrected settled UI state. Recheck after transactional deduplication: request→1 pending, settled→0, duplicate request→0. No actual DSH tool grant was involved. [Results](evidence/approval-replay-probe-recheck.json)
4. An adapter timing race initially admitted a mutation after its fence changed during asynchronous inspection. Recheck: the revoked command is rejected and synthetic Host dispatch count is zero. [Results](evidence/adapter-fence-probe-recheck.json)

All probes used loopback, temporary/in-memory stores, synthetic account details and random temporary credentials. They did not provision real accounts or deployment credentials.

## Implemented validation and tests

`packages/protocol/src/validation.ts` is the shared strict decoder, covering source-shaped prompt content, QueueAction, SessionAddress/history windows, image/file base64, attachment reads, live approval identity/digest and settings revision. It rejects unknown authority fields, non-JSON/prototype/accessor values, oversized/deep structures, noncanonical base64, unsafe filenames and malformed nested content. Wire shape validation is separate from ownership, workspace, live-pending and policy checks.

The initial validator/relay run passed **80 tests and 326 assertions**. After the private credential-file fix, the combined shared-validator, relay, adapter and credential-file run passed **87 tests, with 1 Windows-only test skipped on Linux, 0 failures and 346 assertions**. The skipped Windows test is not a Windows pass. Root TypeScript checking and the Node-target DSH plugin bundle build passed. The adapter imports the same shared validator as the relay. Fixture tests do not count as real DSH acceptance. [Final test output](evidence/security-aggregate-final.log)

During this review the implementation also added instance/controller revocation, owner-namespaced caller command IDs, reserved gateway event kinds, trusted approval projection, bounded WebSocket send buffering, required Host fence acknowledgement, workspace-root filtering and live approval generation/presentation checks. These are scoped implementation observations, not blanket assurance.

## Remaining acceptance and deployment gates

- Run the complete installed-plugin real-DSH suite, real-provider suite, web UI suite and native Flutter suites; report each independently
- Verify final shared-validator wiring at both boundaries and rerun tests after later API or plugin changes
- Verify cumulative storage retention, transfer/disk quotas, slow-consumer behavior, auth abuse controls and load limits; an in-flight command limit alone does not establish production capacity
- Test backup/restore, schema upgrades, single-process ownership and database-level tenant constraints; do not claim DB-enforced isolation if only application predicates enforce it
- Verify the private `connectorTokenFile` flow, including symlink/owner/mode/size rejection and absence from DSH config introspection. Windows requires a tested ACL/OS-secret-store implementation; skipping POSIX checks is not a security guarantee
- Define operator account bootstrap, TLS reverse-proxy/cookie configuration, recovery and registration policy before internet deployment
- Preserve honest scope: current settings expose model/preset choices rather than every plugin namespace, and current attachments use bounded inline base64 rather than streaming uploads
- Treat DSH side-effect-before-result crash windows as operation-specific recovery/indeterminate states; never claim universal exactly-once execution

See the [complete acceptance contract](e2e-acceptance.md). Local checks do not authorize deployment, real-provider spending, new production access grants or release publishing.

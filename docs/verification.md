# Verification status

The requested complete end-to-end acceptance is **not complete**. The matrix below separates real execution from test doubles and unavailable environments. No mock DSH adapter ships in the application.

## Evidence as of 2026-10-04

| Lane | Result | Exact scope |
| --- | --- | --- |
| Root TypeScript and builds | Passed | Strict server/protocol/connector/plugin types, Node plugin bundle, production TanStack/Vite build |
| Protocol, auth, validators and plugin safety | 93 passed; 1 Windows-only test skipped; 0 failed | 371 assertions; synthetic connector/Host fixtures only in explicitly labelled protocol/unit tests |
| Real DSH pipeline | 14 assertions passed | Actual pinned Node DSH source profile, plugin, Bun connector, relay, SQLite, sessions, queue, tools/approval service and attachment storage; external model replies supplied by official deterministic local fixture |
| Three real DSH processes | 6 assertions passed | Two users, three authenticated controllers, A1/A2/B1 hosts, distinct stores with identical session IDs, real output isolation and independent fenced control; deterministic local model only |
| Web unit tests | 13 passed | API and session rendering/data helpers |
| Web rendered DOM + real relay | Passed | Registration, cookie transport, live sync, modal cancellation, instance creation, offline-write protection, controller view, logout |
| Web rendered DOM + real DSH | Passed | Real fixture topology; login, explicit takeover, create, prompt/durable reply, upload, queued-input edit/remove, model selection, exact live approval and release |
| Flutter analyzer/unit/widget | Passed | Analyzer zero issues; 9 default tests passed, 1 opt-in real-host test skipped there and executed separately |
| Flutter engine widgets + real DSH | Passed (42 seconds) | Real HTTP/WebSocket/relay/connector/DSH: paging, takeover, create, rendered reply, queue edit/priority/removal, bound approval, revisioned settings and same-controller restoration. Test-only ephemeral credential-store implementation; deterministic model only. Not an Android/iOS device pass |
| Native Dart + real relay | Passed | Auth, distinct controllers, instance registry, cross-tenant isolation, bearer WebSocket snapshot, logout revocation |
| Chromium actual browser UI | Blocked / not run | Both normal and admitted escalated local Chromium runs fail at `socket(AF_UNIX): Operation not permitted` before UI loads; cloud browser blocks localhost. Runnable browser specs are included for a suitable CI runner |
| Android/iOS device or simulator E2E | Not run | Requires a supported device/emulator; iOS build/signing additionally requires macOS/Xcode. No installed-app, Keychain/Keystore or native file-picker acceptance is claimed |
| Live model provider | Not run | Requires explicit authorized provider configuration/usage; no provider credentials were retrieved and no paid provider requests were made |
| Windows controlled DSH host | Unsupported / fails closed | Needs verified Windows ACL or OS credential-store support; POSIX checks are not silently skipped |
| Public repository / deployment | Draft engineering source / not deployed | Public repository created; this engineering source is a draft. Hosted CI results must be checked on the exact commit |
| DSH-native UI/UX prototype | Pending / not accepted | Current clients are functional drafts. A clickable prototype matching upstream style and audited recovery paths is the next design gate |

Toolchain: Bun 1.4.2, Node 24.19.0, TypeScript 5.9.3, Flutter 3.47.6 / Dart 3.13.5. The Linux DSH host was actually exercised. macOS POSIX source compatibility is not a tested macOS result.

## Real DSH main-flow evidence

`docs/runtime-smoke-result.json` records the 14 executed assertions:

1. Node DSH profile and actual managed Bun connector connect
2. Host acknowledges the writer fence
3. Two independent sessions are created and listed
4. Prompt, true next-step steering and durable assistant settlement
5. Repeated request ID produces one durable user message
6. Actual staged text-file upload and prompt admission
7. Actual model catalog/session projections
8. Live turn cancellation
9. Pending inbox edit, steer and removal
10. Image intake and session-authorized stored-pixel retrieval
11. Actual approval waterfall denies without the isolated side effect and allows it once, with durable audit
12. Actual model-selection write and durable configuration proof
13. Actual permission-preset write with optimistic revision
14. DSH process restart, passive cold history read and explicit resume

The approval fixture uses an isolated test-only pre-step request with a bounded file side effect to exercise the real approval service. It does not replace the production adapter. The source-only test overlay omits generated Typert and bundled DSH browser assets; it does not alter upstream source. That distinction remains visible in the evidence.

## Reproduce

- `bun install --frozen-lockfile`
- `bun run check`
- `bun run test:web`
- `bun run test:web:integration`
- Prepare the official pinned upstream with `bash packages/dsh-plugin/scripts/bootstrap-upstream.sh` (Node 24 and pnpm 11.7.0 required)
- `bun run test:runtime`
- `bun run test:topology`
- `bun run test:web:runtime`
- On a supported browser runner, `bun run --cwd apps/web test:browser` and `bun run --cwd apps/web test:browser:runtime`
- Flutter commands and exact evidence are in `apps/mobile/VALIDATION.md`

The live-provider variant is opt-in, fails explicitly when prerequisites are absent, and never runs in default tests or CI. See `packages/dsh-plugin/README.md`; its 512-token output cap is per request, not a monetary budget.

## Remaining acceptance and deployment work

The mobile historical-image view currently shows metadata/placeholders rather than fetched pixels; backend image admission/read is verified separately. Native file-picker and OS credential-store behavior remain device gates.

Run the [complete acceptance contract](design/e2e-acceptance.md) on a fixed source commit with authorized provider access and actual browser/native clients. Storage retention, cumulative quotas, backup/restore, single-process enforcement, abuse/load behavior and internet-facing TLS/account bootstrap still need deployment validation. Do not use local tests as a claim of production readiness, real-provider acceptance, native-device acceptance or universal exactly-once execution.

# Verification status

The requested complete end-to-end acceptance is **not complete**. The matrix below separates real execution from test doubles and unavailable environments. No mock DSH adapter ships in the application.

## Evidence as of 2026-10-04

| Lane | Result | Exact scope |
| --- | --- | --- |
| Root TypeScript and builds | Passed | Strict server/protocol/connector/plugin types, Node plugin bundle, production TanStack/Vite build |
| Protocol, auth, validators, GitHub flows and plugin safety | 133 passed; 1 Windows-only test skipped; 0 failed | 596 assertions in the reviewed local backend increment, including real temporary Git worktrees; protocol/GitHub network fixtures are explicitly labelled |
| Real DSH pipeline | 16 assertions passed | Actual pinned Node DSH source profile, plugin, Bun connector, relay, SQLite, sessions, queue, tools/approval service and attachment storage; external model replies supplied by official deterministic local fixture |
| Three real DSH processes | 6 assertions passed | Two users, three authenticated controllers, A1/A2/B1 hosts, distinct stores with identical session IDs, real output isolation and independent fenced control; deterministic local model only |
| Web unit/DOM-contract/style tests | 39 passed | Adopted DSH-native UI, catalog hydration, repository/context, state and recovery helpers |
| Web rendered DOM + real relay | Passed | Registration, cookie transport, live sync, modal cancellation, instance creation, offline-write protection, controller view, logout |
| Web rendered DOM + real DSH | Passed | Real fixture topology; login, explicit takeover, create, prompt/durable reply, upload, queued-input edit/remove, model selection, exact live approval and release |
| Flutter analyzer/unit/widget | Passed | Analyzer zero issues; 27 default tests passed, 1 opt-in real-host test skipped there and executed separately |
| Flutter engine widgets + real DSH | Passed (47 seconds after adoption) | Real HTTP/WebSocket/relay/connector/DSH: paging, takeover, create, rendered reply, queue edit/priority/removal, bound approval, revisioned settings and same-controller restoration, two repository references and metadata-only prompt context. Test-only ephemeral credential/journal-store implementations; deterministic model only. Not an Android/iOS device pass |
| Native Dart + real relay | Passed | Auth, distinct controllers, instance registry, cross-tenant isolation, bearer WebSocket snapshot, logout revocation |
| Chromium actual browser UI | Basic relay 2 passed; real DSH main flow 1 passed | Hosted run 37227512156 on commit 450c2bde passed real takeover, prompt/history/reload, attachment, model selection, queue, approval, cancellation and responsive checks. Earlier accessible-label regression was fixed with two tests. External model remains deterministic; prototype adoption must revalidate this lane |
| Android debug build | Passed on hosted runner | Flutter job in run 37226076284 built the debug APK after analyzer, default tests and real-DSH widget tests; this is not a device or secure-store pass |
| Android/iOS device or simulator E2E | Not run | Requires a supported device/emulator; iOS build/signing additionally requires macOS/Xcode. No installed-app, Keychain/Keystore or native file-picker acceptance is claimed |
| Live model provider | Not run | Requires explicit authorized provider configuration/usage; no provider credentials were retrieved and no paid provider requests were made |
| Windows controlled DSH host | Unsupported / fails closed | Needs verified Windows ACL or OS credential-store support; POSIX checks are not silently skipped |
| Public repository / deployment | Engineering branch published / not deployed | `engineering-base` is published; initial source c867556, prototype 4c415df and browser-label fix 450c2bd. No pull request or deployment is claimed |
| DSH-native UI/UX prototype | 54 local checks and 24 actual browser cases passed | Run 37226466567; representative pixels reviewed across desktop/mobile light/dark. Prototype simulation only; real-client adoption and mobile toast polish remain open |

Toolchain: Bun 1.4.2, Node 24.19.0, TypeScript 5.9.3, Flutter 3.47.6 / Dart 3.13.5. The Linux DSH host was actually exercised. macOS POSIX source compatibility is not a tested macOS result.

## Real DSH main-flow evidence

`docs/runtime-smoke-result.json` records the 16 executed assertions:

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
15. Two real existing Git worktrees mapped and inspected through the fenced Host
16. Verified repository metadata reaches durable DSH user-message and actual local-model request without repository file/config sentinels

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

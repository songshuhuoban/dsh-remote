# Mobile verification record

Verified 2026-10-04 with official Flutter 3.47.6 / Dart 3.13.5 on Linux. This record covers the reviewed-prototype adoption and its real native transport, not a native-device or live-provider release acceptance.

## Final unchanged-source checks

- Flutter analyzer: **zero issues**
- Default Flutter suite: **27 passed**, one opt-in real-host test skipped without its fixture
- Actual Flutter-widget integration against the real Bun relay, Bun connector and pinned upstream DSH Node Host: **1 passed in 47 seconds**
- Three actual headless Flutter captures inspected at **430 × 920**: [light conversation](evidence/conversation-light.png), [dark conversation](evidence/conversation-dark.png), [repository context preview](evidence/context-preview-light.png)
- Deterministic portrait layout/interaction coverage at **390 × 844**, in light and dark themes, reported no overflow

Logs: [analyzer](evidence/analyze.log), [default tests](evidence/default-tests.log), [real host](evidence/real-host-widget.log). Source hashes are recorded in `evidence/source-sha256.json`.

## What passed

The actual-host widget test drives sign-in; passive session list and backwards history; explicit writer takeover; UUID session creation; GitHub-unconfigured/native-web-connect guidance; actual local repository list and fenced verification; two reference selections and metadata preview; a prompt with top-level repository IDs; durable metadata-only context in actual DSH history with no fixture file/config secrets; real assistant output; queue edit, next-step prioritization and removal; request/boot/hash-bound approval; revision-checked permission update; and restoration with the same authenticated controller identity.

Default tests cover the existing URL/TLS, lease, approval, stream and history rules plus:

- Authoritative stale state overrides a cached online flag and blocks writes before POST; a disconnected stream remains read-only
- Repository inspect uses empty arguments and a top-level reference ID; prompts use unique top-level IDs, capped at eight, without raw repository context
- Declared/stale references cannot be attached; metadata preview is whitelisted and excludes credential/content fields
- Canonical local paths, explicit manual mapping, mapping-dialog cancellation, multi-GitHub selections across exact discovery pages, native OAuth limitation and empty/unconfigured recovery
- Drawer dismissal, draft/reference removal and stale-state editing leave mutation authority unchanged
- Submission uncertainty retains the original ID/body; a deterministic 4xx rejection becomes failed; a query 404 never resubmits
- The bounded OS-secure unresolved-command journal is saved before dispatch; write failure/full capacity reject safely without POST
- Store recreation restores original IDs and blocks fresh mutation IDs until reconciliation; journal records are account/server scoped and contain no attachment payloads
- Cancelling during journal persistence prevents dispatch and safely removes the known-not-dispatched entry

## Visual scope

The Flutter design adapts the approved prototype and pinned upstream DSH semantic colors and geometry: neutral light/dark surfaces, business blue, restrained text weights, a native drawer/header, conversation rows, warning approval cards, removable horizontal repository chips and a rounded composer. Error/status recovery is in the layout rather than overlaying composer actions. Native touch targets remain at least normal Material size.

The headless captures load official SDK Roboto/MaterialIcons and the installed Linux DejaVu Sans Mono because `flutter_tester` has no system font fallback. Theme captures wait for both theme and nested Material text transitions. This verifies a real Flutter renderer, not Android/iOS screen pixels.

## Boundaries and remaining checks

- The real-host test uses the upstream project's local scripted model endpoint. The launcher forces **LIVE_PROVIDER_E2E=0**; no paid/live provider was used
- The widget test substitutes only the OS storage boundary with ephemeral memory for credentials and the command journal. Actual Android Keystore/iOS Keychain persistence, locked-device behavior, platform lifecycle, native file picker and device accessibility require device testing
- Android SDK is unavailable locally, so the final adoption's APK build is delegated to hosted CI. A prior baseline APK build is not proof that this new source builds
- iOS compilation, signing and simulator/device execution require macOS/Xcode, unavailable here
- Live GitHub consent, deployment secrets, organization policy and callback acceptance were not performed. Native OAuth initiation is intentionally unsupported; connection must occur through the signed-in web app
- Historical image/file descriptors remain labels plus raw details; inline historical image thumbnails are not implemented
- Drafts and full submitted bodies are memory-only. Only bounded unresolved identifiers are journaled securely; restored commands have read-only query recovery and no payload retry. A 404 alone does not resolve a potentially in-flight command

## Reproduce

```sh
CI=true flutter analyze
CI=true flutter test
DSH_UPSTREAM=/absolute/path/to/prepared/upstream DSH_E2E_PORT=3188 tool/run_real_host_tests.sh
```

The isolated fixture launcher starts and stops its relay/connector/DSH host, uses a one-message history page to exercise paging, and writes ignored working evidence under `.tools/test-data`. Default app history pages contain 25 messages. In this restricted workspace the official Flutter source tool is compiled offline and uses workspace-local HOME/PUB_CACHE with CI mode and analytics disabled. No denied metadata endpoint or browser restriction was bypassed.

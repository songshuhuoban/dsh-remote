# Mobile verification record

Verified 2026-10-04 with official Flutter 3.47.6 / Dart 3.13.5 on Linux.

## Passed

- Flutter analyzer: **zero issues** on final source.
- Default Flutter suite: **9 passed**, with the separately exercised real-host integration test skipped unless its fixture is explicitly supplied.
- Actual Flutter-widget integration against the real Bun relay, Bun connector, and pinned upstream DSH Node Host: **1 passed in 42 seconds**. This is a full headless Flutter renderer and native Dart network path, not a UI mock or simulated adapter.
- Functional integration assertions: login; passive session list and older-history cursor page; explicit writer takeover; UUID-addressed session creation; prompt admission; rendered durable assistant answer; pending queue edit, prioritize-next-step, and removal; exact request/boot/hash-bound approval; revision-checked permission update; and restart restoration with the same authenticated controller identity.
- Independent native Dart HTTP/WebSocket smoke against an isolated real relay: registration, unique controllers, offline instance/token creation, same-account fleet visibility, cross-tenant list and direct-state isolation, authenticated authoritative WebSocket snapshot, and logout revocation.
- Unit coverage: remote HTTPS validation, active/expired/pending lease gating, command UUID uniqueness, indeterminate command outcomes, exact approval call-ID/tool-name binding, durable-history deduplication, and partial/duplicate stream chunks.
- A 430×920 headless Flutter render with actual SDK Roboto/MaterialIcons was inspected. It has readable chat cards and controls with no reported overflow. This is not a native-device screenshot.

The full functional test uses the upstream project's local scripted model endpoint, returning `REAL_DSH_PIPELINE_OK`. No paid/live provider is exercised. The fixture launcher explicitly forces `LIVE_PROVIDER_E2E=0` so an ambient environment setting cannot change that default.

## Not run / environment limits

- Android APK build and Android emulator/device execution: `flutter doctor -v` reports **Unable to locate Android SDK**. No SDK licenses were accepted and no Android SDK was installed.
- iOS compilation, signing, simulator, and device execution require macOS/Xcode, unavailable in this Linux environment.
- Actual Android Keystore / iOS Keychain persistence, native file-picker interaction, native app lifecycle behavior, and platform-specific visual QA remain unverified. Secure storage is implemented and configured; the widget integration substitutes only this OS boundary with ephemeral memory.
- A production live-provider DSH run is not claimed.

## Reproduce

```sh
flutter analyze
flutter test
# Real-host test after preparing the pinned upstream checkout:
DSH_UPSTREAM=/absolute/path/to/prepared/upstream tool/run_real_host_tests.sh
# Real relay transport smoke; this creates only synthetic test accounts/records:
dart tool/relay_smoke.dart http://127.0.0.1:3000
```

The real-host launcher starts and stops its isolated fixture itself, creates local ignored evidence under `.tools/test-data`, and runs Flutter with an explicit one-message page size to exercise backwards paging. The normal app page size is 25 messages.

In this restricted workspace, the official Flutter tool was compiled offline from its downloaded official source and invoked with CI mode, workspace-local HOME/XDG_CONFIG_HOME/PUB_CACHE, and analytics disabled. CI mode avoids the SDK's unrelated Azure metadata probe; network/security restrictions were not relaxed.

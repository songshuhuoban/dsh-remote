# DSH Remote mobile

A native Flutter Android/iOS client for the Bun DSH Remote relay. This app uses the real relay HTTP and authenticated WebSocket APIs; it contains no simulated relay or DSH adapter.

## Run

Install stable Flutter from <https://docs.flutter.dev/install>, then:

```sh
cd apps/mobile
flutter pub get
flutter run --dart-define=RELAY_URL=https://your-relay.example.com
```

For an Android emulator, use `http://10.0.2.2:3000` as the relay URL. For an iOS simulator, use `http://127.0.0.1:3000`. Local HTTP is for development. Production remote connections require HTTPS, with a valid certificate. An explicitly opted-in debug build can use a LAN HTTP address with `--dart-define=ALLOW_INSECURE_HTTP=true`; release builds ignore that override.

The relay disables public registration by default. Enable registration deliberately or provision the account on your server before signing in. A physical device needs a reachable relay address; its loopback address is not your computer.

## Implemented

- Registration/login, per-device controller identity, account/controller list, revoking sign-out
- OS-backed secure session storage and restart restoration via `/api/me`; passwords are never stored; the same authenticated controller identity is reused
- Multiple instances per account, one-time connector-token display, online/offline status
- Passive session list/read/projections, cursor-based older-history paging, and a real event stream
- Explicit control acquisition/takeover/release, 10-second foreground renewal of a current 30-second lease, acknowledgement-aware and epoch-fenced writes; local renewal/write admissions are serialized
- New UUID-addressed sessions, queue/steer prompts, cancellation and explicit saved-session activation
- Pending inbox editing, next-step prioritization, and removal through real DSH queue actions
- Rendered user/assistant/tool conversation cards, accumulating live text, expandable complete events and raw metadata
- Native file picker, bounded upload, attachment receipts included in prompts
- Provider/model selection, inspectable settings/catalogs, connector-allowlisted permission/agent presets with revision checks
- Exact request-bound, boot-bound, hash-bound approval decisions; authoritative pending-approval snapshots prevent stale approval replay
- WebSocket reconnect with cursor/deduplication, authoritative state reconciliation, foreground resume and no background lease renewal
- Server-confirmed command history with pending/failed/indeterminate outcomes; no automatic mutation retries

The primary view renders user, assistant, and tool text. Raw events, projections, and metadata remain available in expandable details. Older history uses the actual DSH page cursor. Queue prioritization moves messages to the next-step lane; this mirrors DSH’s supported queue action rather than inventing arbitrary positional ordering. The local live-event window is capped at 250 frames, with explicit history refresh and paging for durable content. Image/file content descriptors appear as labeled placeholders plus raw details; this version does not render historical image pixels inline.

## Security and native configuration

`flutter_secure_storage` uses Android Keystore-backed encryption and iOS device-only Keychain accessibility. Tokens never appear in WebSocket URLs, ordinary preferences, or logs. Android application backup is disabled. Use a properly signed iOS app so the Keychain entitlement matches your bundle identifier. No production credentials are included in the project.

The app does not override TLS validation. Debug cleartext networking is separate from release configuration. Registration and secure-storage APIs can fail visibly; there is no plaintext storage fallback.

## Validation

```sh
flutter analyze
flutter test
# Run only against an isolated relay with REGISTRATION=enabled:
dart tool/relay_smoke.dart http://127.0.0.1:3000
```

The network smoke test creates synthetic test users, separate controllers, and an offline instance in the supplied relay. It verifies real authentication, tenant isolation, bearer-authenticated WebSocket snapshots, and token revocation. It does not simulate DSH. Use a disposable database and delete that database after the test.

For CI bootstrap, use `CI=true` and disable Flutter analytics. Official Flutter's environment detection otherwise probes a link-local cloud metadata endpoint, which this workspace correctly blocks. Setting CI avoids that unrelated probe without relaxing network restrictions.

To exercise the actual Flutter widgets against the real relay, connector, and pinned DSH Host:

```sh
# First prepare the upstream source with the repository bootstrap instructions.
DSH_UPSTREAM=/absolute/path/to/prepared/dsh/source tool/run_real_host_tests.sh
```

This opt-in test uses a local scripted model endpoint, never a paid provider. It substitutes only the OS credential backend with ephemeral test memory; application HTTP, WebSocket, relay, connector, DSH sessions, approvals, queue mutations, and settings are real. Native Keystore/Keychain correctness must still be checked on a device.

See `VALIDATION.md` for the checks actually completed in this implementation environment and remaining native-device verification.

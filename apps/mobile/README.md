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
- Native adaptation of the reviewed DSH prototype: upstream-grounded neutral light/dark surfaces, business-blue actions, navigation drawer, restrained conversation rows and rounded composer
- Multiple instances per account, one-time connector-token display, authoritative connecting/online/stale/offline status and last-seen refresh
- Passive session list/read/projections, cursor-based older-history paging, and a real event stream
- Connecting takes control, as in remote-desktop clients: a free instance is acquired when its page opens, a lease this device still holds is resumed after a reconnect, and another device's control is only taken after confirming. "View only", releasing or being taken over leaves the instance watch-only for the rest of the app session. 10-second foreground renewal of a current 30-second lease, acknowledgement-aware and epoch-fenced writes; local renewal/write admissions are serialized
- New UUID-addressed sessions in a folder chosen from the Host's allowed folders, with breadcrumbs and a "Go to path" field that converts a pasted path to the Host's style (plugins without `workspace.browse` use their default folder and the app says to update the plugin, naming the package the relay serves), queue/steer prompts, cancellation and explicit saved-session activation
- Host paths follow the Host's own style (Windows or POSIX, from `workspace.list`'s `style`, else inferred from its folders) through `lib/src/host_path.dart`, a port of `packages/protocol/src/host-path.ts`; the phone's own path rules are never used
- Pending inbox editing, next-step prioritization, and removal through real DSH queue actions
- Rendered user/assistant/tool conversation cards, accumulating live text, expandable complete events and raw metadata
- Native file picker, bounded upload, attachment receipts included in prompts
- Provider/model selection, inspectable settings/catalogs, connector-allowlisted permission/agent presets with revision checks
- Exact request-bound, boot-bound, hash-bound approval decisions; authoritative pending-approval snapshots prevent stale approval replay
- WebSocket reconnect with cursor/deduplication, authoritative state reconciliation, foreground resume and no background lease renewal
- Server-confirmed command history with pending/failed/indeterminate outcomes; no automatic mutation retries
- Bounded OS-secure unresolved-command journal written before dispatch, retained across app/store recreation and sign-out, filtered by account/server, with original-ID read-only reconciliation
- GitHub status, installation/repository pagination and multi-selection after a same-account signed-in web grant; explicit native OAuth limitation; with no installation, "Install on GitHub" opens the App's installation page externally, and a single installation is used at once
- Manual existing-checkout mapping without GitHub setup; checkout folders are chosen in the Host's folder picker while the instance is online on a plugin with `workspace.browse`, typed (and converted to the Host's style) otherwise; separate authorization and declared/verified/stale host states; explicit fenced verification, removable message-reference chips (maximum eight), and metadata-only preview
- Sign-in cancellation, stop-waiting exits, dismissible in-layout errors, device revocation, and in-memory draft/reference preservation across screen navigation

The primary view renders user, assistant, and tool text. Raw events, projections, and metadata remain available in expandable details. Older history uses the actual DSH page cursor. Queue prioritization moves messages to the next-step lane; this mirrors DSH’s supported queue action rather than inventing arbitrary positional ordering. The local live-event window is capped at 250 frames, with explicit history refresh and paging for durable content. Image/file content descriptors appear as labeled placeholders plus raw details; this version does not render historical image pixels inline.

## Security and native configuration

`flutter_secure_storage` uses Android Keystore-backed encryption and iOS device-only Keychain accessibility. Tokens never appear in WebSocket URLs, ordinary preferences, or logs. Before any host write is dispatched, its account/server/instance/action/command ID is saved in a separate OS-secure journal (maximum 64 records / 32 KiB). Journal failure rejects the write before dispatch. Prompt text, attachment bytes and repository content are never persisted in this journal. Restored entries block new writes on that instance until the original result is reconciled; a 404 never triggers a new-ID retry. Confirmed success/failure removes its journal entry. Message drafts and complete submitted bodies remain in memory only. Android application backup is disabled. Use a properly signed iOS app so the Keychain entitlement matches your bundle identifier. No production credentials are included in the project.

The app does not override TLS validation. Debug cleartext networking is separate from release configuration. Registration and secure-storage APIs can fail visibly; there is no plaintext storage fallback.

## Releases

Pushing a `v<version>` tag (matching the version name in `pubspec.yaml` and the DSH plugin's `package.json`) runs `.github/workflows/release.yml`: it tests, builds the signed release APK and the plugin tarball, and publishes both, with `SHA256SUMS.txt`, as one GitHub release. Commits not yet on `main` become pre-releases. Bump the build number after `+` for every release so phones can upgrade.

The release key is created once by the owner: `powershell -ExecutionPolicy Bypass -File apps/mobile/tool/create-release-key.ps1` generates a PKCS12 keystore with a random password (JDK 17 `keytool`), keeps it in `~/dsh-remote-android-key`, and stores it in the repository's Actions secrets through `gh`. Keep that backup: every later APK must be signed with the same key. Release builds are signed only from `DSH_ANDROID_KEYSTORE`/`DSH_ANDROID_KEYSTORE_PASSWORD`/`DSH_ANDROID_KEY_ALIAS`; without them they stay unsigned, and the workflow refuses to publish.

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

## GitHub and local-reference boundaries

Connect GitHub in the signed-in web app for the same relay account, then refresh in the native app. Native OAuth initiation is deliberately unavailable: an external browser cannot share this client's nonce cookie. The native app never opens a broken authorization URL or requests a broader grant; it only opens the GitHub App's installation page (from `POST /api/github/install`) so the account owner can install it and choose the repositories it may read. An unconfigured GitHub deployment still supports manual references to existing checkouts.

GitHub authorization does not establish local availability. A writer explicitly verifies each path with `repository.inspect` and a top-level reference ID. A message submits up to eight top-level `repositoryIds`; the server and host recheck the worktree and add bounded untrusted metadata. The native client never sends raw repository context or an arbitrary inspect path. Expired GitHub authorization does not erase existing local files or independently invalidate a verified local worktree. There is no clone, fetch or checkout operation. Hiding a reference changes its selection preference only; removing a chip removes only that message's reference.

See the service contract in [GitHub repositories](../../docs/github-repositories.md), the [reviewed prototype](../../docs/prototype/README.md), and [native validation](VALIDATION.md). Native design remains an adaptation of the prototype; Flutter widgets, platform back navigation, secure storage and real transport remain native.

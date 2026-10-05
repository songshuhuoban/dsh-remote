# DSH Remote · Design-first clickable prototype

> **Synthetic interaction prototype.** No DSH backend, GitHub account, model provider, filesystem operation or real credential is used. This is a design review artifact, **not** a completed production interface, integration test or live-provider E2E result.

## Run

From the repository root, with Node 24+:

```sh
node docs/prototype/server.mjs
# Open http://127.0.0.1:4179 in a browser
```

This server binds only to loopback and serves this directory. No build or package download is required. Its Content Security Policy blocks outgoing connections, form submissions and frames. All actions only change browser memory; refresh resets the demonstration. Do not enter real credentials, private paths, or sensitive content.

The default screen is a signed-in observer. Use **演示账号 → 退出登录** to inspect sign-in, or **测试场景** to inject success, failure or an eight-second timeout. The test drawer also offers disconnect, expired approvals, stale instance status, expired/missing GitHub authorization and local-reference failures. All text and repositories are synthetic.

## Design direction

The product remains a Harness conversation, with remote operations fitting into its existing visual language:

- Left: the existing-style brand, New session, workspace/session tree, Settings and account seats
- Center: restrained header, centered transcript, tool row, bottom composer and an approval panel immediately above it
- Remote additions: instance selector, connection/observation status, separate writer status, and an explicit acquire/takeover action
- GitHub additions: a secondary repository surface, explicit per-instance local references, and compact removable reference chips inside the composer
- Mobile: the same conversation model with an overlay navigation drawer, wrapped composer controls, readable modals and safe-area padding

The mobile viewport is a **responsive web design reference**, not a rendered Flutter application. Native OAuth behavior must follow whichever safe native/web handoff the implementation actually supports; this prototype does not establish that native OAuth is available.

## Source-grounded appearance

Reference is the actual upstream checkout **DeepSeek Harness 0.2.1-alpha.1**, commit **5badb15009ae1756c3afe0ae0cef1faafc290ccc**. Source links below are pinned, not floating documentation.

| Decision | Upstream source | Prototype application |
|---|---|---|
| System text font, code font, radius scale | [ui-theme/base.css](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-theme/src/styles/base.css) | Exact copied sheet; system CJK-capable stack, 4/8/12/16/20/28px radius scale |
| Neutral light/dark surfaces and business blue | [ui-theme/design-platform.css](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-theme/src/styles/design-platform.css) | Exact copied semantic tokens. Actual pinned blue is `#4176e6` light / `#7aaaff` dark, rather than older comments' `#3964fe` / `#679efe` |
| Soft elevated surfaces, superellipse corners | [gradient-shadow-text.css](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-theme/src/styles/gradient-shadow-text.css), [corner-shape.css](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-theme/src/styles/corner-shape.css) | Exact sheets; circle/pill elements opt back into round corners |
| Brand font | [brand-font.css](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-theme/src/styles/brand-font.css) | Local Montserrat 300/400/500 with upstream OFL notice; no external font request |
| Sidebar / row density | [SidebarRoot.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-sidebar/src/client/SidebarRoot.module.css) | 12px side padding, 36px navigation rows, 38px new-session bar, muted surfaces |
| Conversation geometry | [ConversationRoot.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css) | 76px desktop header, centered conversation and composer axis; mobile adapted |
| Composer | [InputBar.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css) | 28px card radius, 28px attach circle, 34px blue send circle, permission/model controls |
| Queue dock and approval card | [QueueDock.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-conversation/src/client/queue/QueueDock.module.css), [ApprovalPanel.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-approval/src/client/ApprovalPanel.module.css) | Queue above composer; warning-colored 20px approval card, one-time actions |
| Existing product icons | [ui-primitives/icons/index.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-primitives/src/icons/index.tsx) | Copied existing SVG artwork at regular/medium proportions; no newly invented icon family |
| Settings visual reference | [Official provider settings screenshot](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/user/guide/providers-models-page.zh.png) | Source image inspected: neutral settings cards, restrained separators, black primary action, generous dialog radius |

Component guidance follows [upstream web styling](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/web-styling.md): semantic colors, 500-or-lower feature weights, visible keyboard focus, reduced motion, no independent dark palette. Layout is an adaptation, not a claim of pixel-identical upstream screens.

Copied upstream material retains its MIT notice in `vendor/DSH-LICENSE`. Font licensing is in `vendor/Montserrat-OFL.txt`. Nothing here implies official DeepSeek endorsement.

## Walkthroughs

1. **Observe → control**: default observer → 获取控制权 → pending ACK → writer. Use Linux 开发机 for explicitly confirmed takeover. Retry under failure and timeout, then cancel a pending request; a late result cannot unlock the composer
2. **Authentication / devices**: account → logout → simulated sign-in → observer. Cancel or time out sign-in. Revoke another device, then revoke this device through the confirmation dialog
3. **Instances**: list → detail → refresh observed status. Add instance → register → dismiss before connection → return and connect. Offline, connecting, online, synchronizing and stale are distinct; cached online status is not live evidence
4. **Sessions**: create; view existing history without resuming; explicitly resume as writer; change configuration after reading the model-default side effect
5. **Messages**: send → running → steer at next step boundary, or queue → edit → delete. Stop the simulated turn. Editing a queued draft survives pending rerenders
6. **Approvals**: test drawer → trigger approval → allow once or deny. Expire it or disconnect: the old card becomes non-actionable, even after reconnect
7. **Attachments**: failure mode → add sample attachment → failed → retry success / remove. Timeout and cancel leave a visible recoverable state and preserve the message draft
8. **Recovery**: timeout a submitted message → stop waiting → indeterminate result. Disconnect → replay → observer → query original operation ID. Query reconciliation updates the original result and never creates a duplicate mutation
9. **Repositories**: connect simulated GitHub → choose multiple repos → bind paths to current instance → explicitly verify local worktree → ready → add reference → review message context → remove. Repeat with failed verification, stale local reference, canceled authorization, expired grant, unconfigured service and no repositories
10. **Mobile / navigation**: repeat at 390×844; close drawer by backdrop, close modals by Escape/backdrop, navigate with browser history. No navigation action is meant to acquire control, resume a session, clone a repository or submit a message

More detailed transitions and escape paths: [transition model](TRANSITIONS.md).

## Repository design boundary

The implemented service contract is **GitHub App read-only authorization and metadata, plus references to existing local worktrees**. Its fields distinguish grant state from local state: `declared`, `verified`, `stale`; `cloningSupported:false`, `cloned:false`.

The default prototype follows that contract. Its internal display states `absent/checking/ready/error/outdated` mean declared, checking, verified, failed verification and stale respectively. An authorized repository is not automatically present on a DSH host. Verification checks must be on the selected instance under its writer lease, using host-allowed canonical paths and a matching GitHub remote; every real send must recheck the worktree.

**Optional future clone flow:** the test drawer contains “后续设计：模拟克隆” solely to review a future cloning/cancellation state. The backend does not currently clone, and no real clone occurs here. Do not wire that affordance into either production client until a separate authorized clone capability and its failure cleanup exist.

Context preview contains only repository identity, branch, instance-local path, readiness and a trust marker. It contains no token, password or authenticated remote URL. Repository content remains untrusted data, never authority for changing permissions or executing instructions.

## Verification, honestly scoped

Run from repository root after the normal project dependency install:

```sh
node --test docs/prototype/model.test.mjs
node --test docs/prototype/dom.test.mjs
node --test docs/prototype/style.test.mjs
node node_modules/@playwright/test/cli.js test -c docs/prototype/playwright.config.mjs
```

At the recorded local pass:

- **39 state-model tests passed**: ownership fencing, cancel/timeout, indeterminate commands, cold view, approval staleness, repository readiness, authorization and late callbacks
- **12 DOM tests passed**: visible recovery actions, real click handlers, modal dismissal/focus, preserving edited input, path-binding and context preview
- **3 style-contract tests passed**: semantic-token resolution, theme ownership, font-weight/focus/reduced-motion and viewport constraints
- **24 actual Chromium browser tests passed**: 6 walkthroughs × desktop/mobile × light/dark in [hosted run 37226466567](https://github.com/songshuhuoban/dsh-remote/actions/runs/37226466567), commit `4c415dfc06b9bc91ec5920e9ced8039737f1054b`. The run produced 40 state screenshots
- **Representative pixels reviewed**: 20 desktop/mobile light/dark screens were inspected, covering conversation, settings, instance status, approvals, repositories/context, queue, upload error, indeterminate result and revoked authentication. Core geometry and legibility passed. Mobile toasts can overlap sticky controls; client adoption must place them safely. A scrolled local-reference-row capture should supplement the repository screenshot

Evidence is in `evidence/*tests.tap` and `evidence/browser-test-discovery.txt`. Browser tests require an allowed Chromium execution environment such as the project's CI. Do not bypass local execution restrictions. Passing the reducer/DOM tests is **not a proof that deadlock is impossible**, nor backend, real OAuth, Flutter or live-provider E2E acceptance.

## Current implementation gaps and adoption gate

The current application was built as an engineering draft. This directory does not modify it:

- `apps/web/src/styles.css` currently uses DM Sans, forest-green/lime surfaces, 7px control radii and 600-weight labels; these differ materially from pinned DSH tokens and chrome
- Both actual clients need deliberate migration to the reviewed prototype, rather than equating their existing functional tests with design acceptance
- The prototype's pending/unknown/denied/stale states and corresponding recovery copy must be mapped to actual API outcomes, command IDs, boot IDs, fences and lease lifetime, not copied as client-side truth
- Actual operation deadlines must remain owned by protocol contracts. This prototype compresses waits to eight seconds for review; it does not replace the service's lease, heartbeat, staleness or command deadlines
- Authentication fields, provisioning policy, real GitHub grant security, canonical-path validation and native handoff require integration tests; the simplified demo sign-in cannot validate them
- True attachment byte progress, actual streaming/Markdown/tool rendering, native keyboard/voice behavior, accessibility screen-reader checks and real touch-target/pixel checks remain outside this simulation
- The four viewport/theme screenshot runs and product review are still required before applying the appearance to production clients; real-provider end-to-end acceptance remains a separate gate

No independent deployment, public site hosting or source publication is performed by this artifact.

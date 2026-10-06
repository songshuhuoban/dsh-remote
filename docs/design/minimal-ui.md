# Minimal UI rules

These rules apply to every DSH Remote interface: the web console (`apps/web`), the DSH plugin page (`packages/dsh-plugin/src/client`) and the Flutter app (`apps/mobile`). They take precedence over earlier visual decisions in the prototype.

## 1. Align left

- Every screen has one left edge. Headings, body text, forms, lists, empty states and dialog content start on it.
- No centered heroes or centered empty states. The only centered element is a full-screen loading spinner.
- Actions follow the content they act on, in reading order, starting at the left edge: primary first, then secondary. A row's own action may sit at the end of that row.

## 2. Say it once

- One entry point per action. Remove duplicate buttons for the same action, such as "new session" in both the sidebar and an empty state.
- Remove taglines, eyebrow labels (for example `READY WHEN YOU ARE`), decorative glyphs and illustrations, feature chips and marketing copy.
- Show a status in one place only. Do not repeat it as a pill, a tooltip and a sentence.
- Keep helper text only when an action is non-obvious, irreversible or security-relevant: credential exposure, revocation, takeover, local-only restrictions. One short sentence, no instructions the layout already makes clear.
- Prefer a precise label to a label plus explanation. Placeholders show examples of input format, not instructions.

## 3. One element per state group

- Different states of the same function are one element whose label, color and icon change. Examples:
  - Control: `获取控制权` → `确认中…` → `控制中` (activating releases control). When another device holds control, it reads `接管`.
  - Connection: one dot and word next to the instance name (`在线`, `连接中`, `离线`). No separate status pill or banner for the same fact.
  - Copy: the copy icon becomes a check for 1.5 s.
  - Pairing: the link field becomes `已连接` once the instance connects.
  - Sign in / create account: one form; the title and the primary button change, and extra fields appear in place.
  - Send / stop: one round button.
- State changes animate: 160–220 ms ease-out on color, opacity and transform. Content that appears or disappears fades and slides 4 px. Respect `prefers-reduced-motion` (web) and `MediaQuery.disableAnimations` (Flutter).

## 4. No lines; whitespace and type do the grouping

- Remove borders, dividers, outlines and separator rules from cards, lists, headers, sidebars and dialogs.
- Group with spacing from one scale: 4, 8, 12, 16, 24, 32, 48. Related items sit 8–12 apart, sections 24–32 apart.
- Hierarchy comes from type: sizes 12 / 13 / 15 / 20 / 28; weights 400 and 500 only; secondary text uses the secondary label color, not a smaller box.
- Inputs use a subtle filled background instead of an outline. Focus is shown with the accent color (a 2 px ring on web).
- Elevation is reserved for overlays (dialogs, drawers, toasts), using the soft shadow tokens. No other shadows.

## Tokens

Web and the plugin page use the DeepSeek Harness semantic tokens (`--dsw-alias-*`) already vendored in `apps/web/src/vendor`, so both themes stay consistent with DSH. Flutter mirrors the same light/dark values in `apps/mobile/lib/src/theme.dart`.

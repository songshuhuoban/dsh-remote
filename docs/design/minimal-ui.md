# DSH Remote UI rules

These rules apply to every DSH Remote interface: the web console (`apps/web`), the DSH plugin page (`packages/dsh-plugin/src/client`) and the Flutter app (`apps/mobile`). The reference is DeepSeek Harness (DSH) itself: DSH Remote should feel like part of DSH.

## Foundation

- **Web:** Tailwind CSS v4 + shadcn/ui (Radix underneath), themed in `apps/web/src/index.css`. Every color, radius, shadow and font is mapped onto DSH's own `--dsw-*` tokens from the pinned DSH ui-theme sheets in `apps/web/src/vendor` (DSH 0.2.1, MIT), so light and dark follow DSH exactly. Dark mode is DSH's `body[data-ds-dark-theme]`, driven by the 外观 setting. `src/theme.test.ts` enforces this.
- **Components:** primitives live in `apps/web/src/components/ui` (tuned shadcn sources: Button, Input, Textarea, Dialog, Tooltip). App helpers (`Field`, `NativeSelect`, `Actions`, `Modal`, `Err`, `Empty`) live in `apps/web/src/ui.tsx`. Native `<select>` stays for platform pickers and form semantics, styled as a DSH field.
- **Flutter** mirrors the same light/dark values in `apps/mobile/lib/src/theme.dart`; the plugin page uses the `--dsw-*` tokens directly.

## Measured DSH values

| Element | Value |
| --- | --- |
| UI text | system stack (`--dsw-font-family`), 14/22, primary `label-primary`, secondary `label-secondary`, captions `label-tertiary` |
| Type scale | 12/18 · 13/20 · 14/22 · 16/28 (messages) · 20/28 (dialog titles) · 24/32 · 28/36; weights 400 and 500 only |
| Controls | 36 px buttons, 40 px fields, 12 px corners; primary is near-black (near-white in dark) |
| Outline | 0.8 px `border-l3` hairline on `bg-base` (DSH's "新会话" button) |
| Sidebar | 280 px, `neutral-bluish-50` / `-900`, 0.8 px hairline edge, 36 px rows with 16 px icons |
| Panels | dialogs at 28 px corners and padding with `--dsw-elevation-panel` |
| Brand | the brand face (Montserrat) with a badge, like DSH's "deepseek HARNESS" — never DeepSeek's whale or wordmark |

## 1. Composition

- Content sits in a centered column (760 px for conversation, 380–480 px for forms and empty states); everything inside the column aligns left. Sign-in is centered as a block.
- Actions follow the content they act on, primary first. A row's own action may sit at its end.
- Layout never scrolls horizontally: flow columns use `grid-cols-1` (`minmax(0, 1fr)`), long paths truncate, tool rows shrink.

## 2. Say it once

- One entry point per action, except where discovery needs a second, obvious one (新建会话 in the sidebar and in the empty session view).
- No taglines, decorative illustrations or marketing copy. Helper text only for non-obvious, irreversible or security-relevant actions, in one sentence.
- A status appears in one place: one dot and word next to the instance name.

## 3. One element per state group

- Different states of one function are one element whose label, color and icon change:
  - Control: connecting takes control (`控制中`; activating releases). Another device's control asks `<设备> 正在控制` → `接管` / `仅查看`. Watch-only shows `开始控制` or `接管`.
  - Copy: the copy icon becomes a check for 1.5 s.
  - Pairing: the link fields become `已连接` once the instance connects.
  - Sign in / create account: one form; title, primary button and extra fields change in place.
  - Send / stop: one round button.
- State changes animate 160–220 ms with DSH's ease (`.swap`); content fades and lifts 2 px. Respect `prefers-reduced-motion` (web) and `MediaQuery.disableAnimations` (Flutter).

## 4. Lines, surfaces and type

- Hairlines only where DSH draws them: control outlines, field edges, the sidebar edge and settings-style cards. No dividers between list rows; rows group with spacing and a hover/selected fill.
- Grouping uses spacing from 4, 8, 12, 16, 20, 24, 32, 48.
- Hierarchy comes from type and the three label colors, not from extra boxes.
- Elevation is reserved for overlays, the composer and floating controls, using DSH's elevation tokens.

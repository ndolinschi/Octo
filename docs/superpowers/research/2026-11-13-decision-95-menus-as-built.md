# Decision 95 (a, b): popup lists and keys on open — as built

Date: 2026-11-13. Spec text of the decision: `docs/superpowers/specs/2026-11-10-project-harness-ui.md` (not edited here).

## a. One popup list

`components/primitives/PopupList.tsx` is the one list of every popup: the composer's slash menu, the `@` mention menu, the
"+" menu, `Picker` (folder, routing, project scope, tab pickers) and the model/provider list. Same rows (28px; 40px only with
a `sub` line), same paddings, same group captions, same empty line, same listbox/option markup.

- The list does not own the keys. The field that keeps focus calls `popupTarget` (`primitives/popupNav.ts`: arrows wrap at both
  ends, Home/End jump, disabled rows are never active) and passes `activeId`.
- The active row is scrolled into view (`scrollIntoView({ block: "nearest" })`) whenever it changes by anything but the pointer.
- A pointer resting over the list never takes the active row: `createPointerGate` lets a `pointermove` through only when the
  coordinates changed (a list that scrolls under a resting mouse fires a move with the same coordinates). `Menu` and `Select`
  use the same gate.
- `PickerRow` gained `pathDetail`, `trailing`, `content`, `quiet` (a path cut from the left, a chevron or row actions, a field
  inside the list, a dim name) so the model list and the mention list fit the one row.

Root cause of the slash bug: `SlashMenu` had its own list (`ListRow`s in a `Card`) with no scroll-into-view at all and
`listKeyTarget` clamped at the ends. The mention menu and `Picker` each had their own copy of the scroll effect.

What still differs, and why:
- The slash rows are one line now (name, description as the dim detail, arguments as the hint). They were two-line rows.
- The mention list shows the hint only on the active row (`hintOnActive`), as before.
- `Menu` (context menu, mode chip) and `Select` keep focus on their items / on their listbox and keep their own rows: they are
  action menus and a value list without a field, not searchable pickers. They share the wrap and the pointer gate.
- The slash and mention lists are positioned by their own code (above the composer box); `Picker` through `Popover`.

## b. A list that opens takes the keys at once

Root cause: `Popover` focused `[data-autofocus]`, else the first `button:not(:disabled)`, else itself. The model picker's
`SearchField` does not carry `data-autofocus` and an `<input>` was not in the fallback list, so focus landed on the first
button of the panel (the footer's Routing row, "Refresh models" / back at the agent level) or on the dialog itself, and the
arrows did nothing until a click. Which one depended on what the panel contained, hence "sometimes".

Fix in `Popover`: `[data-autofocus]`, then any text field or combobox, then a button, then the panel. When the exit starts (or the
panel unmounts) with focus still inside or lost, focus goes back to the opener. The "+" menu's Esc returns to the "+" button
(a pick or a click still returns to the text, as before): `ComposerMenu` calls `onClose("escape")`.

## Verification (this session)

- `packages/ui/scripts/picker-keys.mjs` (new): on the code before this change it fails 3 ways (slash active row not visible after
  repeated ArrowDown/ArrowUp, model picker ArrowDown does nothing, "+" Escape does not return to the opener); after: `picker-keys: ok`
  in dark and light at 1440x900. Covered: slash, mention, "+", mode, model (and ArrowRight / ArrowLeft between providers), folder,
  palette (Ctrl+K).
- `popupNav.test.ts`: the keyboard contract (wrap, ends, Home/End, no active row, single row, pointer gate).
- Not verified: `Select` in a real settings screen (changed: wrap + pointer gate, covered by no script), the routing picker and project
  scope menus (they use `Picker`/`Popover`, not opened by the script), touch widths (390), a live harness.

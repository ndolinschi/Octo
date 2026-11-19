# Keyboard shortcuts

Press **`?`** anywhere outside a text box (or choose "Keyboard shortcuts" in the command palette) to see this list in the app.
**Ctrl/Cmd+K** opens the command palette, which finds every action and tab.

The tables below were generated on 2026-11-19 from the app's own shortcut sheet
(`packages/ui/src/components/shell/ShortcutsSheet.tsx`); if they disagree with the sheet in your build, the sheet is right.
`Mod` is `⌘` on macOS and `Ctrl` elsewhere. Each entry was pressed in a Chromium browser before it was listed; none was tried in
Safari or the macOS window.

### General

| Shortcut (Windows, Linux) | Shortcut (macOS) | Does |
| --- | --- | --- |
| `Ctrl` + `K` | `⌘` + `K` | Search and run commands |
| `?` | `?` | Show this list (not while typing) |
| `Ctrl` + `L` | `⌘` + `L` | Write a message |
| `Esc` | `Esc` | Close a dialog, menu or the palette |

### Session

| Shortcut (Windows, Linux) | Shortcut (macOS) | Does |
| --- | --- | --- |
| `Enter` | `Enter` | Send |
| `Shift` + `Enter` | `⇧` + `Enter` | New line |
| `Ctrl` + `Enter` | `⌘` + `Enter` | Queue while Octo works |
| `Esc` | `Esc` | Stop the current reply |
| `↑` | `↑` | In an empty box, bring back your last request |
| `Shift` + `Tab` | `⇧` + `Tab` | Change the mode |
| `Alt` + `↑` | `⌥` + `↑` | Previous request |
| `Alt` + `↓` | `⌥` + `↓` | Next request |
| `Ctrl` + `Shift` + `U` | `⌘` + `⇧` + `U` | Context details |
| `/` | `/` | Commands in the message box |
| `@` | `@` | Mention a file |

### Files and editor

| Shortcut (Windows, Linux) | Shortcut (macOS) | Does |
| --- | --- | --- |
| `Ctrl` + `S` | `⌘` + `S` | Save the file |
| `Ctrl` + `Alt` + `C` | `⌘` + `⌥` + `C` | Comment on the selected lines |
| `Ctrl` + `Enter` | `⌘` + `Enter` | Save a comment |
| `Esc` | `Esc` | Cancel a comment |
| `Ctrl` + `M` | `⌃` + `⇧` + `M` | Tab moves focus out of the editor |

### Sidebar

| Shortcut (Windows, Linux) | Shortcut (macOS) | Does |
| --- | --- | --- |
| `Shift` + `F10` | `⇧` + `F10` | Row menu |

### Review

| Shortcut (Windows, Linux) | Shortcut (macOS) | Does |
| --- | --- | --- |
| `J` | `J` | Next change |
| `K` | `K` | Previous change |
| `[` | `[` | Previous file |
| `N` | `N` | Next thread in the file |
| `P` | `P` | Previous thread in the file |
| `V` | `V` | Mark the file viewed |
| `C` | `C` | Comment |
| `S` | `S` | Suggest a change |
| `Ctrl` + `Enter` | `⌘` + `Enter` | Send a comment |

### Panels

| Shortcut (Windows, Linux) | Shortcut (macOS) | Does |
| --- | --- | --- |
| `Ctrl` + `T` | `⌘` + `T` | Open a tab |
| `Ctrl` + `W` | `⌘` + `W` | Close the tab |
| `Ctrl` + `Shift` + `T` | `⌘` + `⇧` + `T` | Reopen the closed tab |
| `Ctrl` + `Tab` | `⌃` + `Tab` | Walk through the tabs |
| `Ctrl` + `1…9` | `⌘` + `1…9` | Go to the tab by number |
| `Ctrl` + `Shift` + `PgUp` | `⌘` + `⇧` + `PgUp` | Move the tab left |
| `Ctrl` + `Shift` + `PgDn` | `⌘` + `⇧` + `PgDn` | Move the tab right |
| `Ctrl` + `\\` | `⌘` + `\\` | Move the tab to the other side |
| `Ctrl` + `;` | `⌘` + `;` | Ask a side question |
| `Ctrl` + `Shift` + `Enter` | `⌘` + `⇧` + `Enter` | Maximise the panel |
| `Esc` | `Esc` | Restore the panel |

## Also in the code, not in the sheet

These are handled by the tab shortcuts (`packages/ui/src/state/workspace/tabKeys.ts`) but the sheet does not list them:

| Shortcut | Does |
| --- | --- |
| `Mod` + `` ` `` (backtick) | Open the Terminal tab |
| `Mod` + `Shift` + `` ` `` | Open another terminal in a new tab |

On a phone there is no keyboard shortcut list; `?` is just a character there.

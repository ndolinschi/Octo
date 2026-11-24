import { useEffect, useState } from "react";
import { useLatest } from "../../lib/hooks";
import { MOD_LABEL } from "../../lib/keys";
import { usePhone } from "../../lib/phone";
import { SHORTCUTS_EVENT } from "../../lib/openShortcuts";
import { Dialog } from "../primitives/Dialog";
import { KeyHint } from "../primitives/KeyHint";
import { Presence } from "../primitives/Presence";
import { SectionHeader } from "../primitives/SectionHeader";

const MAC = MOD_LABEL === "⌘";
/** Key names as the platform writes them: "Mod" is ⌘ or Ctrl, the others their Mac symbols. */
const NAMES: Record<string, string> = MAC ? { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" } : { Mod: "Ctrl" };

type Shortcut = { keys: readonly string[]; does: string };
const GROUPS: readonly { title: string; items: readonly Shortcut[] }[] = [
  {
    title: "General",
    items: [
      { keys: ["Mod", "K"], does: "Search and run commands" },
      { keys: ["Mod", "P"], does: "Quick open a file" },
      { keys: ["?"], does: "Show this list (not while typing)" },
      { keys: ["Mod", "L"], does: "Write a message (or attach editor selection)" },
      { keys: ["Esc"], does: "Close a dialog, menu or the palette" },
    ],
  },
  {
    title: "Session",
    items: [
      { keys: ["Enter"], does: "Send" },
      { keys: ["Shift", "Enter"], does: "New line" },
      { keys: ["Mod", "Enter"], does: "Queue while Octo works" },
      { keys: ["Esc"], does: "Stop the current reply" },
      { keys: ["↑", "↓"], does: "Browse earlier requests in the message box" },
      { keys: ["Shift", "Tab"], does: "Change the mode" },
      { keys: ["Ctrl", "O"], does: "Cycle transcript view (Normal / Thinking / Verbose)" },
      { keys: ["Alt", "↑"], does: "Previous request" },
      { keys: ["Alt", "↓"], does: "Next request" },
      { keys: ["Mod", "Shift", "U"], does: "Context details" },
      { keys: ["/"], does: "Commands in the message box" },
      { keys: ["@"], does: "Mention files, @Changes or @Problems" },
    ],
  },
  {
    title: "Files and editor",
    items: [
      { keys: ["Mod", "S"], does: "Save the file" },
      { keys: ["Mod", "I"], does: "Edit selection with agent" },
      { keys: ["Mod", "L"], does: "Add selection to chat" },
      { keys: ["Mod", "G"], does: "Go to line" },
      { keys: ["Mod", "Alt", "C"], does: "Comment on the selected lines" },
      { keys: ["Mod", "Enter"], does: "Save a comment" },
      { keys: ["Esc"], does: "Cancel a comment" },
      // Monaco's own toggle (Tab focus mode): Ctrl+M, and Ctrl+Shift+M on a Mac.
      { keys: MAC ? ["Ctrl", "Shift", "M"] : ["Ctrl", "M"], does: "Tab moves focus out of the editor" },
    ],
  },
  {
    title: "Sidebar",
    items: [{ keys: ["Shift", "F10"], does: "Row menu" }],
  },
  {
    title: "Review",
    items: [
      { keys: ["Alt", "]"], does: "Next changed file (Changes)" },
      { keys: ["Alt", "["], does: "Previous changed file (Changes)" },
      { keys: ["J"], does: "Next change" },
      { keys: ["K"], does: "Previous change" },
      { keys: ["]"], does: "Next file" },
      { keys: ["["], does: "Previous file" },
      { keys: ["N"], does: "Next thread in the file" },
      { keys: ["P"], does: "Previous thread in the file" },
      { keys: ["V"], does: "Mark the file viewed" },
      { keys: ["C"], does: "Comment" },
      { keys: ["S"], does: "Suggest a change" },
      { keys: ["Mod", "Enter"], does: "Send a comment" },
    ],
  },
  {
    title: "Panels",
    items: [
      { keys: ["Mod", "T"], does: "Open a tab" },
      { keys: ["Mod", "W"], does: "Close the tab" },
      { keys: ["Mod", "Shift", "T"], does: "Reopen the closed tab" },
      { keys: ["Ctrl", "Tab"], does: "Walk through the tabs" },
      { keys: ["Mod", "1…9"], does: "Go to the tab by number" },
      { keys: ["Mod", "Shift", "PgUp"], does: "Move the tab left" },
      { keys: ["Mod", "Shift", "PgDn"], does: "Move the tab right" },
      { keys: ["Mod", "\\"], does: "Move the tab to the other side" },
      { keys: ["Mod", ";"], does: "Ask a side question" },
      { keys: ["Mod", "Shift", "Enter"], does: "Maximise the panel" },
      { keys: ["Esc"], does: "Restore the panel" },
    ],
  },
];

const name = (k: string) => NAMES[k] ?? k;

/**
 * The keyboard shortcut reference: a dialog of every shortcut the app answers, grouped. Lazy chunk, always mounted by the shell
 * (it holds the "?" key and the open event, which the palette and Settings send); the sheet itself only renders while open.
 * Each entry was pressed in the browser before it was listed.
 */
export default function ShortcutsSheet() {
  const [open, setOpen] = useState(false);
  // A8: the phone has no keyboard to list; "?" typed there is only a character.
  const phone = useLatest(usePhone());
  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === "?" && !phone.current && !e.ctrlKey && !e.metaKey && !e.altKey && !typing && !document.querySelector('[aria-modal="true"]')) show();
    };
    // NEW-6: navigating (Back / Forward, a hash change) closes the sheet, as it does the palette.
    const hide = () => setOpen(false);
    window.addEventListener(SHORTCUTS_EVENT, show);
    window.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", hide);
    return () => {
      window.removeEventListener(SHORTCUTS_EVENT, show);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", hide);
    };
  }, [phone]);
  return <Presence show={open}>{open && <Sheet onClose={() => setOpen(false)} />}</Presence>;
}

function Sheet({ onClose }: { onClose(): void }) {
  return (
    <Dialog title="Keyboard shortcuts" width="xl" reading onClose={onClose}>
      <div className="flex flex-col gap-4 @min-[600px]/dialog:block @min-[600px]/dialog:columns-2 @min-[600px]/dialog:gap-x-8">
        {GROUPS.map((g) => (
          <section key={g.title} aria-label={g.title} className="flex break-inside-avoid flex-col @min-[600px]/dialog:pb-4">
            <SectionHeader as="h3">{g.title}</SectionHeader>
            <ul className="flex flex-col">
              {g.items.map((s) => (
                <li key={s.does} className="flex min-h-row items-center justify-between gap-3 py-0.5 text-sm text-fg">
                  <span className="min-w-0">{s.does}</span>
                  <span className="flex shrink-0 items-center gap-1 text-fg-2">
                    <span className="sr-only">{s.keys.map(name).join(" plus ")}</span>
                    {s.keys.map((k) => (
                      <KeyHint key={k} always>
                        {name(k)}
                      </KeyHint>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

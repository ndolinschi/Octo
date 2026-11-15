import { useMemo } from "react";
import { connectionText, workingText } from "../../lib/statusBar";
import { useApp } from "../../state/app";
import { navigate } from "../../lib/route";
import { Spinner } from "../primitives/Status";
import { StateGlyph } from "../primitives/StateGlyph";
import { RemoteIndicator } from "./RemoteIndicator";
import { StatusButton } from "./StatusButton";

/**
 * Decision 73: one quiet 24px row at the bottom of the window, at most five items, each a button. The open project fills the
 * left end (its folder, its changed files) and the budget (`ProjectStatus`); this row itself shows the projects whose agents
 * are working (opens Home, which lists them) and the connection, only when it is not fine. Nothing moves unless something is
 * in progress (decision 76): the one glyph that turns is the working item's. Hidden below 600px of window height.
 */
export function StatusBar(props: { home: boolean; startRef(el: HTMLElement | null): void; endRef(el: HTMLElement | null): void }) {
  const { projects, health, retry, cause } = useApp();
  const running = useMemo(() => projects?.filter((p) => p.status === "running").length ?? 0, [projects]);
  // Home lists the projects at work itself (its tiles): the item would only repeat it.
  const working = props.home ? null : workingText(running);
  const connection = connectionText(health, cause);
  return (
    <footer
      aria-label="Status"
      data-status-bar
      // Polish step 2 (F4): the first item's glyph starts on the sidebar's glyph column (24 = 16 here + the button's 8), the last
      // item's text ends on the panel's right edge (the button's 8px inset is the gutter); one size (12px), one colour.
      className="flex h-7 shrink-0 items-center gap-4 pr-2 pl-4 text-xs text-fg-2 [@media(max-height:599px)]:hidden"
    >
      <div ref={props.startRef} className="flex min-w-0 items-center gap-1 empty:hidden" />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {working && (
          <StatusButton title="Agents are working. Show the projects." onClick={() => navigate(null)}>
            <StateGlyph state="working" />
            {working}
          </StatusButton>
        )}
        <div ref={props.endRef} className="flex items-center gap-1 empty:hidden" />
        <RemoteIndicator />
        {connection && (
          <StatusButton title={connection.hint} onClick={retry} disabled={health === "checking"}>
            {health === "checking" ? <Spinner size={12} /> : <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-err" />}
            {connection.text}
          </StatusButton>
        )}
      </div>
    </footer>
  );
}

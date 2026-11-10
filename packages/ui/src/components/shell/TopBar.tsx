import { PanelLeft, PanelLeftClose } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../primitives/Button";

/**
 * The slim header row above the dock, on the window surface (aligned with the sidebar's header):
 * sidebar toggle, title, and global actions on the far right.
 */
export function TopBar(props: { sidebarOpen: boolean; onToggleSidebar(): void; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="box-content flex h-10 shrink-0 items-center gap-1.5 pt-1.5 max-sm:px-1.5 max-sm:pt-0">
      <IconButton
        icon={props.sidebarOpen ? PanelLeftClose : PanelLeft}
        label={props.sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        aria-expanded={props.sidebarOpen}
        onClick={props.onToggleSidebar}
      />
      {props.children}
      {props.actions && <div className="ml-auto flex shrink-0 items-center gap-0.5">{props.actions}</div>}
    </header>
  );
}

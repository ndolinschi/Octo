import { PanelLeft, PanelLeftClose } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../primitives/Button";

/** Slim bar across the main area: sidebar toggle, title, and actions on the far right. */
export function TopBar(props: { sidebarOpen: boolean; onToggleSidebar(): void; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-1.5 px-2">
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

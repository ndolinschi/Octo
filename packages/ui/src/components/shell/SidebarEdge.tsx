import { useRef, type RefObject } from "react";
import { applySidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useSidebarWidth } from "../../lib/sidebarWidth";
import { ResizeHandle } from "../primitives/ResizeHandle";

/**
 * Item 3: the sidebar's edge, in the 8px gutter to the first panel (not in the drawer: its width is the drawer's). A drag
 * previews the width once per animation frame (`ResizeHandle`'s `onFrame`) without a React render (the conversation beside it must not re-render per pointer
 * move); the release stores it. It also applies the stored width: it loads with the Projects list's chunk, which the sidebar
 * asks for at once, so the app's first load does not carry it (the bundle budget); a width other than the default can show
 * one frame late.
 */
export function SidebarEdge({ nav }: { nav: RefObject<HTMLElement | null> }) {
  const props = { nav, ...useSidebarWidth(nav) };
  const to = useRef(props.width);
  return (
    <ResizeHandle
      label="Resize sidebar"
      title="Drag to resize; double-click to reset"
      value={props.width}
      min={SIDEBAR_MIN}
      max={SIDEBAR_MAX}
      onDrag={(_dx, total) => {
        to.current = props.width + total;
      }}
      onFrame={() => applySidebarWidth(props.nav.current, to.current)}
      onDragEnd={() => props.commit(to.current)}
      onKey={(dx) => props.commit(props.width + dx)}
      onReset={() => props.commit(SIDEBAR_DEFAULT)}
      className="group/divider absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none focus-visible:shadow-none max-drawer:hidden"
    >
      <span
        aria-hidden
        className="absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-[background-color] duration-fast group-hover/divider:bg-line-strong group-focus-visible/divider:bg-focus group-data-[dragging]/divider:bg-focus"
      />
    </ResizeHandle>
  );
}

import type { ProjectSummary } from "@octo/agent-client";
import { Check, ChevronRight, FolderGit2, Settings, Star } from "lucide-react";
import { useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { togglePinnedProject, usePinnedProjects } from "../../lib/pinnedProjectsPref";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { IconButton } from "../primitives/IconButton";
import { Popover } from "../primitives/Popover";
import { SearchField } from "../primitives/SearchField";
import { SectionHeader } from "../primitives/SectionHeader";

const VISIBLE_UNPINNED = 5;

/**
 * Claude-Code-inspired project selector adapted to Octo's design: searchable list with Pinned + Projects sections,
 * inline Settings gear & Star pin actions per row, checkmark on the active project, collapsible "More" overflow,
 * and ↑/↓/Enter keyboard navigation.
 */
export function ProjectSelectorPopover(props: {
  anchor: RefObject<HTMLElement | null>;
  projects: readonly ProjectSummary[];
  currentId: string;
  disabled?: boolean;
  onSelect(projectId: string): void;
  onOpenSettings(projectId: string): void;
  onClose(): void;
}) {
  const pinnedIds = usePinnedProjects();
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const q = query.trim().toLowerCase();
  const { pinned, rest, visible, hiddenCount } = useMemo(() => {
    const filtered = q ? props.projects.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) : props.projects;
    const pList = filtered.filter((p) => pinnedSet.has(p.id));
    const uList = filtered.filter((p) => !pinnedSet.has(p.id));
    const showAll = q !== "" || expanded;
    const shownRest = showAll ? uList : uList.slice(0, VISIBLE_UNPINNED);
    return {
      pinned: pList,
      rest: shownRest,
      visible: [...pList, ...shownRest],
      hiddenCount: showAll ? 0 : Math.max(0, uList.length - VISIBLE_UNPINNED),
    };
  }, [props.projects, pinnedSet, q, expanded]);

  const clampedIdx = visible.length > 0 ? Math.min(activeIdx, visible.length - 1) : -1;
  const activeId = clampedIdx >= 0 ? visible[clampedIdx]?.id : null;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!visible.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((clampedIdx + 1) % visible.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((clampedIdx - 1 + visible.length) % visible.length);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing && activeId && !props.disabled) {
      e.preventDefault();
      props.onClose();
      props.onSelect(activeId);
    }
  };

  const renderRow = (p: ProjectSummary) => {
    const isCurrent = p.id === props.currentId;
    const isPinned = pinnedSet.has(p.id);
    const isHighlighted = p.id === activeId;
    return (
      <div
        key={p.id}
        onPointerEnter={() => {
          const idx = visible.findIndex((v) => v.id === p.id);
          if (idx >= 0) setActiveIdx(idx);
        }}
        className={cn(
          "group/prow flex h-ctl-md items-center gap-1 rounded-md px-1.5 transition-[background-color] duration-fast",
          isHighlighted ? "bg-active" : isCurrent ? "bg-hover" : "hover:bg-hover",
        )}
      >
        <Button
          variant="quiet"
          size="sm"
          disabled={props.disabled}
          onClick={() => {
            props.onClose();
            props.onSelect(p.id);
          }}
          className="h-full min-w-0 flex-1 justify-start gap-2 bg-transparent! px-1 hover:bg-transparent!"
        >
          <Glyph icon={FolderGit2} size={14} className="shrink-0 text-fg-3" />
          <span className="min-w-0 truncate text-sm text-fg">{p.name}</span>
        </Button>
        <span className="flex shrink-0 items-center gap-0.5">
          <IconButton
            icon={Settings}
            size="xs"
            label={`Settings for ${p.name}`}
            title={`Project settings (${p.name})`}
            className="opacity-0 transition-opacity duration-fast group-focus-within/prow:opacity-100 group-hover/prow:opacity-100"
            onClick={() => {
              props.onClose();
              props.onOpenSettings(p.id);
            }}
          />
          <IconButton
            icon={Star}
            size="xs"
            label={isPinned ? `Unpin ${p.name}` : `Pin ${p.name}`}
            title={isPinned ? "Unpin project" : "Pin project"}
            className={cn(
              isPinned
                ? "text-warn [&_svg]:fill-current"
                : "opacity-0 transition-opacity duration-fast group-focus-within/prow:opacity-100 group-hover/prow:opacity-100",
            )}
            onClick={() => togglePinnedProject(p.id)}
          />
          {isCurrent && (
            <span aria-label="Current project" className="grid size-6 shrink-0 place-items-center text-accent">
              <Glyph icon={Check} size={14} />
            </span>
          )}
        </span>
      </div>
    );
  };

  const empty = pinned.length === 0 && rest.length === 0;

  return (
    <Popover anchor={props.anchor} label="Switch project" onClose={props.onClose} side="bottom" align="start" gap={4} className="w-80 max-w-[calc(100vw-16px)]">
      <SearchField
        variant="header"
        label="Search projects"
        placeholder="Search projects…"
        value={query}
        onChange={(v) => {
          setQuery(v);
          setActiveIdx(0);
        }}
        onKeyDown={onKeyDown}
        inputProps={{ autoFocus: true }}
      />
      <div className="max-h-72 overflow-y-auto overscroll-contain p-1">
        {pinned.length > 0 && (
          <div className="pb-1">
            <SectionHeader as="h3" className="px-2">
              Pinned
            </SectionHeader>
            {pinned.map(renderRow)}
          </div>
        )}
        {rest.length > 0 && (
          <div>
            <SectionHeader as="h3" className="px-2">
              Projects
            </SectionHeader>
            {rest.map(renderRow)}
            {hiddenCount > 0 && (
              <Button variant="quiet" size="sm" onClick={() => setExpanded(true)} className="mt-0.5 flex w-full items-center justify-between px-2.5 text-fg-2">
                <span>More</span>
                <span className="flex items-center gap-1 text-xs text-fg-3 tabular-nums">
                  {hiddenCount}
                  <Glyph icon={ChevronRight} size={12} />
                </span>
              </Button>
            )}
          </div>
        )}
        {empty && <p className="px-2 py-4 text-center text-sm text-fg-3">No matching projects</p>}
      </div>
    </Popover>
  );
}

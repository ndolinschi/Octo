/**
 * R2 (round two of the polish): one width rule for every tool tab, so a tab never shows two right edges.
 *
 * - A list or a table inside a tab runs the tab's full width: its meta ends on the same edge as the header's actions and
 *   the search field (the frame's 8px inset, text 8px further in). No list caps itself on its own.
 * - A tab that is one column all through (Agents, Details, Usage, the side question, the review's pull-request and branch
 *   lists) stops at the measure (720px of content) when its pane is wider, header and filters included: the cap is on the
 *   whole tab, never on the rows alone. In a pane of ~640px it takes the whole width.
 * - A detail column of a list and a detail (a note, a session, a memory file) keeps the same measure for its header,
 *   its text and its actions together.
 */
export const PANEL_COLUMN = "w-full max-w-[calc(var(--spacing-measure)+16px)]";

/** The detail column of a `ListDetail` (the detail's header and actions are inside it). */
export const DETAIL_COLUMN = "w-full max-w-measure";

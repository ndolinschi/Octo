import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { useNow } from "../../lib/hooks";
import { useProject } from "../../state/project";
import { EmptyState } from "../primitives/EmptyState";
import { ScrollArea } from "../primitives/ScrollArea";
import type { TranscriptSlot } from "./parts";
import { SessionDetail } from "./SessionDetail";

/**
 * One session in a tab of its own ("Open in tab"): two sessions can sit side by side in the dock. The same detail as in the
 * Sessions tab; when the session is deleted the tab says so and can be closed.
 */
export function SessionPane(props: { sessionId: string; renderTranscript: TranscriptSlot; onClose?: (() => void) | undefined }) {
  const { state } = useProject();
  const now = useNow(false, CLOCK_MINUTE_MS);
  const list = state.sessions.list;
  const session = list.find((s) => s.id === props.sessionId);
  if (!session) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EmptyState title="This session is gone">It was deleted. Close this tab, or open the Sessions tab to pick another.</EmptyState>
      </div>
    );
  }
  return (
    <ScrollArea className="h-full px-pane pb-6">
      <SessionDetail key={session.id} session={session} list={list} now={now} renderTranscript={props.renderTranscript} onGone={() => props.onClose?.()} />
    </ScrollArea>
  );
}

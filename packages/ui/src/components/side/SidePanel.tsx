import type { SideMessage } from "@octo/agent-client";
import { ArrowUp, Pin } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { useStickToBottom } from "../../lib/hooks";
import { useProject } from "../../state/project";
import { toolTab } from "../../state/workspace/layout";
import { SIDE_PINNED } from "../../state/workspace/tabMemory";
import { useTabMemory } from "../../state/workspace/useTabMemory";
import { Button } from "../primitives/Button";
import { FloatRoom } from "../primitives/floatRoom";
import { Glyph } from "../primitives/Glyph";
import { SkeletonRows } from "../primitives/InfoList";
import { Spinner } from "../primitives/Status";
import { Markdown } from "../shared/Markdown";

const TAB = toolTab("side");
/** The input's id: `Ctrl/Cmd+;` and the "+" picker focus it when the pane opens. */
export const SIDE_INPUT_ID = "octo-side-input";

const STARTERS = ["What is happening right now?", "Why did it pick these agents?", "What changed in this project today?"];

type Exchange = { id: string; question: SideMessage | null; answer: SideMessage | null };

/** Questions and answers paired by `side_id`, oldest first. */
function exchanges(messages: readonly SideMessage[]): Exchange[] {
  const out: Exchange[] = [];
  for (const m of [...messages].sort((a, b) => a.id - b.id)) {
    let ex = out.find((e) => e.id === m.side_id);
    if (!ex) {
      ex = { id: m.side_id, question: null, answer: null };
      out.push(ex);
    }
    if (m.role === "user") ex.question = m;
    else ex.answer = m;
  }
  return out;
}

/**
 * Decision 40 — the side question: a disposable conversation about the project that never enters the orchestrator's
 * history. One line of explanation, the questions and answers (the answer streams in), and a single-line input; works
 * while a turn runs. "Keep" pins it, so closing the tab does not clear it (the workspace clears an unpinned one).
 */
export function SidePanel() {
  const { state, askSide, loadSide, clearSide } = useProject();
  const side = state.side;
  const [pinned, setPinned] = useTabMemory(TAB, SIDE_PINNED, false);
  const [text, setText] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [load, setLoad] = useState<"loading" | "ok" | "error">("loading");
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => exchanges(side.messages), [side.messages]);
  const pending = side.pending;
  const { ref: scroller } = useStickToBottom<HTMLDivElement>([list.length, pending?.text]);

  useEffect(() => {
    let alive = true;
    loadSide().then(
      () => alive && setLoad("ok"),
      () => alive && setLoad("error"),
    );
    return () => {
      alive = false;
    };
  }, [loadSide]);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || pending) return;
    setAsked(question);
    setSendError(null);
    setText("");
    try {
      await askSide(question);
    } catch (e) {
      setText(question);
      setSendError(errorMessage(e));
    }
  };

  const failed = side.error && !pending ? side.error.message : null;
  return (
    <div data-side className="flex h-full min-h-0 flex-col px-pane pt-pane">
      <div className="mx-auto flex w-full max-w-details items-start gap-2 px-2 pb-2">
        <p className="min-w-0 flex-1 text-xs text-fg-3">Ask about this project without interrupting the work. Nothing here is added to its history.</p>
        <button
          type="button"
          aria-pressed={pinned}
          title={pinned ? "Kept when this tab closes" : "Cleared when this tab closes; keep it instead"}
          onClick={() => setPinned(!pinned)}
          className={cn(
            "flex h-chip shrink-0 press items-center gap-1 rounded-sm px-1.5 text-xs hover:bg-hover hover:text-fg max-md:h-10",
            pinned ? "bg-hover text-fg" : "text-fg-3",
          )}
        >
          <Glyph icon={Pin} size={14} />
          Keep
        </button>
        {list.length > 0 && (
          <button
            type="button"
            onClick={() => void clearSide().catch(() => undefined)}
            className="h-chip shrink-0 press rounded-sm px-1.5 text-xs text-fg-3 hover:bg-hover hover:text-fg max-md:h-10"
          >
            Clear
          </button>
        )}
      </div>
      <div ref={scroller} data-side-list className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-details flex-col gap-4 px-2 pb-4">
          {load === "loading" && list.length === 0 && <SkeletonRows count={2} />}
          {load === "error" && list.length === 0 && (
            <p className="text-sm text-fg-2">
              Couldn't load earlier side questions.{" "}
              <button
                type="button"
                className="text-fg underline underline-offset-2"
                onClick={() =>
                  void loadSide().then(
                    () => setLoad("ok"),
                    () => setLoad("error"),
                  )
                }
              >
                Try again
              </button>
            </p>
          )}
          {load !== "loading" && list.length === 0 && !pending && (
            <div className="flex flex-col">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  data-row
                  onClick={() => void ask(s)}
                  className="-mx-2 flex h-row items-center rounded-sm px-2 text-left text-sm text-fg-2 press-row focus-inset hover:bg-hover hover:text-fg max-md:h-bar"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {list.map((ex) => (
            <div key={ex.id} data-side-exchange className="flex flex-col gap-2">
              {ex.question && <p className="rounded-md border border-line bg-raised px-3 py-2 text-sm wrap-anywhere text-fg">{ex.question.text}</p>}
              {ex.answer ? (
                <Markdown text={ex.answer.text} className="octo-prose octo-prose-sm" />
              ) : pending?.side_id === ex.id ? (
                pending.text ? (
                  <Markdown text={pending.text} className="octo-prose octo-prose-sm" streaming />
                ) : (
                  <p className="flex h-6 items-center gap-2 text-sm text-fg-3">
                    <Spinner className="text-accent" />
                    Thinking…
                  </p>
                )
              ) : null}
            </div>
          ))}
          {failed && (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <p className="min-w-0 flex-1 text-fg-2">
                <span className="text-err">No answer.</span> {failed.replace(/\.$/, "")}.
              </p>
              {asked && (
                <Button size="sm" onClick={() => void ask(asked)}>
                  Ask again
                </Button>
              )}
            </div>
          )}
        </div>
        <FloatRoom />
      </div>
      <form
        className="mx-auto mb-pane flex w-full max-w-details items-center gap-2 rounded-xl bg-raised p-1.5 outline -outline-offset-1 outline-line focus-within:outline-focus"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <label htmlFor={SIDE_INPUT_ID} className="sr-only">
          Side question
        </label>
        <input
          ref={input}
          id={SIDE_INPUT_ID}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={pending ? "Answering…" : "Ask about this project…"}
          autoComplete="off"
          aria-describedby={sendError ? `${SIDE_INPUT_ID}-error` : undefined}
          className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none max-sm:text-input-touch"
        />
        <button
          type="submit"
          aria-label="Ask"
          title="Ask (↵)"
          disabled={!text.trim() || pending !== null}
          className={cn(
            "grid size-7 shrink-0 press place-items-center rounded-sm",
            text.trim() && !pending ? "bg-primary text-primary-fg hover:opacity-90" : "bg-hover text-fg-3",
          )}
        >
          <Glyph icon={ArrowUp} size={16} />
        </button>
      </form>
      {sendError && (
        <p id={`${SIDE_INPUT_ID}-error`} role="alert" className="mx-auto -mt-1 mb-pane w-full max-w-details px-2 text-xs text-err">
          Couldn't ask: {sendError}. Your question is still in the box.
        </p>
      )}
    </div>
  );
}

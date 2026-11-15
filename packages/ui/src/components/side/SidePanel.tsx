import { BridgeError, type SideMessage } from "@octo/agent-client";
import { useQuietOpen } from "../../lib/quietFocus";
import { ArrowUp, Pin, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../lib/format";
import { useStickToBottom } from "../../lib/hooks";
import { settingsHref } from "../../lib/route";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { toolTab } from "../../state/workspace/layout";
import { SIDE_PINNED } from "../../state/workspace/tabMemory";
import { useTabMemory } from "../../state/workspace/useTabMemory";
import { Button } from "../primitives/Button";
import { Card } from "../primitives/Card";
import { FloatRoom } from "../primitives/floatRoom";
import { IconButton } from "../primitives/IconButton";
import { Notice } from "../primitives/Notice";
import { Panel, PanelEmpty } from "../primitives/Panel";
import { ScrollArea } from "../primitives/ScrollArea";
import { SkeletonList } from "../primitives/Skeleton";
import { Spinner } from "../primitives/Status";
import { TextField } from "../primitives/TextField";
import { Markdown } from "../shared/Markdown";
import { ModelPicker } from "../shared/ModelPicker";
import { PanelPurpose } from "../shared/PanelPurpose";

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

/** "Connect a provider" goes to Settings → Providers (parity B13 rule 3: one button, never an environment-variable instruction). */
function connectProvider() {
  window.location.hash = settingsHref("providers");
}

/**
 * Decision 40 and parity B13 — the side question: a disposable conversation about the project that never enters the
 * orchestrator's history. The question, the answer (it streams, with the agent's live activity and thinking) and the
 * input share one column on the panel frame (P5, polish step 5: `Panel`, title "Side question", Keep and Clear at the
 * right of its header), left aligned on the frame's text edge at every width, so their edges line up. The input
 * carries a small model control that writes `models.side` and a Stop while an answer is in flight. With nothing able to
 * answer it says so in one `Notice` with a "Connect a provider" button. "Keep" pins the conversation, so closing the tab
 * does not clear it (the workspace clears an unpinned one).
 */
export function SidePanel() {
  const { bridge } = useApp();
  const { projectId, project, state, askSide, loadSide, clearSide, update } = useProject();
  const side = state.side;
  const [pinned, setPinned] = useTabMemory(TAB, SIDE_PINNED, false);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [sendError, setSendError] = useState<{ message: string; code: string | null } | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [load, setLoad] = useState<"loading" | "ok" | "error">("loading");
  const list = useMemo(() => exchanges(side.messages), [side.messages]);
  const pending = side.pending;
  const { ref: scroller } = useStickToBottom<HTMLDivElement>([list.length, pending?.text, pending?.activity?.label]);

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

  const clear = () => {
    // The Clear button goes away with the answers: focus goes to the input, where the next question is typed (B1 family).
    input.current?.focus();
    void clearSide().catch(() => undefined);
  };
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
      setSendError({ message: errorMessage(e), code: e instanceof BridgeError ? e.code : null });
    }
  };
  const stop = () => {
    // A failure to stop shows as the answer carrying on; the harness's stop is a plain 204.
    void bridge.stopSide?.(projectId).catch(() => undefined);
  };
  const chooseModel = (model: string) => {
    setModelError(null);
    update({ models: { side: model } }).catch((e: unknown) => setModelError(`Couldn't change the side model: ${errorMessage(e)}. Choose it again.`));
  };

  const noProvider = (side.error?.code === "no_provider" && !pending) || sendError?.code === "no_provider";
  const failed = side.error && !pending && side.error.code !== "no_provider" ? side.error : null;
  const empty = load !== "loading" && list.length === 0 && !pending && load !== "error" && !failed && !noProvider;
  const showList = list.length > 0 || pending || load === "loading" || load === "error" || failed || noProvider;
  const working = pending !== null;
  const sideModel = project ? (project.models.side ?? project.models.fast) : null;

  // B4.3: focus the dock moves here on opening draws no ring until the first key or press.
  const quiet = useRef<HTMLDivElement>(null);
  useQuietOpen(quiet);
  return (
    <div ref={quiet} data-side className="h-full min-h-0">
      <Panel
        name="side"
        title="Side question"
        lead={<PanelPurpose tool="side" />}
        {...(list.length > 0 || pending
          ? {
              actions: (
                <>
                  <Button
                    variant="quiet"
                    size="sm"
                    icon={Pin}
                    pressed={pinned}
                    title={pinned ? "Saved when you close this tab" : "Cleared when you close this tab; press to keep"}
                    onClick={() => setPinned(!pinned)}
                  >
                    {pinned ? "Kept" : "Keep"}
                  </Button>
                  <Button variant="quiet" size="sm" onClick={clear}>
                    Clear
                  </Button>
                </>
              ),
            }
          : {})}
      >
        <div className="flex h-full min-h-0 flex-col">
          {empty && (
            <div className="min-h-0 flex-1">
              <PanelEmpty
                title="Ask about this project"
                actions={STARTERS.map((q) => (
                  <Button key={q} variant="quiet" size="sm" fullWidth data-row onClick={() => void ask(q)}>
                    {q}
                  </Button>
                ))}
              >
                Without interrupting the work. Nothing here is added to the project's conversation.
              </PanelEmpty>
            </div>
          )}
          <ScrollArea ref={scroller} data-side-list className={showList ? "min-h-0 flex-1 px-pane pt-1" : "hidden"}>
            <div className="flex w-full max-w-measure flex-col gap-4 px-2 pb-4">
              {load === "loading" && list.length === 0 && <SkeletonList count={2} size="md" />}
              {load === "error" && list.length === 0 && (
                <Notice
                  action={
                    <Button
                      variant="link"
                      size="xs"
                      onClick={() =>
                        void loadSide().then(
                          () => setLoad("ok"),
                          () => setLoad("error"),
                        )
                      }
                    >
                      Retry
                    </Button>
                  }
                >
                  Couldn't load earlier side questions.
                </Notice>
              )}
              {list.map((ex) => (
                <div key={ex.id} data-side-exchange className="flex flex-col gap-2">
                  {ex.question && (
                    <Card padding="md">
                      <p className="text-sm wrap-anywhere text-fg">{ex.question.text}</p>
                    </Card>
                  )}
                  {ex.answer ? (
                    <Markdown text={ex.answer.text} className="octo-prose octo-prose-sm" />
                  ) : pending?.side_id === ex.id ? (
                    <Answering pending={pending} />
                  ) : null}
                </div>
              ))}
              {noProvider && (
                <Notice
                  form="block"
                  tone="warn"
                  title="Nothing can answer a side question"
                  actions={
                    <Button variant="primary" size="sm" onClick={connectProvider}>
                      Connect a provider
                    </Button>
                  }
                >
                  Connect a provider, or choose a model for side questions below. Your question is still in the box.
                </Notice>
              )}
              {failed && (
                <Notice
                  form="block"
                  tone="error"
                  title="No answer"
                  actions={
                    asked && (
                      <Button size="sm" onClick={() => void ask(asked)}>
                        Ask again
                      </Button>
                    )
                  }
                >
                  {failed.message.replace(/\.$/, "")}.{failed.hint ? ` ${failed.hint}` : ""}
                </Notice>
              )}
            </div>
            <FloatRoom />
          </ScrollArea>
          <div className="shrink-0 px-pane pb-pane">
            <form
              className="octo-composer flex w-full max-w-measure flex-col gap-1 bg-raised p-2"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(text);
              }}
            >
              <label htmlFor={SIDE_INPUT_ID} className="sr-only">
                Side question
              </label>
              <TextField
                id={SIDE_INPUT_ID}
                ref={input}
                variant="bare"
                size="md"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={working ? "Answering…" : "Ask about this project…"}
                autoComplete="off"
                aria-describedby={sendError && sendError.code !== "no_provider" ? `${SIDE_INPUT_ID}-error` : undefined}
                className="octo-composer-input px-1"
              />
              <div className="flex items-center gap-1">
                {sideModel !== null && (
                  <ModelPicker
                    label="Side question model"
                    value={sideModel}
                    onChoose={chooseModel}
                    side="top"
                    tip={project?.models.side ? undefined : "Side questions use the Fast tier until you choose a model"}
                  />
                )}
                <span className="ml-auto" />
                {working && bridge.stopSide ? (
                  <IconButton icon={Square} label="Stop" variant="primary" round onClick={stop} />
                ) : (
                  <IconButton icon={ArrowUp} label="Ask" shortcut="↵" variant="primary" round type="submit" disabled={!text.trim() || working} />
                )}
              </div>
            </form>
            {(sendError && sendError.code !== "no_provider") || modelError ? (
              <div id={`${SIDE_INPUT_ID}-error`} className="mt-1 w-full max-w-measure px-2">
                <Notice tone="error">{modelError ?? `Couldn't ask: ${sendError?.message}. Your question is still in the box.`}</Notice>
              </div>
            ) : null}
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** An answer in flight: the agent's reasoning (dim, as it streams), the text so far, and what it is doing now. */
function Answering({ pending }: { pending: NonNullable<ReturnType<typeof useProject>["state"]["side"]["pending"]> }) {
  const label = pending.activity?.label ?? (pending.text ? null : "Thinking…");
  return (
    <div className="flex flex-col gap-2">
      {pending.thinking && !pending.text && <p className="line-clamp-4 text-xs whitespace-pre-wrap text-fg-3">{pending.thinking}</p>}
      {pending.text && <Markdown text={pending.text} className="octo-prose octo-prose-sm" streaming />}
      {label && (
        <p role="status" className="flex min-h-ctl-xs items-center gap-2 text-sm text-fg-3">
          <Spinner className="text-accent" />
          {label}
        </p>
      )}
    </div>
  );
}

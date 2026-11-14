import { MessageSquare, Reply, type LucideIcon } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { Review, ReviewReplyPost, ReviewSubmitPreview, ReviewSubmitResult, ReviewVerdict } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import type { ReviewApi } from "../../lib/review/api";
import { commentWhere } from "../../lib/review/position";
import { canSubmit, reviewTarget, submitProblem, submittedText, submitText, VERDICTS, verdictLabel, type SubmitProblem } from "../../lib/review/submit";
import { Button } from "../primitives/Button";
import { CommandLine } from "../primitives/CommandLine";
import { Dialog } from "../primitives/Dialog";
import { Field, Textarea } from "../primitives/Field";
import { Glyph } from "../primitives/Glyph";
import { Segmented } from "../primitives/Segmented";
import { Spinner } from "../primitives/Status";

type Preview = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; preview: ReviewSubmitPreview };

/**
 * The submit sheet: the verdict, an optional text, and below them the preview from `submit-preview` word for word, the
 * exact comments and verdict that will be posted. The button says plainly what happens and where. A failure keeps every
 * comment pending and says what to do; after success it shows the result and a link to the review.
 */
export function SubmitSheet(props: { api: ReviewApi; review: Review; onClose(): void; onSubmitted(): void; onCommentsChanged(): void }) {
  const { api, review } = props;
  const [verdict, setVerdict] = useState<ReviewVerdict>("comment");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<Preview>({ status: "loading" });
  const [problem, setProblem] = useState<SubmitProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ result: ReviewSubmitResult; verdict: ReviewVerdict; replies: ReviewReplyPost[] } | null>(null);
  const [tick, setTick] = useState(0);
  const bodyId = useId();

  useEffect(() => {
    let alive = true;
    // The text is typed: ask for the preview once typing pauses, and keep the last one on screen meanwhile.
    const timer = window.setTimeout(
      () => {
        api.previewSubmit(review.id, { verdict, ...(body.trim() ? { body: body.trim() } : {}) }).then(
          (p) => alive && setPreview({ status: "ready", preview: p }),
          (e: unknown) => alive && setPreview({ status: "error", message: errorMessage(e) }),
        );
      },
      tick === 0 ? 0 : 250,
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [api, review.id, verdict, body, tick]);

  const ready = preview.status === "ready" ? preview.preview : null;
  const replies = ready?.replies ?? [];
  // Comments and replies both leave with the review; a replies-only submit with no text posts no review at all.
  const count = ready ? ready.comments.length + replies.length : review.pending_comments;
  const hasBody = body.trim().length > 0;
  const ok = ready !== null && canSubmit(verdict, count, hasBody || (ready.body.trim().length > 0 && ready.comments.some((c) => !c.path)));

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.submit(review.id, {
        verdict,
        ...(body.trim() ? { body: body.trim() } : {}),
        comment_ids: [...new Set([...ready.comments.map((c) => c.id), ...replies.map((x) => x.comment_id)])],
      });
      setResult({ result: r, verdict, replies });
      props.onSubmitted();
    } catch (e) {
      const p = submitProblem(e);
      setProblem(p);
      if (p.kind === "comments_changed") {
        props.onCommentsChanged();
        setTick((t) => t + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const r = result.result;
    const link = r.url && /^https?:\/\//.test(r.url) ? r.url : null;
    return (
      <Dialog
        title={r.posted ? "Review submitted" : "Review marked as done"}
        onClose={props.onClose}
        footer={
          <Button variant="primary" onClick={props.onClose}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p role="status" className="text-fg">
            {submittedText(review, result.verdict, r.comments.length + result.replies.length - (r.reply_errors?.length ?? 0), r.posted)}
          </p>
          {r.reply_errors?.map((x) => (
            <p key={x.comment_id} role="alert" className="flex flex-col gap-0.5 text-err">
              <span>A reply was not posted: {x.message}.</span>
              <span className="text-fg-2">
                It stays pending: “{replyText(result.replies, x.comment_id)}”. Submit again once the thread is back, or delete the reply.
              </span>
            </p>
          ))}
          {link && (
            <a href={link} target="_blank" rel="noreferrer noopener" className="w-fit text-link underline-offset-2 hover:underline">
              Open the review on {new URL(link).host}
            </a>
          )}
          {!r.posted && (
            <p className="text-fg-2">The comments are marked as submitted in this project. Hand them to the orchestrator if you want them acted on.</p>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Submit review"
      description={`${reviewTarget(review)}${review.kind === "local" ? " · local review" : ""}`}
      width="lg"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok || busy} aria-busy={busy} onClick={() => void submit()}>
            {busy && <Spinner />}
            {submitText(review, verdict, ready ? ready.comments.length : count, hasBody, replies.length)}
          </Button>
        </>
      }
    >
      <div data-review-sheet className="flex flex-col gap-4">
        <Field label="Verdict" hint={VERDICTS.find((v) => v.id === verdict)?.hint}>
          <Segmented<ReviewVerdict> label="Verdict" value={verdict} onChange={setVerdict} options={VERDICTS.map((v) => ({ id: v.id, label: v.label }))} />
        </Field>
        <Field label="Review text" htmlFor={bodyId} optional>
          <Textarea
            id={bodyId}
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Summary for the author"
            className="max-sm:text-input-touch"
          />
        </Field>
        {problem && (
          <div role="alert" className="flex flex-col gap-2 rounded-md bg-code-bg p-3 text-sm">
            <p className="font-medium text-err">{problem.title}</p>
            <p className="text-fg-2">{problem.advice}</p>
            {problem.command && <CommandLine command={problem.command} />}
          </div>
        )}
        <section aria-label="What will be posted" className="flex flex-col gap-2">
          <h3 className="text-heading text-fg">{review.kind === "local" ? "What will be recorded" : "What will be posted"}</h3>
          {preview.status === "loading" && (
            <p className="flex items-center gap-2 text-sm text-fg-3">
              <Spinner /> Preparing the preview…
            </p>
          )}
          {preview.status === "error" && (
            <p role="alert" className="text-sm text-err">
              The preview did not load: {preview.message}. Close this sheet and open it again.
            </p>
          )}
          {ready && <PreviewBody preview={ready} />}
        </section>
      </div>
    </Dialog>
  );
}

function PreviewBody({ preview }: { preview: ReviewSubmitPreview }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-fg-2">
        {preview.posts ? "Verdict: " : "Verdict (kept here only): "}
        <strong className="font-medium text-fg">{verdictLabel(preview.verdict)}</strong>
      </p>
      {!preview.posts && <p className="text-fg-2">This is a local review: nothing is posted to a code host.</p>}
      {preview.body.trim() && (
        <figure className="flex flex-col gap-1">
          <figcaption className="text-xs text-fg-3">Review text, exactly as it will be posted</figcaption>
          <pre className="rounded-md bg-code-bg p-3 font-sans text-sm break-words whitespace-pre-wrap text-fg">{preview.body}</pre>
        </figure>
      )}
      {preview.comments.length === 0 && !(preview.replies?.length ?? 0) ? (
        <p className="text-fg-3">No comments.</p>
      ) : (
        // R5 (polish step 6b): the drafts are list rows (glyph column, where as meta, the text word for word), split by hairlines.
        <ol className="flex flex-col">
          {preview.comments.map((c) => (
            <DraftRow key={c.id} icon={MessageSquare} where={commentWhere(c)} body={c.body}>
              {c.suggestion !== undefined && (
                <pre className="overflow-x-auto rounded-sm bg-code-bg px-2 py-1.5 font-mono text-xs leading-5 text-fg">
                  <span className="mb-1 block font-sans text-fg-3">Suggested change</span>
                  {c.suggestion || " "}
                </pre>
              )}
            </DraftRow>
          ))}
        </ol>
      )}
      {(preview.replies?.length ?? 0) > 0 && (
        <section aria-label="Replies" className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-fg-3">
            {preview.replies?.length === 1
              ? "1 reply, posted into its thread after the review"
              : `${preview.replies?.length} replies, each posted into its thread after the review`}
          </h4>
          <ol className="flex flex-col">
            {preview.replies?.map((x) => (
              <DraftRow key={x.comment_id} icon={Reply} body={x.body} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function DraftRow(props: { icon: LucideIcon; where?: string; body: string; children?: ReactNode }) {
  return (
    <li className="flex gap-2 border-t border-line py-2 first:border-t-0 first:pt-1">
      <span aria-hidden className="grid h-5 w-4 shrink-0 place-items-center text-fg-3">
        <Glyph icon={props.icon} size={14} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {props.where && <p className="font-mono text-xs break-all text-fg-3">{props.where}</p>}
        <p className="break-words whitespace-pre-wrap text-fg">{props.body}</p>
        {props.children}
      </div>
    </li>
  );
}

function replyText(replies: readonly ReviewReplyPost[], id: string): string {
  const t = replies.find((x) => x.comment_id === id)?.body ?? "";
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

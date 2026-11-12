import { useCallback, useState } from "react";
import type { ReviewComment, ReviewCommentInput, ReviewCommentUpdate, ReviewFinding, ReviewFindingDecision } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import type { ReviewApi } from "../../lib/review/api";
import { commentError, errorCode } from "../../lib/review/position";
import { withFile, type ReviewData } from "./useReview";

/**
 * The writes of a review: viewed marks, comments, findings. Each updates the screen from the API's answer at once and
 * then reloads quietly for the counts; a refusal comes back as the sentence to show, never swallowed.
 */
export function useReviewActions(api: ReviewApi, id: string, patch: (fn: (d: ReviewData) => ReviewData) => void, reload: () => Promise<void>) {
  const [problem, setProblem] = useState<string | null>(null);

  const setViewed = useCallback(
    async (path: string, viewed: boolean) => {
      patch((d) => ({ ...d, files: { ...d.files, files: d.files.files.map((f) => (f.path === path ? { ...f, viewed, changed_since_viewed: false } : f)) } }));
      try {
        const f = await api.setViewed(id, path, viewed);
        patch((d) => ({ ...d, files: withFile(d.files, f) }));
      } catch (e) {
        setProblem(`“Viewed” was not saved: ${errorMessage(e)}. Try again.`);
        void reload();
      }
    },
    [api, id, patch, reload],
  );

  const addComment = useCallback(
    async (input: ReviewCommentInput): Promise<string | null> => {
      try {
        const c = await api.addComment(id, input);
        patch((d) => ({ ...d, comments: [...d.comments, c] }));
        void reload();
        return null;
      } catch (e) {
        return commentError(errorCode(e), errorMessage(e));
      }
    },
    [api, id, patch, reload],
  );

  const updateComment = useCallback(
    async (c: ReviewComment, change: ReviewCommentUpdate): Promise<string | null> => {
      try {
        const next = await api.updateComment(id, c.id, change);
        patch((d) => ({ ...d, comments: d.comments.map((x) => (x.id === next.id ? next : x)) }));
        void reload();
        return null;
      } catch (e) {
        return commentError(errorCode(e), errorMessage(e));
      }
    },
    [api, id, patch, reload],
  );

  const deleteComment = useCallback(
    async (c: ReviewComment) => {
      setProblem(null);
      try {
        await api.deleteComment(id, c.id);
        patch((d) => ({ ...d, comments: d.comments.filter((x) => x.id !== c.id) }));
        void reload();
      } catch (e) {
        setProblem(commentError(errorCode(e), errorMessage(e)));
      }
    },
    [api, id, patch, reload],
  );

  const decideFinding = useCallback(
    async (f: ReviewFinding, d: ReviewFindingDecision) => {
      setProblem(null);
      try {
        const r = await api.decideFinding(id, f.id, d);
        patch((data) => ({
          ...data,
          findings: data.findings.map((x) => (x.id === r.finding.id ? r.finding : x)),
          comments: r.comment ? [...data.comments.filter((c) => c.id !== r.comment?.id), r.comment] : data.comments.filter((c) => c.finding_id !== f.id),
        }));
        void reload();
      } catch (e) {
        setProblem(`The finding was not updated: ${errorMessage(e)}. Try again.`);
      }
    },
    [api, id, patch, reload],
  );

  return { problem, clearProblem: () => setProblem(null), setViewed, addComment, updateComment, deleteComment, decideFinding };
}

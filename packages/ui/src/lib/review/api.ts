import type {
  Bridge,
  FolderEntry,
  OpenReviewInput,
  PullRequestList,
  Review,
  ReviewComment,
  ReviewCommentInput,
  ReviewCommentUpdate,
  ReviewDiffOptions,
  ReviewFile,
  ReviewFileDiff,
  ReviewFiles,
  ReviewFinding,
  ReviewFindingDecision,
  ReviewFindingResult,
  ReviewPatch,
  ReviewSubmitInput,
  ReviewSubmitPreview,
  ReviewSubmitResult,
  ReviewSummary,
} from "@octo/agent-client";

/** The review methods of a bridge bound to one project, all present (the bridge's are optional: HTTP bridge and demo only). */
export type ReviewApi = {
  listPullRequests(folder?: string): Promise<PullRequestList>;
  listOpen(): Promise<ReviewSummary[]>;
  open(input: OpenReviewInput): Promise<Review>;
  get(id: string): Promise<Review>;
  patch(id: string, patch: ReviewPatch): Promise<Review>;
  files(id: string): Promise<ReviewFiles>;
  diff(id: string, path: string, options?: ReviewDiffOptions): Promise<ReviewFileDiff>;
  rawUrl(id: string, path: string, side: "new" | "old"): string;
  setViewed(id: string, path: string, viewed: boolean): Promise<ReviewFile>;
  comments(id: string): Promise<ReviewComment[]>;
  addComment(id: string, input: ReviewCommentInput): Promise<ReviewComment>;
  updateComment(id: string, cid: string, patch: ReviewCommentUpdate): Promise<ReviewComment>;
  deleteComment(id: string, cid: string): Promise<void>;
  findings(id: string): Promise<ReviewFinding[]>;
  decideFinding(id: string, fid: string, decision: ReviewFindingDecision): Promise<ReviewFindingResult>;
  previewSubmit(id: string, input: ReviewSubmitInput): Promise<ReviewSubmitPreview>;
  submit(id: string, input: ReviewSubmitInput): Promise<ReviewSubmitResult>;
  recentFolders(): Promise<FolderEntry[]>;
};

/** Binds the bridge to a project; null when the bridge lacks any review method (an older harness). */
export function reviewApi(b: Bridge, p: string): ReviewApi | null {
  if (
    !b.listPullRequests ||
    !b.listReviews ||
    !b.openReview ||
    !b.getReview ||
    !b.patchReview ||
    !b.listReviewFiles ||
    !b.getReviewFileDiff ||
    !b.reviewFileRawUrl ||
    !b.setReviewFileViewed ||
    !b.listReviewComments ||
    !b.createReviewComment ||
    !b.updateReviewComment ||
    !b.deleteReviewComment ||
    !b.listReviewFindings ||
    !b.decideReviewFinding ||
    !b.previewReviewSubmit ||
    !b.submitReview
  )
    return null;
  const listPullRequests = b.listPullRequests.bind(b);
  const listReviews = b.listReviews.bind(b);
  const openReview = b.openReview.bind(b);
  const getReview = b.getReview.bind(b);
  const patchReview = b.patchReview.bind(b);
  const listReviewFiles = b.listReviewFiles.bind(b);
  const getReviewFileDiff = b.getReviewFileDiff.bind(b);
  const reviewFileRawUrl = b.reviewFileRawUrl.bind(b);
  const setReviewFileViewed = b.setReviewFileViewed.bind(b);
  const listReviewComments = b.listReviewComments.bind(b);
  const createReviewComment = b.createReviewComment.bind(b);
  const updateReviewComment = b.updateReviewComment.bind(b);
  const deleteReviewComment = b.deleteReviewComment.bind(b);
  const listReviewFindings = b.listReviewFindings.bind(b);
  const decideReviewFinding = b.decideReviewFinding.bind(b);
  const previewReviewSubmit = b.previewReviewSubmit.bind(b);
  const submitReview = b.submitReview.bind(b);
  return {
    listPullRequests: (folder) => listPullRequests(p, folder ? { folder } : undefined),
    listOpen: () => listReviews(p, "open"),
    open: (input) => openReview(p, input),
    get: (id) => getReview(p, id),
    patch: (id, patch) => patchReview(p, id, patch),
    files: (id) => listReviewFiles(p, id),
    diff: (id, path, o) => getReviewFileDiff(p, id, path, o),
    rawUrl: (id, path, side) => reviewFileRawUrl(p, id, path, side),
    setViewed: (id, path, v) => setReviewFileViewed(p, id, path, v),
    comments: (id) => listReviewComments(p, id),
    addComment: (id, input) => createReviewComment(p, id, input),
    updateComment: (id, cid, patch) => updateReviewComment(p, id, cid, patch),
    deleteComment: (id, cid) => deleteReviewComment(p, id, cid),
    findings: (id) => listReviewFindings(p, id),
    decideFinding: (id, fid, d) => decideReviewFinding(p, id, fid, d),
    previewSubmit: (id, input) => previewReviewSubmit(p, id, input),
    submit: (id, input) => submitReview(p, id, input),
    recentFolders: () => b.recentFolders?.() ?? Promise.resolve([]),
  };
}

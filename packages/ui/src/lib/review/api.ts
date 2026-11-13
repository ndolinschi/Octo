import type {
  Bridge,
  FolderEntry,
  OpenReviewInput,
  ListPullRequestsParams,
  PullRequestList,
  Review,
  ReviewBranchList,
  ReviewCheckoutInput,
  ReviewCheckoutResult,
  ReviewThreads,
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
  listPullRequests(params?: ListPullRequestsParams): Promise<PullRequestList>;
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
  /** Existing threads of the code host; absent on a harness that predates RV1.5. */
  threads: ((id: string, refresh?: boolean) => Promise<ReviewThreads>) | null;
  checkout: ((id: string, input: ReviewCheckoutInput) => Promise<ReviewCheckoutResult>) | null;
  clearWorkspace: (() => Promise<void>) | null;
  recentFolders(): Promise<FolderEntry[]>;
  /** The folder's local branches against a base (decision 84); null on a harness that cannot list them. */
  branches: ((params: { folder?: string; base?: string }) => Promise<ReviewBranchList>) | null;
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
  const listThreads = b.listReviewThreads?.bind(b);
  const checkoutReview = b.checkoutReview?.bind(b);
  const clearWorkspace = b.clearReviewWorkspace?.bind(b);
  const listBranches = b.listReviewBranches?.bind(b);
  return {
    listPullRequests: (params) => listPullRequests(p, params),
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
    threads: listThreads ? (id, refresh) => listThreads(p, id, refresh ? { refresh } : undefined) : null,
    checkout: checkoutReview ? (id, input) => checkoutReview(p, id, input) : null,
    clearWorkspace: clearWorkspace ? () => clearWorkspace(p) : null,
    recentFolders: () => b.recentFolders?.() ?? Promise.resolve([]),
    branches: listBranches ? (params) => listBranches(p, params) : null,
  };
}

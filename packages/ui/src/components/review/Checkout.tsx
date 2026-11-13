import { X } from "lucide-react";
import type { Review } from "@octo/agent-client";
import { checkoutSentence, dirtyList, dirtyStatusWord, goBackCommand, hasConflicts } from "../../lib/review/checkout";
import { Button, IconButton } from "../primitives/Button";
import { CommandLine } from "../primitives/CommandLine";
import { Dialog } from "../primitives/Dialog";
import type { MenuItem } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { Spinner } from "../primitives/Status";
import { TextMenu } from "./parts";
import type { useCheckout } from "./useCheckout";

type Checkout = ReturnType<typeof useCheckout>;

/** The check-out choices: the two modes, and the way back while this review is the project's workspace. Empty when there is none. */
export function checkoutItems(checkout: Checkout, review: Review): MenuItem[] {
  if (!checkout.available || review.state === "closed") return [];
  return [
    ...(checkout.inWorkspace ? [{ id: "back", label: "Back to my folder", run: () => void checkout.back() }] : []),
    {
      id: "workspace",
      label: "Open in workspace (read-only)",
      title: "Point the file tree, editor and language server at this pull request. Your folder is untouched.",
      disabled: checkout.inWorkspace || !review.worktree_present,
      run: () => void checkout.openWorkspace(),
    },
    ...(review.kind === "github"
      ? [
          {
            id: "folder",
            label: "Check out in my folder…",
            title: "Switch your working copy to this pull request's branch. Uncommitted changes are shown first.",
            run: () => void checkout.startWorkingCopy(),
          },
        ]
      : []),
  ];
}

/** "Check out ▾" in the review header (28px like the header's other controls). */
export function CheckoutMenu({ checkout, review, className }: { checkout: Checkout; review: Review; className?: string }) {
  const items = checkoutItems(checkout, review);
  if (items.length === 0) return null;
  return <TextMenu label="Check out" text={checkout.busy ? "Checking out…" : "Check out"} alignEnd items={items} {...(className ? { className } : {})} />;
}

/** One line under the header that says where you are after a check out, and how to go back. */
export function CheckoutBanner({ checkout }: { checkout: Checkout }) {
  const s = checkout.switched;
  if (!checkout.inWorkspace && !s && !checkout.error) return null;
  const back = s ? goBackCommand(s) : null;
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5 text-sm">
      {checkout.error && (
        <>
          <span role="alert" className="min-w-0 flex-1 text-err">
            {checkout.error}
          </span>
          <IconButton icon={X} label="Dismiss" onClick={checkout.dismissError} className="max-md:size-10" />
        </>
      )}
      {!checkout.error && checkout.inWorkspace && (
        <>
          <span className="min-w-0 flex-1 text-fg-2">Workspace: the file tree, editor and language server show this pull request, read-only.</span>
          <Button size="sm" variant="secondary" disabled={checkout.busy} onClick={() => void checkout.back()} className="max-md:h-10">
            Back to my folder
          </Button>
        </>
      )}
      {!checkout.error && !checkout.inWorkspace && s && (
        <>
          <span className="min-w-0 flex-1 text-fg-2">
            {checkoutSentence(s)} {back ? "To go back:" : ""}
          </span>
          {back && <CommandLine command={back} />}
          <IconButton icon={X} label="Dismiss" onClick={checkout.dismissSwitched} className="max-md:size-10" />
        </>
      )}
    </div>
  );
}

/** The uncommitted files and an explicit confirm; conflicts cannot be carried, so there is no confirm for them. */
export function DirtyDialog({ checkout }: { checkout: Checkout }) {
  const files = checkout.dirty;
  const { shown, more } = dirtyList(files ?? []);
  const conflicts = files ? hasConflicts(files) : false;
  return (
    <Presence show={files !== null}>
      {files && (
        <Dialog
          title="Your folder has uncommitted changes"
          description="Checking out the review branch carries them along. Nothing is discarded or overwritten."
          onClose={checkout.closeDirty}
          footer={
            <>
              <Button variant="ghost" onClick={checkout.closeDirty}>
                Cancel
              </Button>
              <Button variant="primary" disabled={conflicts || checkout.busy} aria-busy={checkout.busy} onClick={() => void checkout.confirmWorkingCopy()}>
                {checkout.busy && <Spinner />}
                Check out and keep my changes
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm">
            <ul aria-label="Uncommitted files" className="flex flex-col gap-1">
              {shown.map((f) => (
                <li key={f.path} className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={f.path}>
                    {f.path}
                  </span>
                  <span className="shrink-0 text-xs text-fg-3">{dirtyStatusWord(f.status)}</span>
                </li>
              ))}
              {more > 0 && <li className="text-xs text-fg-3">and {more} more</li>}
            </ul>
            {conflicts && (
              <p role="alert" className="text-err">
                Some files have merge conflicts. Resolve them in git first; they cannot be carried to another branch.
              </p>
            )}
            <p className="text-fg-3">Afterwards this window shows the branch you are on and the command that takes you back.</p>
          </div>
        </Dialog>
      )}
    </Presence>
  );
}

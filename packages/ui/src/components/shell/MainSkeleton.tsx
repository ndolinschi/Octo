import { SkeletonText } from "../primitives/Skeleton";

/**
 * The main area while the projects or the open project load (owner's audit item 7): a few static lines on the panel
 * surface, in the conversation's column, instead of an empty card. It fades in only after a short wait (`octo-fade-late`),
 * so a fast load never flashes it; nothing in it animates (decision 76), and the real content replaces it in the same box.
 */
export function MainSkeleton() {
  return (
    <div aria-busy className="octo-fade-late mx-auto w-full max-w-measure px-6 pt-10 max-drawer:px-4">
      <SkeletonText lines={3} />
    </div>
  );
}

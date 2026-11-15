import { Skeleton, SkeletonList } from "../primitives/Skeleton";

/**
 * The main area while the projects or the open project load (owner's audit item 7): a structured placeholder on the
 * panel surface, in the conversation's column, instead of an empty card or bare text. It fades in only after a short
 * wait (`octo-fade-late`), so a fast load never flashes it; nothing in it animates (decision 76), and the real content
 * replaces it in the same box.
 */
export function MainSkeleton() {
  return (
    <div aria-busy className="octo-fade-late mx-auto flex w-full max-w-measure flex-col gap-6 px-6 pt-10 max-drawer:px-4">
      <div className="flex flex-col gap-2">
        <Skeleton width="10rem" className="h-3.5" />
        <Skeleton width="16rem" />
      </div>
      <div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border border-line/60 px-3 py-3">
            <Skeleton shape="circle" />
            <Skeleton width={i % 2 === 0 ? "55%" : "45%"} />
          </div>
        ))}
      </div>
      <SkeletonList count={4} size="lg" twoLine leading={false} />
    </div>
  );
}

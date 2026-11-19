import { cn } from "../../lib/cn";
import { Skeleton } from "./Skeleton";

// Only lazy views draw text placeholders: apart from `Skeleton`, which the entry imports.
/** Several text lines; the last is shorter. */
export function SkeletonText({ lines = 3, shimmer = false, className }: { lines?: number; shimmer?: boolean; className?: string }) {
  return (
    <div aria-hidden className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} shimmer={shimmer} width={i === lines - 1 && lines > 1 ? "60%" : "100%"} />
      ))}
    </div>
  );
}

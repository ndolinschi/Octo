import { middleSplit, type MiddleSplit } from "../../lib/truncate";

/**
 * A label cut in the middle only when its row is too narrow (CSS, no character budget): the head gives way with an
 * ellipsis while the last characters stay ("product-configura…nager"). A short label is one plain span. Put the full text
 * in the tooltip of the control that holds it. For file names, folder and project names, branches and ids; ordinary titles
 * and prose use `truncate`. `ListRow` and `Chip` use it.
 *
 * `split`: a cut worked out by the caller, `lib/distinctSplit` for a name shown beside others that share its head (a
 * project's folders: "product-con…facade-service") or a folder chain. A `distinct` tail is what tells the name apart: the
 * head gives way first, down to its first letter, and only then the tail.
 */
export function MiddleText({ text, split = middleSplit(text), className }: { text: string; split?: MiddleSplit | null; className?: string }) {
  if (!split) return <span className={className ? `min-w-0 truncate ${className}` : "min-w-0 truncate"}>{text}</span>;
  return (
    <span className={className ? `flex min-w-0 items-baseline ${className}` : "flex min-w-0 items-baseline"}>
      <span className={split.distinct ? "min-w-4 truncate" : "min-w-0 truncate"}>{split.head}</span>
      {/* The distinguishing tail never shrinks while the head can; it is cut only past the head's first letter (min-w-4). */}
      <span className={split.distinct ? "max-w-[calc(100%-var(--spacing)*4)] shrink-0 truncate" : "shrink-0"}>{split.tail}</span>
    </span>
  );
}

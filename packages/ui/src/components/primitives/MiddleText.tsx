import { middleSplit } from "../../lib/truncate";

/**
 * A label cut in the middle only when its row is too narrow (CSS, no character budget): the head gives way with an
 * ellipsis while the last characters stay ("product-configura…nager"). A short label is one plain span. Put the full text
 * in the tooltip of the control that holds it. For file names, folder and project names, branches and ids; ordinary titles
 * and prose use `truncate`. `ListRow` and `Chip` use it.
 *
 * `siblings`: the other names shown beside this one (a project's folders). The tail is then the part that tells this name
 * apart ("product-con…facade-service"); the head gives way first, down to its first letter, and only then the tail.
 */
export function MiddleText({ text, siblings, className }: { text: string; siblings?: readonly string[]; className?: string }) {
  const split = middleSplit(text, siblings);
  if (!split) return <span className={className ? `min-w-0 truncate ${className}` : "min-w-0 truncate"}>{text}</span>;
  return (
    <span className={className ? `flex min-w-0 items-baseline ${className}` : "flex min-w-0 items-baseline"}>
      <span className={split.distinct ? "min-w-4 truncate" : "min-w-0 truncate"}>{split.head}</span>
      {/* The distinguishing tail never shrinks while the head can; it is cut only past the head's first letter (min-w-4). */}
      <span className={split.distinct ? "max-w-[calc(100%-var(--spacing)*4)] shrink-0 truncate" : "shrink-0"}>{split.tail}</span>
    </span>
  );
}

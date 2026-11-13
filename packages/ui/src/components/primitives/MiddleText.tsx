import { middleSplit } from "../../lib/truncate";

/**
 * A label cut in the middle only when its row is too narrow (CSS, no character budget): the head gives way with an
 * ellipsis while the last characters stay ("product-configura…nager"). A short label is one plain span. Put the full text
 * in the tooltip of the control that holds it. For file names, branches and ids; ordinary titles use `truncate`.
 * `ListRow` and `Chip` use it; a feature does not need to.
 */
export function MiddleText({ text, className }: { text: string; className?: string }) {
  const split = middleSplit(text);
  if (!split) return <span className={className ? `min-w-0 truncate ${className}` : "min-w-0 truncate"}>{text}</span>;
  return (
    <span className={className ? `flex min-w-0 items-baseline ${className}` : "flex min-w-0 items-baseline"}>
      <span className="min-w-0 truncate">{split.head}</span>
      <span className="shrink-0">{split.tail}</span>
    </span>
  );
}

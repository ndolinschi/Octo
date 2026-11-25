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
    // `data-distinct` (styles.css, `.octo-mid`): the tail never shrinks while the head can; it is cut only past the head's
    // first letter. In CSS, not class strings, to keep the entry chunk small.
    <span data-distinct={split.distinct} className={className ? `octo-mid flex min-w-0 items-baseline ${className}` : "octo-mid flex min-w-0 items-baseline"}>
      <span className="min-w-0 truncate">{split.head}</span>
      <span className="shrink-0">{split.tail}</span>
    </span>
  );
}

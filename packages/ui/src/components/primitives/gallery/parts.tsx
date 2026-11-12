import type { ReactNode } from "react";
import { SectionHeader } from "../SectionHeader";

/** One gallery section: the script screenshots each `[data-gallery-section]`. */
export function Section(props: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section data-gallery-section={props.id} aria-labelledby={`g-${props.id}`} className="flex flex-col gap-3">
      <SectionHeader level="title" id={`g-${props.id}`}>
        {props.title}
      </SectionHeader>
      {props.note && <p className="max-w-prose text-xs text-fg-3">{props.note}</p>}
      <div className="flex flex-col gap-4">{props.children}</div>
    </section>
  );
}

/** A labelled row of variants. */
export function Variants(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-fg-3">{props.label}</span>
      <div className="flex flex-wrap items-center gap-3">{props.children}</div>
    </div>
  );
}

/** A fixed-width cell: fields fill their parent, so the gallery gives them a parent. */
export function W(props: { w?: string; children: ReactNode }) {
  return <div className={props.w ?? "w-40"}>{props.children}</div>;
}

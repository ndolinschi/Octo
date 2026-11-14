import { File, GitPullRequest, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../Button";
import { Card, ListFrame } from "../Card";
import { IconButton } from "../IconButton";
import { KeyHint } from "../KeyHint";
import { ListRow } from "../ListRow";
import { Notice } from "../Notice";
import { ScrollArea } from "../ScrollArea";
import { SectionHeader } from "../SectionHeader";
import { Skeleton, SkeletonList, SkeletonText } from "../Skeleton";
import { Checkbox } from "../Checkbox";
import { Presence } from "../Presence";
import { Sheet } from "../Sheet";
import { Section, Variants } from "./parts";

const TONES = ["info", "warn", "error", "success"] as const;

export function RowsSection() {
  const [sel, setSel] = useState(1);
  const [checked, setChecked] = useState(false);
  return (
    <Section id="rows" title="ListRow, SectionHeader, ScrollArea" note="Hover a row to see its trailing actions; they never change its width.">
      <div className="grid gap-4 md:grid-cols-3">
        {(["sm", "md", "lg"] as const).map((size) => (
          <div key={size} className="flex flex-col">
            <SectionHeader inset aside={<span>{size}</span>}>
              Row size {size}
            </SectionHeader>
            {[0, 1, 2].map((i) => (
              <ListRow
                key={i}
                size={size}
                selected={sel === i}
                leading={<File size={14} />}
                title={i === 2 ? "a-very-long-file-name-that-needs-the-middle-cut.test.tsx" : `Row ${i + 1}`}
                truncate={i === 2 ? "middle" : "end"}
                meta={i === 0 ? "12m ago" : undefined}
                trailing={<IconButton icon={X} label="Remove" size="xs" />}
                onClick={() => setSel(i)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col">
          <SectionHeader inset>Two-line rows, a checkbox control, a disabled row, a static row</SectionHeader>
          <ListRow
            control={<Checkbox checked={checked} onChange={setChecked} label="Select" hideLabel />}
            leading={<GitPullRequest size={14} />}
            title="Fix flaky review test"
            description="#482 · opened by ana · 3 files"
            meta="2h"
            onClick={() => undefined}
          />
          <ListRow
            leading={<GitPullRequest size={14} />}
            title="Needs your review"
            description="Waiting on you"
            tone="quiet"
            selected
            onClick={() => undefined}
          />
          <ListRow title="Disabled row" disabled onClick={() => undefined} />
          <ListRow title="Static row (no action)" tone="quiet" meta={<KeyHint always>K</KeyHint>} />
        </div>
        <div className="flex flex-col gap-2">
          <SectionHeader
            level="title"
            aside={
              <Button variant="quiet" size="xs">
                Clear
              </Button>
            }
          >
            Title header with aside
          </SectionHeader>
          <ScrollArea gutter="stable" fade className="h-28 rounded-md border border-line p-1" tabIndex={0} role="region" aria-label="Scroll demo">
            {Array.from({ length: 12 }, (_, i) => (
              <ListRow key={i} title={`Scrolled row ${i + 1}`} onClick={() => undefined} trailing={<IconButton icon={Trash2} label="Delete" size="xs" />} />
            ))}
          </ScrollArea>
        </div>
      </div>
    </Section>
  );
}

export function SurfacesSection() {
  const [sheet, setSheet] = useState<"bottom" | "full" | null>(null);
  return (
    <Section
      id="surfaces"
      title="Notice, Card, ListFrame, Skeleton, KeyHint"
      note="No coloured borders (decision 81): tone is the glyph and the text colour. Skeletons are static unless shimmer is set."
    >
      {TONES.map((tone) => (
        <Variants key={tone} label={`Notice ${tone}`}>
          <Notice
            tone={tone}
            action={
              <Button variant="link" size="xs">
                Retry
              </Button>
            }
          >
            Line form: one inline message with an action.
          </Notice>
          <Notice
            tone={tone}
            form="block"
            title="Block form"
            {...(tone === "error" ? { command: "harness doctor" } : {})}
            actions={<Button size="sm">Try again</Button>}
            className="w-80"
          >
            Title, text, optional copy line and actions.
          </Notice>
        </Variants>
      ))}
      <Variants label="Card: surfaces, paddings, header and footer">
        <Card className="w-44">raised, md</Card>
        <Card surface="panel" padding="sm" className="w-44">
          panel, sm
        </Card>
        <Card surface="code" padding="lg" className="w-44">
          code, lg
        </Card>
        <Card header="Header" footer={<span className="text-xs text-fg-3">Footer</span>} className="w-44">
          With slots
        </Card>
        <ListFrame className="w-56">
          <ListRow title="ListFrame row 1" onClick={() => undefined} />
          <ListRow title="ListFrame row 2" onClick={() => undefined} />
        </ListFrame>
      </Variants>
      <Variants label="Sheet (phone layout): bottom or full screen; a history entry, so Back closes it">
        <Button onClick={() => setSheet("bottom")}>Bottom sheet</Button>
        <Button onClick={() => setSheet("full")}>Full-screen sheet</Button>
        <Presence show={sheet !== null}>
          <Sheet label={sheet === "full" ? "Full-screen sheet" : "Bottom sheet"} variant={sheet ?? "bottom"} onClose={() => setSheet(null)}>
            <div className="flex flex-col px-2 pb-2">
              <ListRow size="lg" title="A 44px row on the phone" onClick={() => setSheet(null)} />
              <ListRow size="lg" title="Another row" onClick={() => setSheet(null)} />
            </div>
          </Sheet>
        </Presence>
      </Variants>
      <Variants label="Skeleton: bar, block, circle, text, list (28 and two-line), shimmer while loading">
        <Skeleton width={96} />
        <Skeleton shape="block" width={96} />
        <Skeleton shape="circle" />
        <SkeletonText lines={3} className="w-40" />
        <SkeletonList count={3} className="w-44" />
        <SkeletonList count={2} twoLine className="w-44" shimmer />
      </Variants>
      <Variants label="KeyHint (hidden under 640px unless always)">
        <KeyHint always>⌘</KeyHint>
        <KeyHint always>K</KeyHint>
        <KeyHint always>Esc</KeyHint>
      </Variants>
    </Section>
  );
}

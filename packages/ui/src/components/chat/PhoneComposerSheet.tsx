import { AtSign, ImagePlus, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { Sheet } from "../primitives/Sheet";

/**
 * Direction 7: the phone composer's "+" (part of the "+" menu's chunk): a bottom sheet with what the desktop row holds beside
 * the field — attach images, mention a file or run an action (the "+" list itself), and the mode and model chips and the folders and
 * session entries, each opening its own picker (a sheet too: `styles.css`, "phone layout").
 */
export function PhoneComposerSheet(props: {
  chips: ReactNode;
  sendTo?: readonly { id: string; label: string; icon: LucideIcon; run(): void }[] | undefined;
  onClose(): void;
  onImage(): void;
  onMenu(): void;
}) {
  return (
    <Sheet label="Add to the message" onClose={props.onClose}>
      <div data-phone-composer-sheet className="flex flex-col px-2 pb-2">
        <ListRow size="lg" leading={<Glyph icon={ImagePlus} size={16} />} title="Attach images" onClick={props.onImage} />
        <ListRow size="lg" leading={<Glyph icon={AtSign} size={16} />} title="Mention a file, or run an action" onClick={props.onMenu} />
        {props.chips && (
          <>
            <h3 className="flex h-ctl-sm items-center px-2 pt-2 text-xs text-fg-3">This message</h3>
            <div className="flex flex-wrap gap-2 px-1 pb-2">{props.chips}</div>
          </>
        )}
        {props.sendTo?.map((t) => (
          <ListRow key={t.id} size="lg" leading={<Glyph icon={t.icon} size={16} />} title={t.label} onClick={t.run} />
        ))}
      </div>
    </Sheet>
  );
}

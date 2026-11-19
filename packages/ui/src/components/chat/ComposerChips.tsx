import type { Folder } from "@octo/agent-client";
import type { ReactNode } from "react";
import { ModelPicker } from "../shared/ModelPicker";

export type ChipProps = { bare: boolean; disabled: boolean; onOpenChange(open: boolean): void };

/** The project's model or agent (decision 58): the shared model control, the same one the title bar shows. */
export function ModelChip(
  props: ChipProps & {
    footer?: ReactNode;
    openRequest?: { n: number; query: string } | undefined;
    value: string;
    title?: string | undefined;
    unavailable?: boolean;
    short?: boolean;
    onChoose(value: string): void;
    onChooseUnverified?: (value: string) => void;
  },
) {
  return (
    <ModelPicker
      label="Model"
      value={props.value}
      onChoose={props.onChoose}
      onChooseUnverified={props.onChooseUnverified}
      bare={props.bare}
      {...(props.short ? { short: true } : {})}
      disabled={props.disabled}
      side="top"
      warn={props.unavailable === true}
      tip={props.unavailable ? "This model's provider is not connected" : props.title}
      footer={props.footer}
      openRequest={props.openRequest}
      onOpenChange={props.onOpenChange}
    />
  );
}

/** The label of the folders entry in the "+" menu: the first one's name (+N). */
export function foldersLabel(folders: readonly Folder[]): string {
  const [first] = folders;
  return first ? (folders.length > 1 ? `${first.label} +${folders.length - 1}` : first.label) : "No folder";
}

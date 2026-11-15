import type { ReactNode } from "react";

/** The model picker's props (decisions 53, 56, 58): shared by the chip and its lazy list without an import cycle. */
export type ModelPickerProps = {
  /** What the setting is, for the chip's and the picker's names ("Model", "Fast tier model"). */
  label: string;
  /** The setting: a model id or `acp:<agent>[/<model>]`. */
  value: string;
  onChoose(value: string): void;
  /**
   * "Use anyway" for an agent the login probe says is logged out: choose `acp:<agent>` without the harness's login check
   * (it is advisory). Without it the picker offers only "Check again" on such a row.
   */
  onChooseUnverified?: ((value: string) => void) | undefined;
  /** Offer the typed text as a model id of its own (project settings: any id the provider accepts). */
  custom?: boolean;
  disabled?: boolean;
  /** `chip`: the composer's and the title bar's one model control; `field`: the project dialog (a 32px input-like button). */
  variant?: "chip" | "field";
  /** The chip shows the model alone ("Opus 5.5", the agent's mark in front); the full name stays in the tooltip and the list. */
  short?: boolean;
  /** The composer sheds the label when its row is too narrow. */
  bare?: boolean;
  /** Where the list opens: above a control at the bottom of the window, below one at the top. */
  side?: "top" | "bottom";
  /** The harness cannot run this setting now: the chip turns warn-coloured. */
  warn?: boolean;
  /** The caller already says what is wrong (a notice above the group, as Settings → Models does): the value keeps the normal tone; the tooltip still says it. */
  problemShown?: boolean;
  /** Tooltip (the served model, the unavailable reason); default "Model: <label>". */
  tip?: string | undefined;
  onOpenChange?(open: boolean): void;
  /** Opens the list from outside (`/model`): a new `n` opens it, with `query` typed in the search field. */
  openRequest?: { n: number; query: string } | undefined;
  /** A line under the top-level list (the composer puts "Routing: Auto" here when a router is connected, decision 91e). */
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
};

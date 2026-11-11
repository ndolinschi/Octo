import type { Models, TierPolicy } from "@octo/agent-client";
import type { ReactNode } from "react";

/** The model picker's props (decision 27): shared by the button and its lazy list without an import cycle. */
export type ModelPickerProps = {
  /** What the setting is, for the button's and the picker's names ("Orchestrator model"). */
  label: string;
  value: string;
  onChoose(value: string): void;
  /** The project's tiers, offered first (the orchestrator's picker). */
  tiers?: Pick<Models, "fast" | "balanced" | "deep">;
  /** Model ids the harness knows (the project's and the bridge's defaults). */
  known: readonly string[];
  /** The project's routing policy (decision 37), shown under the list when a router is detected. */
  policy?: { value: TierPolicy; onChange(policy: TierPolicy): void } | null;
  disabled?: boolean;
  /** `bar`: the composer's context bar (14px glyph, 24px); `field`: the project dialog (a 32px input-like button). */
  variant?: "bar" | "field" | "text";
  className?: string;
  /** Text shown on the button instead of the model's name (the header shows the served model). */
  children?: ReactNode;
  title?: string;
  /** Offer the typed text as a model id of its own (project settings: any id the provider accepts). */
  custom?: boolean;
};

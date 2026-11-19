import { ArrowUp, ChevronDown, Download, Plus, Settings, Trash2, X } from "lucide-react";
import { useState } from "react";
import { CONTROL_PX, CONTROL_SIZES } from "../../../lib/controls";
import { Button } from "../Button";
import { Chip } from "../Chip";
import { IconButton } from "../IconButton";
import { InlineButton } from "../InlineButton";
import { Spinner } from "../Status";
import { Section, Variants } from "./parts";

const VARIANTS = ["primary", "secondary", "quiet", "danger", "float", "link"] as const;

export function ButtonsSection() {
  const [pressed, setPressed] = useState(true);
  return (
    <Section
      id="buttons"
      title="Button, IconButton, Chip, Spinner"
      note="Sizes xs 24 / sm 28 / md 32 / lg 40. Touch (narrow window or coarse pointer) adds an invisible 40px hit area."
    >
      {VARIANTS.map((v) => (
        <Variants key={v} label={`Button ${v}`}>
          {CONTROL_SIZES.map((s) => (
            <Button key={s} variant={v} size={s} {...(v === "link" ? {} : { icon: Plus })}>
              {v === "link" ? `link ${s}` : `${s} ${CONTROL_PX[s]}`}
            </Button>
          ))}
          <Button variant={v} disabled>
            disabled
          </Button>
          <Button variant={v} loading>
            loading
          </Button>
        </Variants>
      ))}
      <Variants label="Button: icon end, pressed, mono link, quiet link, full width">
        <Button variant="quiet" iconEnd={ChevronDown}>
          Menu
        </Button>
        <Button variant="quiet" pressed={pressed} onClick={() => setPressed(!pressed)}>
          Toggle
        </Button>
        <Button variant="link" mono>
          src/lib/path.ts
        </Button>
        <Button variant="link" tone="quiet">
          quiet link
        </Button>
        <Button variant="secondary" icon={Download} fullWidth className="max-w-xs">
          Full width
        </Button>
      </Variants>
      {(["quiet", "primary", "round"] as const).map((v) => (
        <Variants key={v} label={`IconButton ${v}`}>
          {CONTROL_SIZES.map((s) => (
            <IconButton key={s} variant={v} size={s} icon={v === "primary" ? ArrowUp : v === "round" ? ArrowUp : Settings} label={`${v} ${s}`} />
          ))}
          <IconButton variant={v} icon={X} label="disabled" disabled />
        </Variants>
      ))}
      <Variants label="IconButton: primary + round (send), pressed, shortcut tooltip, danger glyph">
        <IconButton variant="primary" round icon={ArrowUp} label="Send" />
        <IconButton icon={Settings} label="Settings" pressed />
        <IconButton icon={Trash2} label="Delete" shortcut="⌫" className="text-err" />
      </Variants>
      <Variants label="Chip (value that opens a list), open, warn, bare">
        <Chip icon={Settings} name="Model" label="Sonnet 5.5" />
        <Chip icon={Settings} name="Model" label="Sonnet 5.5" open />
        <Chip icon={Settings} name="Folder" label="product-configuration-manager" warn />
        <Chip icon={Settings} name="Model" label="Sonnet 5.5" bare />
      </Variants>
      <Variants label="InlineButton: a button that wraps with its sentence (file chips in prose); Enter or Space presses it">
        <span className="max-w-60 text-sm text-fg-2">
          Requests time out after 10 s (
          <InlineButton onPress={() => undefined} className="text-link">
            src/http/client.ts
          </InlineButton>
          ).
        </span>
      </Variants>
      <Variants label="Spinner: one ring per control size (running, so it turns)">
        {CONTROL_SIZES.map((s) => (
          <span key={s} className="flex items-center gap-1 text-xs text-fg-3">
            <Spinner size={s} /> {s}
          </span>
        ))}
      </Variants>
    </Section>
  );
}

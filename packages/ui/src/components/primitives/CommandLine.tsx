import { Check, Copy } from "lucide-react";
import { useCopy } from "../../lib/hooks";
import { IconButton } from "./Button";

/** A command to run in a terminal, in mono, with a copy button (decision 53: "the exact command"). */
export function CommandLine({ command, label }: { command: string; label?: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2 rounded-md border border-line bg-code-bg py-0.5 pr-0.5 pl-3">
      <code className="min-w-0 flex-1 font-mono text-xs break-all text-fg">{command}</code>
      <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : `Copy ${label ?? "command"}`} onClick={() => copy(command)} />
    </div>
  );
}

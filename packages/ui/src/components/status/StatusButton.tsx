import { cn } from "../../lib/cn";
import { Button, type ButtonProps } from "../primitives/Button";

/**
 * One status bar item (decisions 73, 91k): a quiet 24px button. Every item shares one default colour; `warning` colours only the
 * item a warning concerns (the budget at 80% or 100%). A glyph that carries its own tone (the connection dot) leaves the text neutral.
 */
export function StatusButton({ warning, className, ...rest }: Omit<ButtonProps, "variant" | "size" | "tone"> & { warning?: "warn" | "err" }) {
  return (
    <Button variant="quiet" size="xs" className={cn("min-w-0", warning === "warn" && "text-warn", warning === "err" && "text-err", className)} {...rest} />
  );
}

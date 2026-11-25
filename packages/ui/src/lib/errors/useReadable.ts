import { useEffect, useState } from "react";
import { JARGON } from "./words";

/**
 * A stored failure text as one readable sentence (`readable` in `plain.ts`). Text without protocol words is already plain and
 * is returned as it is; only a text with some loads the error mapping, once, so the entry bundle does not carry it.
 */
export function useReadable(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  const [mapped, setMapped] = useState<{ raw: string; text: string } | null>(null);
  const needsMapping = text !== "" && JARGON.test(text);
  useEffect(() => {
    if (!needsMapping) return;
    let live = true;
    void import("./plain").then(
      (m) => live && setMapped({ raw: text, text: m.readable(text) }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [needsMapping, text]);
  if (!needsMapping) return text;
  return mapped?.raw === text ? mapped.text : "";
}

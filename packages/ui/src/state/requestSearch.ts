import type { RequestHit } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { SEARCH_DELAY_MS, SEARCH_LIMIT, searchQuery } from "../lib/requestSearch";
import { useApp } from "./app";

/**
 * Parity B7: past requests of all projects matching what is typed in the palette (`searchRequests`, after a pause in typing).
 * Empty without the bridge method or for a short query; a failed search shows nothing (the palette's other groups still work).
 */
export function useRequestSearch(text: string): RequestHit[] {
  const { bridge } = useApp();
  const query = searchQuery(text);
  const [found, setFound] = useState<{ query: string; hits: RequestHit[] } | null>(null);
  useEffect(() => {
    if (!query || !bridge.searchRequests) return;
    let alive = true;
    const timer = setTimeout(() => {
      bridge.searchRequests?.(query, SEARCH_LIMIT).then(
        (hits) => alive && setFound({ query, hits }),
        () => alive && setFound({ query, hits: [] }),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [bridge, query]);
  return query && found?.query === query ? found.hits : [];
}

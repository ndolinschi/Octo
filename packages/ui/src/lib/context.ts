import { createContext, useContext, type Context } from "react";

/**
 * A context whose consumers need its provider: `useRequired()` throws `"<hook> outside its provider"` instead of handing
 * out `null`, and `useOptional()` returns `null` for components that may render without it (a transcript embedded
 * elsewhere). `Provider` is the context's own provider (pass the value; null is only for the default).
 */
export function createRequiredContext<T>(hookName: string) {
  const Ctx: Context<T | null> = createContext<T | null>(null);
  const useOptional = (): T | null => useContext(Ctx);
  const useRequired = (): T => {
    const value = useContext(Ctx);
    if (value === null) throw new Error(`${hookName} outside its provider`);
    return value;
  };
  return { Provider: Ctx.Provider, useRequired, useOptional } as const;
}

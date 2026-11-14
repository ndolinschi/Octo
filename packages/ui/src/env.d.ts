// Vite worker imports (the desktop host gets the same declaration from `vite/client`).
declare module "*?worker" {
  const WorkerConstructor: new (options?: { name?: string }) => Worker;
  export default WorkerConstructor;
}

// Stylesheets imported by a component (primitives/Prose.css, memory/memory.css); Vite handles them in every host.
declare module "*.css";

// `import.meta.glob` as the asset map of primitives/providerMarkAssets.ts uses it (the desktop host also gets it from `vite/client`; the two declarations merge).
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; query: string; import: "default" }): Record<string, T>;
}

// Vite worker imports (the desktop host gets the same declaration from `vite/client`).
declare module "*?worker" {
  const WorkerConstructor: new (options?: { name?: string }) => Worker;
  export default WorkerConstructor;
}

// Stylesheets imported by a component (primitives/Prose.css, memory/memory.css); Vite handles them in every host.
declare module "*.css";

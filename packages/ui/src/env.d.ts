// Vite worker imports (the desktop host gets the same declaration from `vite/client`).
declare module "*?worker" {
  const WorkerConstructor: new (options?: { name?: string }) => Worker;
  export default WorkerConstructor;
}

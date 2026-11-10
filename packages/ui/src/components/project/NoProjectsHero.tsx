import { Button } from "../primitives/Button";

export function NoProjectsHero({ onCreate }: { onCreate(): void }) {
  return (
    <section aria-labelledby="hero-title" className="grid h-full place-items-center overflow-y-auto px-6">
      <div className="w-full max-w-[440px]">
        <h1 id="hero-title" className="text-[15px] leading-5 font-semibold">
          No projects yet
        </h1>
        <p className="mt-1 text-sm text-fg-2">
          A project has its own orchestrator, folders and notes.
        </p>
        <Button variant="primary" size="sm" onClick={onCreate} className="mt-4">
          Create project
        </Button>
      </div>
    </section>
  );
}

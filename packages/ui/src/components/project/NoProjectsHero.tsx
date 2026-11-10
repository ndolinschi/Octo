import { Plus } from "lucide-react";
import { Button } from "../primitives/Button";
import { OctoMark } from "../shell/OctoMark";

const STEPS = [
  { n: "1", title: "Attach folders", body: "Point a project at one or more repos or directories. Agents stay inside them." },
  { n: "2", title: "Talk to the orchestrator", body: "One continuous chat per project. Say what you want; it plans and delegates." },
  { n: "3", title: "Watch the agents", body: "Sub-agents run in parallel on fast, balanced or deep models. Open any of them to observe." },
];

export function NoProjectsHero({ onCreate }: { onCreate(): void }) {
  return (
    <section aria-labelledby="hero-title" className="grid h-full place-items-center overflow-y-auto px-8 py-10">
      <div className="w-full max-w-[560px]">
        <OctoMark size={36} />
        <h1 id="hero-title" className="mt-6 text-[26px] leading-[34px] font-semibold tracking-[-0.022em]">
          One conversation. A whole team of agents.
        </h1>
        <p className="mt-3 text-[15px] leading-6 text-fg-2">
          Octo gives each project an orchestrator that remembers the brief, splits work into focused tasks and hands them to
          sub-agents. You steer from a single chat.
        </p>
        <ol className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line">
          {STEPS.map((s) => (
            <li key={s.n} className="flex gap-3.5 bg-bg px-4 py-3.5">
              <span className="grid size-5 shrink-0 place-items-center rounded-full border border-line-strong text-2xs font-medium text-fg-2 tabular-nums">
                {s.n}
              </span>
              <div>
                <p className="text-sm font-medium text-fg">{s.title}</p>
                <p className="mt-0.5 text-sm text-fg-3">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <Button variant="primary" icon={Plus} onClick={onCreate} className="mt-8">
          Create your first project
        </Button>
      </div>
    </section>
  );
}

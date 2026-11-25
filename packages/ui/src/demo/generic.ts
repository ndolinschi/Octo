import { elementSummary, splitDesignNotes } from "../lib/browser/designNotes";
import { requestTitle } from "../lib/comments";
import { act, delegate, say, turn, type Ctx } from "./runtime";

function brief(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 56 ? `${line.slice(0, 55).trimEnd()}…` : line;
}

export async function genericTurn(ctx: Ctx, prompt: string): Promise<void> {
  const folder = ctx.rec.project.folders[0];
  const { notes: designNotes } = splitDesignNotes(prompt);
  await turn(ctx, prompt, async (c, orch) => {
    const first = designNotes[0];
    if (first) {
      const target =
        first.elements.length > 0
          ? first.elements.map(elementSummary).join(", ")
          : first.area
            ? `selected ${Math.round(first.area.width)}×${Math.round(first.area.height)} area`
            : "the selected element";
      const sourcePath = first.elements.find((el) => el.component?.file)?.component?.file ?? "src/components/HeroBanner.tsx";
      const cssSummary = first.cssEdits.length > 0 ? first.cssEdits.map((e) => `\`${e.property}: ${e.after}\``).join(", ") : null;
      await delegate(
        c,
        orch,
        [
          {
            role: "Researcher",
            title: brief(`Inspect ${target}`),
            tier: "fast",
            task: `Locate ${target} in ${sourcePath} and prepare the requested visual changes.`,
            run: async (cc, id) => {
              await act(cc, id, [{ name: "read_file", input: { path: sourcePath }, result: "// Component styles and markup\n…", ms: 900 }]);
              const report = cssSummary
                ? `Found \`${target}\` in \`${sourcePath}\`. Ready to apply ${cssSummary} across ${designNotes.length} design ${designNotes.length === 1 ? "note" : "notes"}.`
                : `Found \`${target}\` in \`${sourcePath}\` and matched all ${designNotes.length} design ${designNotes.length === 1 ? "note" : "notes"}.`;
              await say(cc, id, report);
              return report;
            },
          },
        ],
        "I'll locate the selected component and styles first.",
      );
      await say(
        c,
        orch,
        cssSummary
          ? `Located \`${target}\` in \`${sourcePath}\` with your live style preview (${cssSummary}). In **demo mode** files aren't rewritten automatically, so you can keep testing Design Mode or inspect the Researcher's report above.`
          : `Located \`${target}\` in \`${sourcePath}\` from your Browser Design Mode selection (${designNotes.length} ${designNotes.length === 1 ? "note" : "notes"}). Open the Researcher card above to see the full lookup.`,
      );
      return;
    }
    await delegate(
      c,
      orch,
      [
        {
          role: "Researcher",
          title: brief(requestTitle(prompt)),
          tier: "fast",
          task: `The user asked: "${prompt}". Investigate the project and report concrete findings with file references.`,
          run: async (cc, id) => {
            if (folder) {
              await act(cc, id, [{ name: "list_dir", input: { path: "." }, result: "src/\ntest/\npackage.json\nREADME.md", ms: 1200 }]);
              await act(cc, id, [{ name: "read_file", input: { path: "README.md" }, result: "# Project\n…", ms: 1400 }]);
            }
            const r = folder
              ? `Looked through \`${folder.label}\`: the entry point is \`src/index.ts\`, tests live in \`test/\`, and the README documents setup. Nothing blocks the request.`
              : "This project has no folders attached, so I worked from the brief alone. Attach a folder in Project settings to let agents read code.";
            await say(cc, id, r);
            return r;
          },
        },
      ],
      "I'll have a researcher look into this first.",
    );
    await say(
      c,
      orch,
      "This is **demo mode**, so the agents are scripted — but this is the shape of a real turn: I delegated the investigation, read only the researcher's report, and kept my own context small. Open the Researcher from the card above or the Agents panel to see its full transcript.",
    );
  });
}

import { act, delegate, say, turn, type Ctx } from "./runtime";

function brief(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 56 ? `${line.slice(0, 55).trimEnd()}…` : line;
}

export async function genericTurn(ctx: Ctx, prompt: string): Promise<void> {
  const folder = ctx.rec.project.folders[0];
  await turn(ctx, prompt, async (c, orch) => {
    await delegate(
      c,
      orch,
      [
        {
          role: "Researcher",
          title: brief(prompt),
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

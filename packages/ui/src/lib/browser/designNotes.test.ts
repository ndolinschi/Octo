import assert from "node:assert/strict";
import test from "node:test";
import {
  browserHostLabel,
  designNotesSummary,
  elementSummary,
  formatDesignNotes,
  normalizeBrowserUrl,
  splitDesignNotes,
  withDesignNotes,
  type DesignNote,
  type PickedElement,
} from "./designNotes";

const sampleElement: PickedElement = {
  selector: "#hero > button.cta",
  tag: "button",
  id: "",
  classes: ["cta", "primary"],
  attributes: { "aria-label": "Start trial", type: "button" },
  text: "Start free trial",
  rect: { x: 120, y: 240, width: 164, height: 40 },
  styles: {
    color: "rgb(255, 255, 255)",
    backgroundColor: "rgb(37, 99, 235)",
    fontSize: "14px",
    fontFamily: "Inter, sans-serif",
    display: "inline-flex",
    position: "relative",
  },
  component: {
    name: "HeroBanner",
    stack: ["HeroBanner", "LandingPage"],
    file: "src/components/HeroBanner.tsx",
    line: 42,
  },
};

test("normalizeBrowserUrl handles local ports, bare domains, and rejects unsafe schemes", () => {
  assert.equal(normalizeBrowserUrl("localhost:5173"), "http://localhost:5173/");
  assert.equal(normalizeBrowserUrl("127.0.0.1:3000/app?tab=1"), "http://127.0.0.1:3000/app?tab=1");
  assert.equal(normalizeBrowserUrl("0.0.0.0:8080/health"), "http://localhost:8080/health");
  assert.equal(normalizeBrowserUrl(":4321/preview"), "http://localhost:4321/preview");
  assert.equal(normalizeBrowserUrl("cursor.com/docs/agent/design-mode"), "https://cursor.com/docs/agent/design-mode");
  assert.equal(normalizeBrowserUrl("https://example.com/path"), "https://example.com/path");
  assert.equal(normalizeBrowserUrl(""), null);
  assert.equal(normalizeBrowserUrl("javascript:alert(1)"), null);
  assert.equal(normalizeBrowserUrl("data:text/html,<h1>hi</h1>"), null);
  assert.equal(normalizeBrowserUrl("file:///etc/passwd"), null);
  assert.equal(normalizeBrowserUrl("justaword"), null);
});

test("formatDesignNotes and splitDesignNotes round-trip DOM, CSS, text edits, and backticks", () => {
  const note: DesignNote = {
    id: "dn1",
    url: "http://localhost:5173/pricing",
    elements: [sampleElement],
    area: { x: 100, y: 220, width: 200, height: 80 },
    cssEdits: [{ selector: "#hero > button.cta", property: "border-radius", before: "6px", after: "999px" }],
    textEdit: { selector: "#hero > button.cta", before: "Start free trial", after: "Get started" },
    text: "Make pill-shaped with ```inline ticks``` and update label",
    pngBytes: new Uint8Array([137, 80, 78, 71]),
    created: 1_700_000_000_000,
  };

  const block = formatDesignNotes([note]);
  assert.ok(block.startsWith("````octo-design\n"), "uses longer fence when note contains triple backticks");
  const full = withDesignNotes("Please apply this polish:", block);

  const parsed = splitDesignNotes(full);
  assert.equal(parsed.prose, "Please apply this polish:");
  assert.equal(parsed.notes.length, 1);
  const first = parsed.notes[0];
  assert.ok(first);
  assert.equal(first.url, "http://localhost:5173/pricing");
  assert.equal(first.elements[0]?.component?.name, "HeroBanner");
  assert.equal(first.elements[0]?.component?.file, "src/components/HeroBanner.tsx");
  assert.deepEqual(first.cssEdits, [{ selector: "#hero > button.cta", property: "border-radius", before: "6px", after: "999px" }]);
  assert.deepEqual(first.textEdit, { selector: "#hero > button.cta", before: "Start free trial", after: "Get started" });
  assert.equal(first.hasScreenshot, true);
  assert.equal(elementSummary(sampleElement), "<HeroBanner> button.cta");
  assert.equal(browserHostLabel(first.url), "localhost:5173");
  assert.equal(designNotesSummary(parsed.notes), "1\u00a0design note on localhost:5173");
});

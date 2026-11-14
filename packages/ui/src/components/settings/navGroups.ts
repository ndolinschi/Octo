import { SECTIONS, type SectionId } from "./settingsIndex";

/** G14: the settings sections in three quiet groups (the nav's order, and its keyboard order). Every section once. */
export const NAV_GROUPS: readonly { title: string; ids: readonly SectionId[] }[] = [
  { title: "App", ids: ["general", "appearance", "privacy", "remote", "about"] },
  { title: "Models and agents", ids: ["providers", "models", "integrations"] },
  { title: "Workspace", ids: ["editor", "commands", "memory", "usage"] },
];

/** The groups with their sections' labels; a section missing from `NAV_GROUPS` goes in the last group, so none is lost. */
export function navGroups(): { title: string; sections: { id: SectionId; label: string }[] }[] {
  const placed = new Set(NAV_GROUPS.flatMap((g) => g.ids));
  const label = (id: SectionId) => SECTIONS.find((s) => s.id === id)?.label ?? id;
  const groups = NAV_GROUPS.map((g) => ({ title: g.title, sections: g.ids.map((id) => ({ id, label: label(id) })) }));
  const rest = SECTIONS.filter((s) => !placed.has(s.id)).map((s) => ({ id: s.id, label: s.label }));
  groups[groups.length - 1]?.sections.push(...rest);
  return groups;
}

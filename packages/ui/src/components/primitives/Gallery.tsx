import { useState } from "react";
import { Button } from "./Button";
import { ButtonsSection } from "./gallery/ButtonsSection";
import { FieldsSection } from "./gallery/FieldsSection";
import { PanelSection } from "./gallery/PanelSection";
import { RowsSection, SurfacesSection } from "./gallery/SurfacesSection";
import { ScrollArea } from "./ScrollArea";

type Theme = "dark" | "light";

/**
 * The component library gallery (decision 90): every primitive in every variant, size and state, in the current theme
 * (the button switches `data-theme` on the root, as the app does). Demo only: `?demo=1&gallery=1`; a lazy chunk that
 * `app/OctoApp` loads with `import()`. `scripts/gallery-shots.mjs` screenshots each `[data-gallery-section]`.
 *
 * `ViewTabs`, `FilterTabs` and `FieldRow` exist (decisions 82, 84) but are not in the gallery yet.
 */
export function Gallery() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "light" ? "light" : "dark"));
  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };
  return (
    <ScrollArea className="fixed inset-0 bg-window text-fg" role="main" aria-label="Component gallery">
      <div className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-6 sm:px-6">
        <header className="flex items-center justify-between gap-3">
          <h1 className="text-title">Component library</h1>
          <Button variant="secondary" size="sm" onClick={flip}>
            Theme: {theme}
          </Button>
        </header>
        <ButtonsSection />
        <FieldsSection />
        <RowsSection />
        <SurfacesSection />
        <PanelSection />
      </div>
    </ScrollArea>
  );
}

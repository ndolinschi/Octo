#!/usr/bin/env python3
"""Contact sheets for a UI tour (see ui-tour.mjs): one image per group and theme with that group's 1440x900 shots at 1/3
scale in a grid, the state name under each tile, so a group can be scanned in one look.

    python3 packages/ui/scripts/tour-sheets.py /tmp/tour            # writes /tmp/tour/sheet-<group>-<theme>-1440.png
"""

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

COLUMNS = 4
TILE_W, TILE_H = 480, 300
LABEL_H = 28
GAP = 10
FILE = re.compile(r"^(\d\d)-(.+)-(dark|light)-1440x900\.png$")


def main(root: Path) -> int:
    font = ImageFont.load_default(size=15)
    made = 0
    for group in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")):
        for theme in ("dark", "light"):
            shots = []
            for f in sorted(group.glob("*.png")):
                m = FILE.match(f.name)
                if m and m.group(3) == theme:
                    shots.append((f"{m.group(1)} {m.group(2)}", f))
            if not shots:
                continue
            rows = (len(shots) + COLUMNS - 1) // COLUMNS
            w = COLUMNS * TILE_W + (COLUMNS + 1) * GAP
            h = rows * (TILE_H + LABEL_H) + (rows + 1) * GAP
            bg = (16, 16, 18) if theme == "dark" else (236, 236, 238)
            fg = (210, 210, 214) if theme == "dark" else (40, 40, 44)
            sheet = Image.new("RGB", (w, h), bg)
            draw = ImageDraw.Draw(sheet)
            for i, (label, f) in enumerate(shots):
                x = GAP + (i % COLUMNS) * (TILE_W + GAP)
                y = GAP + (i // COLUMNS) * (TILE_H + LABEL_H + GAP)
                with Image.open(f) as im:
                    tile = im.convert("RGB").resize((TILE_W, TILE_H), Image.LANCZOS)
                sheet.paste(tile, (x, y))
                draw.text((x, y + TILE_H + 5), label[:62], fill=fg, font=font)
            out = root / f"sheet-{group.name}-{theme}-1440.png"
            sheet.save(out)
            made += 1
            print(f"{out.name}: {len(shots)} tiles")
    print(f"tour-sheets: {made} sheets")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1])))

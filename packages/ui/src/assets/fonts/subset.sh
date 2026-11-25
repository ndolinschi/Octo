#!/usr/bin/env bash
# Rebuilds the bundled Inter subsets from the official release (OFL-1.1; LICENSE.txt is the release's licence file).
#   bash subset.sh /path/to/Inter-4.1   # the unzipped https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
# Needs fonttools and brotli (pip install fonttools brotli). The optical size is pinned to Inter's text cut (opsz 14), the
# weight axis stays variable; features: the defaults the UI relies on plus tnum, case, cv11 (single-storey a) and ss01
# (open digits). The unicode ranges are the ones in the @font-face rules of ../../styles.css ("audit C: typeface").
set -euo pipefail
src="${1:?path to the unzipped Inter release}"
out="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
FEATURES='calt,ccmp,locl,kern,mark,mkmk,case,tnum,cv11,ss01'
LATIN='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+21A9,U+21B5,U+21E7,U+2212,U+2215,U+2303,U+2318,U+2325,U+232B,U+238B,U+2713,U+FEFF,U+FFFD'
LATIN_EXT='U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'
CYRILLIC='U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'
CYRILLIC_EXT='U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F'
for style in "" "-Italic"; do
  python3 -m fontTools.varLib.instancer "$src/InterVariable$style.ttf" opsz=14 -q -o "$tmp/inter$style.ttf"
  name="inter"
  if [ -n "$style" ]; then name="inter-italic"; fi
  for subset in latin latin-ext cyrillic cyrillic-ext; do
    var="$(echo "$subset" | tr 'a-z-' 'A-Z_')"
    python3 -m fontTools.subset "$tmp/inter$style.ttf" --unicodes="${!var}" --layout-features="$FEATURES" \
      --flavor=woff2 --output-file="$out/$name-$subset.woff2"
  done
done
ls -l "$out"/*.woff2

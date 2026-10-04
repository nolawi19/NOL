#!/usr/bin/env python3
"""Regenerates src/design/themes.generated.ts from tinted-theming/schemes.

    git clone --depth 1 https://github.com/tinted-theming/schemes /tmp/schemes
    python3 scripts/gen-themes.py /tmp/schemes

Only dark base16 palettes are kept: the island sits on the top edge of the
screen and is designed to melt into it.
"""
import glob, json, os, re, sys

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/schemes"
rows = []
for f in sorted(glob.glob(os.path.join(src, "base16", "*.yaml"))):
    t = open(f, encoding="utf-8").read()
    if 'variant: "dark"' not in t:
        continue
    name = re.search(r'^name:\s*"(.*)"', t, re.M).group(1)
    m = re.search(r'^author:\s*"(.*)"', t, re.M)
    author = m.group(1)[:80] if m else ""
    cols = "".join(
        re.search(r'base0%X:\s*"#?([0-9a-fA-F]{6})"' % i, t).group(1).lower() for i in range(16)
    )
    rows.append("  [%s, %s, %s, \"%s\"]," % (json.dumps(os.path.basename(f)[:-5]), json.dumps(name), json.dumps(author), cols))

out = os.path.join(os.path.dirname(__file__), "..", "src", "design", "themes.generated.ts")
with open(out, "w", encoding="utf-8") as fh:
    fh.write("""// Generated from tinted-theming/schemes (base16, dark variants only).
// https://github.com/tinted-theming/schemes — MIT License, Copyright (c) 2022
// Tinted Theming; each palette by the author named next to it. See
// THIRD_PARTY_NOTICES.md. Regenerate with scripts/gen-themes.py.
//
// Row: [slug, name, author, base00..base0F as 16 × 6 hex digits]

export type ThemeRow = readonly [slug: string, name: string, author: string, colors: string];

export const THEMES: readonly ThemeRow[] = [
%s
];
""" % "\n".join(rows))
print(f"{len(rows)} themes → {out}")

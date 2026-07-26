#!/usr/bin/env python3
"""
tools/check_chevron_clutter.py

Guard the invariant three field reports were spent on: NO route-style chevron
layer may be visible while the lane corridor is up. The corridor paints its own
chevrons, so any second set flowing at a different spacing over the same asphalt
is clutter.

A chevron layer passes if it either
  (a) has a text-opacity gated on laneCorridor, or
  (b) sits inside a block gated on !laneCorridor (i.e. unmounted).

This is structural, not visual — tsc cannot see it and no runtime test exercises
it, which is exactly why it survived three rounds of review.
"""
import re, sys

def check(path):
    src = open(path).read()
    bad, checked = [], 0
    for m in re.finditer(r'id="([\w-]+)"', src):
        lid, start = m.group(1), m.start()
        blk = src[start:start + 4000]
        end = blk.find("/>")
        blk = blk[: end if end > 0 else 4000]
        # Only LINE-PLACED chevrons follow the route path. Point symbols that
        # happen to use the same glyph — drivers-heading marks another car's
        # bearing on its dot — are a different feature and must not be caught.
        if '"text-field": "\u00bb"' not in blk:
            continue
        if '"symbol-placement": "line"' not in blk:
            continue
        checked += 1
        gated_opacity = re.search(r'"text-opacity":\s*[^\n]*laneCorridor', blk)
        # look back for an enclosing !laneCorridor mount gate
        unmounted = "!laneCorridor &&" in src[max(0, start - 2500):start]
        if not (gated_opacity or unmounted):
            bad.append((src[:start].count("\n") + 1, lid))
    return bad, checked

fail = 0
for p in sys.argv[1:]:
    bad, n = check(p)
    if bad:
        fail = 1
        for line, lid in bad:
            print(f'FAIL | {p}:{line}  layer "{lid}" draws chevrons but is not hidden when laneCorridor is active')
    else:
        print(f"PASS | {p}: all {n} chevron layer(s) yield to the corridor")
sys.exit(fail)

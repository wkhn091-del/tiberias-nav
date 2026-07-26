#!/usr/bin/env python3
"""
tools/check_map_expressions.py — run before every release:

    python3 tools/check_map_expressions.py \
        mobile_app/components/MapScreen.tsx mobile_app/lib/mapStyle.ts

Guard against the MapLibre JNI crash class:
  ["zoom"] may ONLY be the input of a TOP-LEVEL "step"/"interpolate".
Nest it any deeper and native rejects the entire property at runtime —
invisible to tsc and to every JS test, which is why it reached the device.

Walks each paint/layout property value with bracket-depth tracking and
reports any ["zoom"] that is not a direct child of a top-level step/interpolate.
"""
import sys, re

def check(path):
    src = open(path).read()
    bad = []
    # find every `"some-prop": [` and capture the balanced array that follows
    for m in re.finditer(r'"([a-z-]+)"\s*:\s*\[', src):
        prop, start = m.group(1), m.end() - 1
        depth, i = 0, start
        while i < len(src):
            if src[i] == "[": depth += 1
            elif src[i] == "]":
                depth -= 1
                if depth == 0: break
            i += 1
        expr = src[start:i+1]
        # line-gradient has the same top-level rule, on ["line-progress"]:
        # MapLibre rejects the property unless the value IS a step/interpolate.
        if prop == "line-gradient":
            head0 = re.match(r'\[\s*"(\w+)"', expr)
            if not (head0 and head0.group(1) in ("interpolate", "step")):
                bad.append((src[:start].count("\n") + 1, prop,
                            "line-gradient must itself be a top-level step/interpolate"))
        if '["zoom"]' not in expr:
            continue
        head = re.match(r'\[\s*"(\w+)"', expr)
        top_ok = head and head.group(1) in ("interpolate", "step")
        # depth of each ["zoom"] relative to this property's top-level array
        for zm in re.finditer(r'\["zoom"\]', expr):
            d = 0
            for ch in expr[:zm.start()]:
                if ch == "[": d += 1
                elif ch == "]": d -= 1
            # d == 1 -> direct child of the top-level array
            if d != 1 or not top_ok:
                line = src[:start].count("\n") + 1
                bad.append((line, prop, "nested inside another expression"
                            if d != 1 else f'top-level is "{head.group(1) if head else "?"}", not step/interpolate'))
    return bad

fail = 0
for p in sys.argv[1:]:
    bad = check(p)
    if bad:
        fail = 1
        for line, prop, why in bad:
            print(f"FAIL | {p}:{line}  {prop}  -> {why}")
    else:
        print(f"PASS | {p}: every [\"zoom\"] feeds a top-level step/interpolate")
sys.exit(fail)

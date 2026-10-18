#!/usr/bin/env python3
"""Validate games.json against the tree. Exit 1 on any error.

  python3 tools/check.py
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REQUIRED = ("slug", "title", "path")
SHELVES = {"featured", "lab"}

errors, warnings = [], []
manifest = json.loads((ROOT / "games.json").read_text(encoding="utf-8"))
seen = set()

for i, g in enumerate(manifest.get("games", [])):
    name = g.get("slug", f"#{i}")
    for k in REQUIRED:
        if not g.get(k):
            errors.append(f"{name}: missing '{k}'")
    if name in seen:
        errors.append(f"{name}: duplicate slug")
    seen.add(name)

    path = g.get("path", "")
    target = ROOT / path
    if path.endswith("/"):
        target = target / "index.html"
    if path and not target.is_file():
        errors.append(f"{name}: entry not found: {target.relative_to(ROOT)}")

    if g.get("shelf", "featured") not in SHELVES:
        errors.append(f"{name}: unknown shelf '{g.get('shelf')}'")

    thumb = g.get("thumb")
    if not thumb:
        warnings.append(f"{name}: no thumb (fallback card will show)")
    elif not (ROOT / thumb).is_file():
        warnings.append(f"{name}: thumb missing: {thumb} (run tools/thumbs.py)")

    readme = g.get("readme")
    if readme and not (ROOT / readme).is_file():
        errors.append(f"{name}: readme not found: {readme}")

for w in warnings:
    print(f"warn  {w}")
for e in errors:
    print(f"ERROR {e}")
print(f"{len(seen)} entries, {len(errors)} errors, {len(warnings)} warnings")
sys.exit(1 if errors else 0)

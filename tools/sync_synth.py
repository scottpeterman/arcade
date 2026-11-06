#!/usr/bin/env python3
"""Copy the shared synth block from lab/corsair/index.html into lab/sound-lab/index.html.

Both pages carry the same block between the "==== SYNTH BEGIN" and "==== SYNTH END ====" marker lines,
so the lab plays exactly what the game plays. Edit the block in the Corsair page, then run:

    python3 tools/sync_synth.py           # copy game -> lab
    python3 tools/sync_synth.py --check   # exit 1 if they differ
"""
import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GAME, LAB = ROOT / 'lab/corsair/index.html', ROOT / 'lab/sound-lab/index.html'
BEGIN, END = '// ==== SYNTH BEGIN', '// ==== SYNTH END ===='


def block(text, name):
    i, j = text.find(BEGIN), text.find(END)
    if i < 0 or j < i:
        sys.exit(f'{name}: synth markers not found')
    return i, j + len(END)


g, l = GAME.read_text(), LAB.read_text()
gi, gj = block(g, GAME.name)
li, lj = block(l, LAB.name)
same = g[gi:gj] == l[li:lj]
if '--check' in sys.argv:
    print('synth blocks match' if same else 'synth blocks DIFFER: run tools/sync_synth.py')
    sys.exit(0 if same else 1)
if same:
    print('already in sync')
else:
    LAB.write_text(l[:li] + g[gi:gj] + l[lj:])
    print(f'copied synth block ({gj - gi} chars) from {GAME.relative_to(ROOT)} to {LAB.relative_to(ROOT)}')

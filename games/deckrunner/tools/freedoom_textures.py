#!/usr/bin/env python3
"""Rebuild the DR_TEX block embedded in index.html from a Freedoom checkout.

  git clone --depth 1 https://github.com/freedoom/freedoom.git
  python3 tools/freedoom_textures.py freedoom dr_tex.js

Flats are taken as-is; walls are composited from patches per
lumps/textures/textures.cfg. Paste the output over the `const DR_TEX = ...`
line in index.html. Needs Pillow.
"""
import sys, os, re
from PIL import Image
def load_defs(root):
    defs = {}; cur = None
    for line in open(os.path.join(root,'lumps/textures/textures.cfg')):
        line = line.split(';')[0].rstrip()
        if not line.strip() or line.startswith('#'): continue
        m = re.match(r'^(\S+)\s+(\d+)\s+(\d+)', line)
        if m and not line.startswith('*'):
            name = m.group(1).upper(); cur = None
            if name not in defs:
                cur = defs[name] = {'w': int(m.group(2)), 'h': int(m.group(3)), 'p': []}
            continue
        m = re.match(r'^\*\s+(\S+)\s+(-?\d+)\s+(-?\d+)', line)
        if m and cur is not None: cur['p'].append((m.group(1).lower(), int(m.group(2)), int(m.group(3))))
    return defs
def compose(root, DEFS, name):
    d = DEFS[name]; im = Image.new('RGBA', (d['w'], d['h']), (0,0,0,0))
    for p, x, y in d['p']:
        f = os.path.join(root, 'patches', p + '.png')
        if not os.path.exists(f): print('missing', p, file=sys.stderr); continue
        pi = Image.open(f).convert('RGBA'); im.alpha_composite(pi, (x, y)) if x>=0 and y>=0 else im.paste(pi,(x,y),pi)
    return im

import io, base64, json
FLATS = ['flat3','floor0_5','floor0_6','floor0_7','comp01','fcgrate2','step1','step2','floor4_8','floor5_1','flat20','flat23','tlite6_5']
WALLS = ['STARGR1','STARTAN3','GRAY4','SUPPORT2','SUPPORT3','TEKWALL2','TEKWALL5','BIGDOOR2','SILVER2','COMPUTE1','SHAWN2','SPACEW3']
def uri(im):
    bg = Image.new('RGBA', im.size, (0,0,0,255)); bg.alpha_composite(im.convert('RGBA'))
    b = io.BytesIO(); bg.convert('RGB').save(b, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()
if __name__ == '__main__':
    root, out = sys.argv[1], sys.argv[2]
    DEFS = load_defs(root)
    d = {f: uri(Image.open(os.path.join(root, 'flats', f + '.png'))) for f in FLATS}
    for w in WALLS: d[w] = uri(compose(root, DEFS, w))
    open(out, 'w').write('const DR_TEX = ' + json.dumps(d) + ';\n')
    print(out, len(d), 'textures')

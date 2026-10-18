"""banrion/bundle.py — inline js/*.js into chess.html so the page is one file.

file: URLs are unique security origins, so a page opened off disk cannot load
its own sibling scripts. Keep editing js/*.js; re-run this to produce the
single-file build.
"""
import re, pathlib, datetime

src = pathlib.Path('chess.html').read_text(encoding='utf-8')
order = ['js/mqtt.min.js', 'js/chess.js', 'js/transport.js', 'js/game.js', 'js/net.js',
         'js/board2d.js', 'js/engine.js', 'js/pieces.js', 'js/glrender.js', 'js/render3d.js']

# The engine is not a script the page runs -- it is source the page hands to a
# Worker. It goes in as inert text and engine.js turns it into a blob URL,
# because a file: page cannot construct a Worker from a sibling file.
ENGINE = 'js/lozza.js'

# The splash art has to travel INSIDE the single file. A sibling <img src> is
# fine off a plain file:// page, but the phone opens the download through a
# content:// URI where no sibling exists -- so it goes in as a data URI.
SPLASH = 'banrion.webp'

def inline(m):
    path = m.group(1)
    if not path.startswith('js/'):
        return m.group(0)                      # leave the CDN tag alone
    body = pathlib.Path(path).read_text(encoding='utf-8')
    # a literal </script> inside a string would close the tag early
    body = body.replace('</script>', '<\\/script>')
    return f'<script>\n/* ==== inlined from {path} ==== */\n{body}\n</script>'

out = re.sub(r'<script src="([^"]+)"></script>', inline, src)

engine = pathlib.Path(ENGINE).read_text(encoding='utf-8')
engine = engine.replace('</script>', '<\\/script>')
out = out.replace('<!--ENGINE-SRC-->',
                  f'<script id="lozza-src" type="text/plain">\n{engine}\n</script>')
assert 'id="lozza-src"' in out, 'engine placeholder missing from chess.html'

import base64
splash = base64.b64encode(pathlib.Path(SPLASH).read_bytes()).decode('ascii')
out = out.replace(
    '<!--SPLASH-IMG--><img id="splash-img" src="banrion.webp" alt="BANRION">',
    f'<img id="splash-img" src="data:image/webp;base64,{splash}" alt="BANRION">')
assert 'data:image/webp;base64' in out, 'splash placeholder missing from chess.html'

stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
assert '__BUILD__' in out, 'build stamp placeholder missing from chess.html'
out = out.replace('__BUILD__', stamp)
missing = [p for p in order if p not in src]
assert not missing, missing
pathlib.Path('chess_single.html').write_text(out, encoding='utf-8')
print('wrote chess_single.html', len(out), 'bytes')

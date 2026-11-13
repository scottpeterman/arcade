#!/usr/bin/env python3
"""Build a self-contained dist/index.html for a page that imports lib/ packages.

    python3 tools/dist.py lab/corsair            -> lab/corsair/dist/index.html
    python3 tools/dist.py lab/corsair --out X.html

Any import-map entry that points into the repo (e.g. "longwind-world/":
"../../lib/longwind-world/src/") is removed, and every import from it is replaced
by the package's modules inlined into the page's module script. Each module is
wrapped in its own function scope, so module-level names can't collide. CDN
entries (three, three/addons/) are left alone.

Supported module syntax (what lib/ uses): `export function|const|let|class name`,
`import { a, b } from './x.js'`, and `export { a, b } from './x.js'` re-exports.
Anything else (default exports, export *, import.meta, dynamic import) fails the
build instead of producing a broken page.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

RE_IMPORTMAP = re.compile(r'(<script type="importmap">\s*)(.*?)(\s*</script>)', re.S)
RE_IMPORT = re.compile(r'^\s*import\s*\{([^}]*)\}\s*from\s*[\'"]([^\'"]+)[\'"]\s*;?\s*$', re.M)
RE_REEXPORT = re.compile(r'^\s*export\s*\{([^}]*)\}\s*from\s*[\'"]([^\'"]+)[\'"]\s*;?\s*$', re.M)
RE_EXPORT_DECL = re.compile(r'^(\s*)export\s+(async\s+function\*?|function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)', re.M)
RE_UNSUPPORTED = re.compile(r'^\s*export\s+(default|\*)|import\.meta|\bimport\s*\(|^\s*import\s+[^{\s]', re.M)


def names(spec):
    """'a, b as c' -> [('a','b'...)] as (imported, local) pairs."""
    out = []
    for part in spec.split(','):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r'([\w$]+)(?:\s+as\s+([\w$]+))?', part)
        if not m:
            sys.exit(f'dist: cannot parse import spec "{part}"')
        out.append((m.group(1), m.group(2) or m.group(1)))
    return out


def destructure(pairs, src):
    inner = ', '.join(a if a == b else f'{a}: {b}' for a, b in pairs)
    return f'const {{ {inner} }} = {src};'


class Bundler:
    def __init__(self):
        self.mods = {}      # resolved path -> var name
        self.order = []     # emitted chunks, dependency first

    def var(self, path):
        rel = path.relative_to(ROOT).with_suffix('')
        return '__m_' + re.sub(r'\W', '_', str(rel))

    def load(self, path, stack=()):
        path = path.resolve()
        if path in self.mods:
            return self.mods[path]
        if path in stack:
            sys.exit(f'dist: import cycle at {path}')
        if not path.is_file():
            sys.exit(f'dist: missing module {path}')
        src = path.read_text(encoding='utf-8')
        bad = RE_UNSUPPORTED.search(src)
        if bad:
            sys.exit(f'dist: unsupported syntax in {path.relative_to(ROOT)}: {bad.group(0).strip()}')

        exports = []
        head = []

        def dep(spec):
            if not spec.startswith('.'):
                sys.exit(f'dist: bare import "{spec}" inside {path.relative_to(ROOT)}')
            return self.load(path.parent / spec, stack + (path,))

        def on_import(m):
            head.append(destructure(names(m.group(1)), dep(m.group(2))))
            return ''

        def on_reexport(m):
            pairs = names(m.group(1))
            local = [(a, f'__re_{b}') for a, b in pairs]
            head.append(destructure(local, dep(m.group(2))))
            exports.extend((b, f'__re_{b}') for _, b in pairs)
            return ''

        def on_decl(m):
            exports.append((m.group(3), m.group(3)))
            return f'{m.group(1)}{m.group(2)} {m.group(3)}'

        body = RE_IMPORT.sub(on_import, src)
        body = RE_REEXPORT.sub(on_reexport, body)
        body = RE_EXPORT_DECL.sub(on_decl, body)
        if re.search(r'^\s*export\b', body, re.M):
            sys.exit(f'dist: unhandled export in {path.relative_to(ROOT)}')

        v = self.var(path)
        ret = ', '.join(e if e == l else f'{e}: {l}' for e, l in exports)
        self.order.append(
            f'// ---- {path.relative_to(ROOT)}\n'
            f'const {v} = (() => {{\n' + '\n'.join(head) + '\n' + body.rstrip() +
            f'\nreturn {{ {ret} }};\n}})();\n')
        self.mods[path] = v
        return v


def build(page_dir, out):
    page = page_dir / 'index.html'
    html = page.read_text(encoding='utf-8')

    m = RE_IMPORTMAP.search(html)
    if not m:
        sys.exit(f'dist: no import map in {page}')
    imap = json.loads(m.group(2))
    local = {k: v for k, v in imap['imports'].items() if not re.match(r'https?://', v)}
    if not local:
        sys.exit('dist: nothing to inline (no repo-relative import-map entries)')
    for k in local:
        del imap['imports'][k]
    html = html[:m.start(2)] + json.dumps(imap, indent=1).replace('\n ', '\n  ') + html[m.end(2):]

    b = Bundler()
    glue = []

    def on_page_import(mm):
        spec = mm.group(2)
        for prefix, target in local.items():
            if spec.startswith(prefix) if prefix.endswith('/') else spec == prefix:
                rest = spec[len(prefix):] if prefix.endswith('/') else ''
                v = b.load(page_dir / (target + rest))
                glue.append(destructure(names(mm.group(1)), v))
                return ''
        return mm.group(0)

    s = html.index('<script type="module">')
    e = html.index('</script>', s)
    script = RE_IMPORT.sub(on_page_import, html[s:e])
    if not glue:
        sys.exit('dist: page imports nothing from the local packages')
    # keep the remaining (CDN) imports first, then the inlined modules
    last = list(re.finditer(r'^\s*import\b.*$', script, re.M))
    cut = last[-1].end() if last else len('<script type="module">')
    bundle = '\n// ==== inlined by tools/dist.py ====\n' + ''.join(b.order) + '\n'.join(glue) + '\n// ==== end inlined ====\n'
    script = script[:cut] + bundle + script[cut:]
    html = html[:s] + script + html[e:]

    if re.search(r'["\']\.\./', html):
        print('dist: warning: page still contains ../ references', file=sys.stderr)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding='utf-8')
    print(f'{out.relative_to(ROOT)}  {out.stat().st_size // 1024} KB  ({len(b.order)} modules inlined)')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('page', help='page folder, e.g. lab/corsair')
    ap.add_argument('--out', help='output file (default PAGE/dist/index.html)')
    a = ap.parse_args()
    d = (ROOT / a.page).resolve()
    build(d, Path(a.out).resolve() if a.out else d / 'dist' / 'index.html')
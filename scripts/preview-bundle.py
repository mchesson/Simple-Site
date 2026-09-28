#!/usr/bin/env python3
"""Pack the built site (dist/) into ONE self-contained HTML file for previewing
without a server: all pages, CSS, fonts (latin subsets) and logos are inlined,
and internal links become hash routes (#/life-sciences).

Usage: npm run build && python3 scripts/preview-bundle.py [out.html]
"""
import base64, json, pathlib, re, sys
from html import unescape

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'preview.html')


def data_uri(path: pathlib.Path) -> str:
    mime = {'.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'}[path.suffix]
    return f'data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode()


def page_files():
    for f in sorted(DIST.rglob('index.html')):
        rel = f.parent.relative_to(DIST).as_posix()
        yield ('/' if rel == '.' else '/' + rel), f
    yield '/404', DIST / '404.html'


def rewrite_links(html: str) -> str:
    def fix(m):
        attr, url = m.group(1), m.group(2)
        if url.startswith(('/_astro/', '//')):
            return m.group(0)
        if re.match(r'/[\w\-./]*\.(svg|png)$', url):
            f = DIST / url.lstrip('/')
            return f'{attr}="{data_uri(f)}"' if f.exists() else m.group(0)
        if url.endswith('.xml'):
            return f'{attr}="#" data-preview-disabled'
        return f'{attr}="#{url}"'
    return re.sub(r'\b(href|src)="(/[^"]*)"', fix, html)


# --- CSS: every stylesheet the pages use, fonts inlined (latin + latin-ext only)
css_files, inline_styles = [], []
pages = {}
for route, f in page_files():
    html = f.read_text()
    head = html.split('</head>')[0]
    css_files += [c for c in re.findall(r'href="(/_astro/[^"]+\.css)"', head) if c not in css_files]
    inline_styles += [s for s in re.findall(r'<style[^>]*>(.*?)</style>', head, re.S) if s not in inline_styles]
    m = re.search(r'<main id="main">(.*)</main>', html, re.S)
    if not m:  # redirect stubs for old WordPress URLs
        continue
    main = m.group(1)
    title = unescape(re.search(r'<title>(.*?)</title>', html).group(1))
    industry = re.search(r'<body[^>]*data-industry="([^"]+)"', html)
    pages[route] = {'title': title, 'industry': industry.group(1) if industry else '', 'html': rewrite_links(main)}

css = '\n'.join((DIST / c.lstrip('/')).read_text() for c in css_files) + '\n'.join(inline_styles)


def font_face(m):
    block = m.group(0)
    url = re.search(r'url\((/_astro/[^)]+\.woff2)\)', block)
    if not url or not re.search(r'-latin(-ext)?-', url.group(1)):
        return ''
    return block.replace(url.group(1), data_uri(DIST / url.group(1).lstrip('/')))


css = re.sub(r'@font-face\s*\{[^}]*\}', font_face, css)
css = re.sub(r',?\s*url\(/_astro/[^)]+\.woff\)\s*format\("woff"\)', '', css)

# --- Shell: header and footer from the homepage
home = (DIST / 'index.html').read_text()
industries = re.search(r'<html[^>]*data-industries="([^"]*)"', home).group(1)
body = re.search(r'<body[^>]*>(.*)</body>', home, re.S).group(1)
body = re.sub(r'<script.*?</script>', '', body, flags=re.S)
body = re.sub(r'<main id="main">.*</main>', '<main id="main"></main>', body, flags=re.S)
body = rewrite_links(body.replace(' aria-current="page"', ''))

runtime = (ROOT / 'scripts' / 'preview-runtime.js').read_text()
pages_json = json.dumps(pages).replace('</', '<\\/')

OUT.write_text(f'''<!doctype html>
<html lang="en" data-industries="{industries}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Technical Source | Site preview</title>
<link rel="icon" href="{data_uri(DIST / 'favicon.svg')}">
<style>{css}</style>
<style>.preview-bar{{position:fixed;left:50%;bottom:14px;translate:-50% 0;z-index:200;background:#212121;color:#eee;
font:600 12px/1.2 'Open Sans Variable',sans-serif;padding:8px 14px;border-radius:999px;box-shadow:0 6px 20px rgb(0 0 0/25%)}}
.preview-bar button{{font:inherit;background:none;border:0;color:#C0D961;cursor:pointer;margin-left:8px;text-decoration:underline}}</style>
</head><body>
{body}
<div class="preview-bar">Prototype preview · <span id="preview-route">/</span><button type="button" id="preview-reset">Reset visitor memory</button></div>
<script type="application/json" id="pages">{pages_json}</script>
<script>{runtime}</script>
</body></html>
''')
print(f'wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB, {len(pages)} pages)')

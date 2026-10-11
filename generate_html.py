#!/usr/bin/env python3
"""Build a single-file WattWise Buffalo web app from the source files.

Run: python generate_html.py
Requires: Python 3.8+ standard library only.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HTML = ROOT / 'index.html'
CSS = ROOT / 'styles.css'
JS = ROOT / 'app.js'
OUTPUT = ROOT / 'wattwise_buffalo_generated.html'


def build() -> Path:
    html = HTML.read_text(encoding='utf-8')
    css = CSS.read_text(encoding='utf-8')
    js = JS.read_text(encoding='utf-8')

    css_link = '<link href="styles.css" rel="stylesheet"/>'
    js_script = '<script src="app.js"></script>'
    if html.count(css_link) != 1 or html.count(js_script) != 1:
        raise ValueError('Expected CSS/JS references not found exactly once in index.html')

    # Inline CSS and JavaScript so the result works without separate assets.
    # Escape closing tags to avoid prematurely ending the HTML blocks.
    css = css.replace('</style', '<\\/style')
    js = js.replace('</script', '<\\/script')
    html = html.replace(css_link, '<style>\n' + css + '\n</style>')
    html = html.replace(js_script, '<script>\n' + js + '\n</script>')

    OUTPUT.write_text(html, encoding='utf-8')
    return OUTPUT


if __name__ == '__main__':
    output = build()
    print(f'Generated: {output}')
    print(f'Size: {output.stat().st_size:,} bytes')

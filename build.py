"""Build index.html: inlines vendor/d3-delaunay, src/engine.js and src/ui.js into src/template.html."""
import pathlib
root = pathlib.Path(__file__).parent
rd = lambda p: (root / p).read_text(encoding='utf-8')
d3, eng, ui, h = rd('vendor/d3-delaunay.min.js'), rd('src/engine.js'), rd('src/ui.js'), rd('src/template.html')
for src in (d3, eng):
    assert '</script' not in src and '<!--' not in src
h = h.replace('/*__D3__*/', d3).replace('/*__ENGINE__*/', eng).replace('/*__UI__*/', ui)
assert '__D3__' not in h and '__ENGINE__' not in h and '__UI__' not in h
doc = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' + h + '\n</html>\n'
(root / 'index.html').write_text(doc, encoding='utf-8')
print('built index.html', len(doc), 'bytes')

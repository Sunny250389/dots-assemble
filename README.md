# Stipple Press

Turn a photograph into a stippled drawing made of dots. Runs entirely in the browser: the image never leaves your device.

## How it works
- The photo becomes a density map (darker = more dots). Auto-levels, brightness, contrast, edge emphasis and detail boost shape it.
- Dots are placed by weighted Voronoi stippling (Secord) using Lloyd relaxation, so dark areas are filled with dense dots of constant size and the pattern in the image is followed.
- Heavy work runs in a Web Worker (with a main-thread fallback).
- Subject focus: auto-detect the background from the edges (works best on plain or blurred backgrounds) and/or paint the mask by hand; background dots are thinned.
- Export PNG (up to 64 MP) or SVG (vector, in millimetres).

## Limits
- Up to 500,000 dots on desktop; capped at 150,000 on phones and low-memory devices.
- Auto-detect fails on busy backgrounds; use the brush.
- Every mask edit re-solves the dots (about 6 s at 100k dots).

## Develop
No dependencies to run. Edit `src/`, then rebuild the single-file page:

    python3 build.py

This writes `index.html`, which is what GitHub Pages serves.

## Credits
[d3-delaunay](https://github.com/d3/d3-delaunay) (ISC, bundled in `vendor/`). Fonts: Archivo and Martian Mono via Google Fonts.

MIT licensed (see `LICENSE`).

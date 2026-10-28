const Stipple = (() => {
  let DelaunayCls = null;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Separable [1 2 1]/4 blur with clamped borders.
  function blur3(src, W, H) {
    const tmp = new Float32Array(W * H);
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const r = y * W;
      for (let x = 0; x < W; x++) {
        const a = src[r + (x > 0 ? x - 1 : 0)], b = src[r + x], c = src[r + (x < W - 1 ? x + 1 : x)];
        tmp[r + x] = (a + 2 * b + c) * 0.25;
      }
    }
    for (let y = 0; y < H; y++) {
      const y0 = (y > 0 ? y - 1 : 0) * W, y1 = y * W, y2 = (y < H - 1 ? y + 1 : y) * W;
      for (let x = 0; x < W; x++) out[y1 + x] = (tmp[y0 + x] + 2 * tmp[y1 + x] + tmp[y2 + x]) * 0.25;
    }
    return out;
  }

  // Sobel gradient magnitude of a lightly smoothed image, scaled so the 95th percentile maps to 1.
  function edgeMap(gray, W, H) {
    const g = blur3(blur3(gray, W, H), W, H);
    const mag = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = -g[i - W - 1] - 2 * g[i - 1] - g[i + W - 1] + g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1];
        const gy = -g[i - W - 1] - 2 * g[i - W] - g[i - W + 1] + g[i + W - 1] + 2 * g[i + W] + g[i + W + 1];
        mag[i] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    const sorted = Float32Array.from(mag).sort();
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const out = new Float32Array(W * H);
    if (p95 > 1e-6) for (let i = 0; i < out.length; i++) out[i] = Math.min(1, mag[i] / p95);
    return out;
  }

  // Wide blur used as the "base" layer for detail boost (unsharp mask). Radius scales with raster size.
  function detailBlur(gray, W, H) {
    let g = gray;
    const passes = Math.max(2, Math.round(Math.max(W, H) / 110));
    for (let k = 0; k < passes; k++) g = blur3(g, W, H);
    return g;
  }

  // o: {auto, invert, bright (-0.5..0.5), contrast (-0.8..0.8), edge (0..1.4), detail (0..1)}
  // Returns per-pixel weight rho (high = more dots) and its cumulative distribution for sampling.
  function buildDensity(gray0, blur, edge, W, H, o) {
    const n = W * H;
    const kd = (o.detail || 0) * 2.5;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) gray[i] = gray0[i] + kd * (gray0[i] - blur[i]);
    // Optional subject mask (1 = subject, 0 = background): feathered, resampled to this raster, used to thin the background.
    let mk = null;
    if (o.mask && o.mask.data) {
      let md = o.mask.data;
      for (let q = 0; q < (o.feather | 0); q++) md = blur3(md, o.mask.w, o.mask.h);
      const mw = o.mask.w, mh = o.mask.h;
      mk = new Float32Array(n);
      for (let y = 0; y < H; y++) {
        const fy = Math.min(mh - 1, Math.max(0, ((y + 0.5) * mh) / H - 0.5)), y0 = fy | 0, y1 = Math.min(mh - 1, y0 + 1), ty = fy - y0;
        for (let x = 0; x < W; x++) {
          const fx = Math.min(mw - 1, Math.max(0, ((x + 0.5) * mw) / W - 0.5)), x0 = fx | 0, x1 = Math.min(mw - 1, x0 + 1), tx = fx - x0;
          const top = md[y0 * mw + x0] * (1 - tx) + md[y0 * mw + x1] * tx, bot = md[y1 * mw + x0] * (1 - tx) + md[y1 * mw + x1] * tx;
          mk[y * W + x] = top * (1 - ty) + bot * ty;
        }
      }
    }
    const bgLevel = o.bg == null ? 1 : o.bg;
    let lo = 0, hi = 1;
    if (o.auto) {
      const hist = new Uint32Array(256);
      let cnt = 0; // with a mask, levels are measured on the subject only so a dark backdrop does not skew them
      for (let i = 0; i < n; i++) if (!mk || mk[i] > 0.5) { hist[Math.min(255, (clamp01(gray[i]) * 255) | 0)]++; cnt++; }
      if (cnt < n * 0.002) { hist.fill(0); cnt = n; for (let i = 0; i < n; i++) hist[Math.min(255, (clamp01(gray[i]) * 255) | 0)]++; }
      let acc = 0, a = 0, b = 255;
      for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= cnt * 0.01) { a = k; break; } }
      acc = 0;
      for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= cnt * 0.01) { b = k; break; } }
      lo = a / 255; hi = b / 255;
      if (hi - lo < 0.05) { lo = 0; hi = 1; }
    }
    const k = Math.tan((o.contrast + 1) * Math.PI / 4);
    const rho = new Float32Array(n);
    const cdf = new Float64Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      let l = clamp01((gray[i] - lo) / (hi - lo));
      l = clamp01((l - 0.5) * k + 0.5 + o.bright);
      const f = mk ? bgLevel + (1 - bgLevel) * mk[i] : 1;
      const d = ((o.invert ? l : 1 - l) + o.edge * edge[i]) * f;
      rho[i] = d;
      total += d;
      cdf[i] = total;
    }
    if (total <= 1e-9) { // blank image: avoid a degenerate distribution
      total = 0;
      for (let i = 0; i < n; i++) { rho[i] = 1e-3; total += 1e-3; cdf[i] = total; }
    }
    return { rho, cdf, total };
  }

  function samplePoint(cdf, total, W, rng, out, j) {
    const r = rng() * total;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] >= r) hi = m; else lo = m + 1; }
    out[j] = (lo % W) + rng();
    out[j + 1] = ((lo / W) | 0) + rng();
  }

  function initPoints(N, dens, W, rng) {
    const pts = new Float64Array(N * 2);
    for (let i = 0; i < N; i++) samplePoint(dens.cdf, dens.total, W, rng, pts, i * 2);
    return pts;
  }

  // One step of weighted Lloyd relaxation: every dot moves toward the density-weighted centroid of its Voronoi cell.
  function relaxStep(pts, N, dens, W, H, rng, t) {
    const del = new DelaunayCls(pts);
    const rho = dens.rho;
    const sw = new Float64Array(N), sx = new Float64Array(N), sy = new Float64Array(N);
    let idx = 0;
    for (let y = 0; y < H; y++) {
      const row = y * W, py = y + 0.5;
      for (let x = 0; x < W; x++) {
        const w = rho[row + x];
        if (w < 1e-4) continue;
        idx = del.find(x + 0.5, py, idx);
        sw[idx] += w; sx[idx] += w * (x + 0.5); sy[idx] += w * py;
      }
    }
    const wob = (1 - t) * (1 - t);
    for (let i = 0; i < N; i++) {
      const j = i * 2;
      if (sw[i] > 1e-9) {
        const cx = sx[i] / sw[i], cy = sy[i] / sw[i];
        let nx = pts[j] + (cx - pts[j]) * 1.8 + (rng() - 0.5) * wob;
        let ny = pts[j + 1] + (cy - pts[j + 1]) * 1.8 + (rng() - 0.5) * wob;
        pts[j] = nx < 0 ? 0 : nx > W ? W : nx;
        pts[j + 1] = ny < 0 ? 0 : ny > H ? H : ny;
      } else {
        samplePoint(dens.cdf, dens.total, W, rng, pts, j); // empty cell: relocate to where ink is needed
      }
    }
  }

  function toneAt(pts, N, dens, W, H) {
    const tone = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = Math.min(W - 1, Math.max(0, pts[i * 2] | 0));
      const y = Math.min(H - 1, Math.max(0, pts[i * 2 + 1] | 0));
      tone[i] = clamp01(dens.rho[y * W + x]);
    }
    return tone;
  }

  // Local dot spacing (in raster px) implied by the density at each dot: 1 / sqrt(dots per px^2).
  function spacingAt(pts, N, dens, W, H) {
    const sp = new Float32Array(N);
    const cap = 0.05 * Math.max(W, H);
    for (let i = 0; i < N; i++) {
      const x = Math.min(W - 1, Math.max(0, pts[i * 2] | 0));
      const y = Math.min(H - 1, Math.max(0, pts[i * 2 + 1] | 0));
      const lambda = (N * Math.max(dens.rho[y * W + x], 1e-6)) / dens.total;
      sp[i] = Math.min(cap, 1 / Math.sqrt(lambda));
    }
    return sp;
  }

  // Fixed gaussian offsets (unit sigma), one pair per dot, so randomness can be rescaled without re-solving.
  function gaussOffsets(N, rng) {
    const off = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const r = Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))), a = 6.283185307 * rng();
      off[i * 2] = r * Math.cos(a); off[i * 2 + 1] = r * Math.sin(a);
    }
    return off;
  }

  return { mulberry32, blur3, edgeMap, detailBlur, buildDensity, initPoints, relaxStep, toneAt, spacingAt, gaussOffsets, setDelaunay: (c) => { DelaunayCls = c; } };
})();

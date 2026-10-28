(() => {
  const $ = (id) => document.getElementById(id);
  const PAPERS = { A6: [105, 148], A5: [148, 210], A4: [210, 297], A3: [297, 420], Letter: [215.9, 279.4], Square: [200, 200] };
  const PRESETS = [
    { name: 'Carbon black on white', ink: '#15171A', paper: '#FBFBF8', invert: false },
    { name: 'Ballpoint blue on white', ink: '#1F3FBF', paper: '#FBFBF8', invert: false },
    { name: 'Madder red on kraft', ink: '#8E1B1B', paper: '#D8C3A0', invert: false },
    { name: 'Sepia on parchment', ink: '#4A2C17', paper: '#EAD9B8', invert: false },
    { name: 'Chalk on slate', ink: '#F3F3EE', paper: '#17191C', invert: true },
    { name: 'Cyanotype', ink: '#E8F0FF', paper: '#1D3FA8', invert: true },
  ];
  const st = {
    W: 0, H: 0, gray: null, blur: null, edge: null, key: 0, sentKey: 0, src: null, side: 0,
    N: 0, pts: null, tone: null, sp: null, off: null, nextOff: null, dense: 0,
    token: 0, timer: 0, solving: false, seed: 7, zoom: 1, sizeKey: '', iters: 0, t0: 0, elapsed: 0, compare: false, ptsW: 0, ptsH: 0,
    mw: 0, mh: 0, mask: null, maskOn: false, maskPrev: null, tool: null, painting: false, last: null,
    edges: { top: true, left: true, right: true, bottom: false },
  };
  const RAD = { d: 0.2, v: 0 }; // cached dot-size controls, refreshed by labels()
  const cv = $('cv');
  let dl = null;
  const DL_NOTE = $('dlnote').textContent;
  Stipple.setDelaunay(d3.Delaunay);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const num = (id) => parseFloat($(id).value);
  const dotCount = () => {
    const n = 500 * Math.pow(1000, num('count') / 100); // 500 .. 500,000 on a log scale
    const step = n >= 100000 ? 5000 : n >= 20000 ? 1000 : n >= 5000 ? 250 : 50;
    return Math.round(n / step) * step;
  };
  // Working raster grows with dot count so the density map can resolve fine patterns (benchmarked: 1280 px is too coarse past ~300k dots).
  const rasterSide = (N) => Math.min(2048, Math.max(512, Math.ceil((Math.sqrt(N) * 4) / 64) * 64));
  const fmt = (v) => (Math.round(v * 10) / 10).toString();
  const signed = (v) => (v > 0 ? '+' + v : String(v));

  function labels() {
    RAD.d = num('dia') / 2; RAD.v = num('var') / 100;
    $('countOut').textContent = dotCount().toLocaleString();
    $('diaOut').textContent = num('dia').toFixed(2) + ' mm';
    $('varOut').textContent = num('var') + '%';
    $('jitOut').textContent = num('jit') + '%';
    $('brightOut').textContent = signed(num('bright'));
    $('contrastOut').textContent = signed(num('contrast'));
    $('detailOut').textContent = num('detail') + '%';
    $('edgeOut').textContent = num('edge') + '%';
    $('marginOut').textContent = num('margin') + ' mm';
    $('passesOut').textContent = String(num('passes'));
    $('sensOut').textContent = String(num('sens'));
    $('bgdOut').textContent = num('bgd') + '%';
    $('softOut').textContent = num('soft') + '%';
    $('bsizeOut').textContent = num('bsize') + '%';
  }

  /* ---------- source image ---------- */
  function makeSample() {
    const w = 720, h = 900, c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    const bg = x.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#f4f4f2'); bg.addColorStop(0.62, '#cdcdca');
    bg.addColorStop(0.62, '#9b9b98'); bg.addColorStop(1, '#585856');
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#2a2a2a'; x.lineWidth = 12; x.strokeRect(70, 80, 170, 260);
    x.lineWidth = 7; x.beginPath(); x.moveTo(155, 80); x.lineTo(155, 340); x.moveTo(70, 210); x.lineTo(240, 210); x.stroke();
    const shadow = (cx, cy, rx, ry) => {
      x.save(); x.translate(cx, cy); x.scale(1, ry / rx);
      const g = x.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, 'rgba(0,0,0,0.75)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(-rx, -rx, rx * 2, rx * 2); x.restore();
    };
    const ball = (cx, cy, r, light) => {
      const g = x.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.05, cx, cy, r);
      g.addColorStop(0, light); g.addColorStop(0.35, '#c4c4c2'); g.addColorStop(0.8, '#444'); g.addColorStop(1, '#161616');
      x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    };
    shadow(390, 706, 270, 270 * 0.26);
    shadow(600, 742, 120, 120 * 0.26);
    ball(330, 470, 230, '#ffffff');
    ball(590, 650, 95, '#f2f2f2');
    return c;
  }

  // Keep a decoded copy (up to 2800 px) so the working raster can be rebuilt at other resolutions.
  function keepSource(src, sw, sh) {
    const s = Math.min(1, 2800 / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, c.width, c.height);
    st.src = c; st.side = 0;
    // The subject mask lives at a fixed 512 px resolution, independent of the solver's working raster.
    const ms = 512 / Math.max(c.width, c.height);
    st.mw = Math.max(8, Math.round(c.width * ms)); st.mh = Math.max(8, Math.round(c.height * ms));
    st.mask = null; st.maskOn = false; st.maskPrev = null;
    resetMaskUi();
  }

  // Rasterise to a grayscale working map. The blur and edge maps are built by the solver (in the worker, or lazily here as a fallback).
  function prepare(side) {
    const sw = st.src.width, sh = st.src.height, s = side / Math.max(sw, sh);
    const W = Math.max(8, Math.round(sw * s)), H = Math.max(8, Math.round(sh * s));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.imageSmoothingQuality = 'high';
    x.drawImage(st.src, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data;
    const gray = new Float32Array(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
    st.W = W; st.H = H; st.gray = gray; st.blur = null; st.edge = null; st.side = side; st.key++;
  }
  function mainMaps() {
    if (!st.blur) { st.blur = Stipple.detailBlur(st.gray, st.W, st.H); st.edge = Stipple.edgeMap(st.gray, st.W, st.H); }
  }

  function markFresh() {
    const s = document.querySelector('.sheet');
    s.classList.remove('fresh'); void s.offsetWidth; s.classList.add('fresh');
  }

  function useSample() {
    const c = makeSample();
    keepSource(c, c.width, c.height);
    $('fname').textContent = 'or drop one here. Using the sample.';
    markFresh();
    solve();
  }

  function loadFile(file) {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) { $('fname').textContent = 'That file is not an image.'; return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 800, h = img.naturalHeight || 800;
      keepSource(img, w, h);
      $('fname').textContent = (file.name || 'Pasted image') + ' · ' + w + ' × ' + h + ' px';
      URL.revokeObjectURL(url);
      markFresh();
      solve();
    };
    img.onerror = () => { $('fname').textContent = 'Could not read that image. Try a JPG or PNG.'; URL.revokeObjectURL(url); };
    img.src = url;
  }

  /* ---------- solver worker ---------- */
  // This function's source runs inside the worker, after the inlined d3-delaunay and engine sources.
  function workerMain() {
    Stipple.setDelaunay(d3.Delaunay);
    let current = 0, cache = null;
    const tick = () => new Promise((r) => setTimeout(r, 0));
    self.onmessage = async (e) => {
      const m = e.data;
      if (m.type !== 'solve') return;
      current = m.id;
      if (m.gray) {
        cache = { key: m.key, W: m.W, H: m.H, gray: m.gray, blur: Stipple.detailBlur(m.gray, m.W, m.H), edge: Stipple.edgeMap(m.gray, m.W, m.H) };
      }
      if (!cache || cache.key !== m.key) { self.postMessage({ type: 'resend', id: m.id }); return; }
      const W = cache.W, H = cache.H, N = m.N;
      const dens = Stipple.buildDensity(cache.gray, cache.blur, cache.edge, W, H, m.opts);
      const rng = Stipple.mulberry32(m.seed);
      const pts = Stipple.initPoints(N, dens, W, rng);
      const send = (type, k, final) => {
        const tone = Stipple.toneAt(pts, N, dens, W, H), sp = Stipple.spacingAt(pts, N, dens, W, H);
        const p = final ? pts : pts.slice();
        const msg = { type, id: m.id, k, pts: p, tone, sp };
        if (final) { const r = Float32Array.from(sp).sort(); msg.dense = r[Math.floor(r.length * 0.02)] || 0; }
        self.postMessage(msg, [p.buffer, tone.buffer, sp.buffer]);
      };
      send('frame', 0, false);
      for (let k = 0; k < m.iters; k++) {
        await tick();
        if (current !== m.id) return;
        Stipple.relaxStep(pts, N, dens, W, H, rng, k / m.iters);
        self.postMessage({ type: 'progress', id: m.id, k: k + 1 });
        if (k + 1 < m.iters && (k + 1) % m.stride === 0) send('frame', k + 1, false);
      }
      if (current !== m.id) return;
      send('done', m.iters, true);
    };
  }

  let worker = null, workerFailed = false;
  function getWorker() {
    if (workerFailed) return null;
    if (worker) return worker;
    try {
      const src = $('src-d3').textContent + '\n' + $('src-engine').textContent + '\n;(' + workerMain.toString() + ')();';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = onWorkerMessage;
      w.onerror = () => {
        workerFailed = true; worker = null;
        try { w.terminate(); } catch (e) { /* already gone */ }
        if (st.solving) solve(); // carry on in the page itself
      };
      worker = w; st.sentKey = 0;
    } catch (e) { workerFailed = true; worker = null; }
    return worker;
  }

  function onWorkerMessage(e) {
    const m = e.data;
    if (m.id !== st.token) return;
    if (m.type === 'resend') { st.sentKey = 0; solve(); return; }
    if (m.type === 'progress') {
      setProg(m.k / Math.max(1, st.iters));
      $('stats').textContent = 'Spacing dots ' + m.k + ' / ' + st.iters;
      return;
    }
    st.N = m.pts.length / 2; st.pts = m.pts; st.tone = m.tone; st.sp = m.sp; st.off = st.nextOff; st.ptsW = st.W; st.ptsH = st.H;
    if (m.type === 'frame') { scheduleRedraw(); return; }
    st.dense = m.dense;
    st.solving = false; st.elapsed = (performance.now() - st.t0) / 1000;
    setProg(0);
    redraw();
  }

  /* ---------- solving ---------- */
  function densityOptions() {
    return { auto: $('auto').checked, invert: $('invert').checked, bright: num('bright') / 100, contrast: num('contrast') / 100, edge: (num('edge') / 100) * 1.4, detail: num('detail') / 100,
      mask: st.maskOn && st.mask ? { data: st.mask, w: st.mw, h: st.mh } : null, bg: num('bgd') / 100, feather: Math.round(num('soft') * 0.4) };
  }
  function setProg(v) { $('bar').style.width = Math.round(v * 100) + '%'; }

  async function solve() {
    if (!st.src) return;
    clearTimeout(st.timer);
    const token = ++st.token;
    st.solving = true; st.t0 = performance.now();
    const N = dotCount(), side = rasterSide(N), iters = num('passes');
    st.iters = iters;
    if (side !== st.side) {
      $('stats').textContent = 'Preparing image…';
      await tick();
      if (token !== st.token) return;
      prepare(side);
      redraw(true);
    }
    const w = getWorker();
    if (w) {
      st.nextOff = Stipple.gaussOffsets(N, Stipple.mulberry32(st.seed ^ 0x9e3779b9));
      const msg = { type: 'solve', id: token, key: st.key, N, iters, seed: st.seed, opts: densityOptions(), stride: N > 300000 ? 3 : N > 150000 ? 2 : 1 };
      const transfer = [];
      if (st.sentKey !== st.key) { msg.gray = st.gray.slice(); msg.W = st.W; msg.H = st.H; transfer.push(msg.gray.buffer); st.sentKey = st.key; }
      $('stats').textContent = 'Preparing dots…';
      w.postMessage(msg, transfer);
      return;
    }
    return solveInPage(token, N, iters);
  }

  // Fallback when the browser will not run the worker: the same algorithm on the page thread.
  async function solveInPage(token, N, iters) {
    $('stats').textContent = 'Preparing dots…';
    await tick();
    if (token !== st.token) return;
    mainMaps();
    const dens = Stipple.buildDensity(st.gray, st.blur, st.edge, st.W, st.H, densityOptions());
    const rng = Stipple.mulberry32(st.seed);
    const pts = Stipple.initPoints(N, dens, st.W, rng);
    st.N = N; st.pts = pts; st.ptsW = st.W; st.ptsH = st.H; st.off = Stipple.gaussOffsets(N, Stipple.mulberry32(st.seed ^ 0x9e3779b9));
    st.tone = Stipple.toneAt(pts, N, dens, st.W, st.H); st.sp = Stipple.spacingAt(pts, N, dens, st.W, st.H);
    redraw(true);
    const stride = N > 300000 ? 3 : N > 150000 ? 2 : 1; // repaint less often when a repaint is expensive
    for (let k = 0; k < iters; k++) {
      await tick();
      if (token !== st.token) return;
      Stipple.relaxStep(pts, N, dens, st.W, st.H, rng, k / iters);
      setProg((k + 1) / iters);
      $('stats').textContent = 'Spacing dots ' + (k + 1) + ' / ' + iters;
      if ((k + 1) % stride === 0 && k + 1 < iters) {
        st.tone = Stipple.toneAt(pts, N, dens, st.W, st.H); st.sp = Stipple.spacingAt(pts, N, dens, st.W, st.H);
        redraw(true);
      }
    }
    if (token !== st.token) return;
    st.tone = Stipple.toneAt(pts, N, dens, st.W, st.H); st.sp = Stipple.spacingAt(pts, N, dens, st.W, st.H);
    const ranked = Float32Array.from(st.sp).sort();
    st.dense = ranked[Math.floor(ranked.length * 0.02)] || 0; // spacing in the densest 2% of the picture, raster px
    st.solving = false; st.elapsed = (performance.now() - st.t0) / 1000;
    setProg(0);
    redraw();
  }
  function scheduleSolve() { clearTimeout(st.timer); st.timer = setTimeout(solve, workerFailed ? (dotCount() > 150000 ? 600 : 220) : 250); }

  /* ---------- geometry and painting ---------- */
  function geom() {
    let [pw, ph] = PAPERS[$('paper').value];
    const o = $('orient').value;
    const landscape = o === 'auto' ? st.W > st.H : o === 'landscape';
    if (landscape !== pw > ph) [pw, ph] = [ph, pw];
    const m = num('margin');
    const s = Math.max(0.0001, Math.min((pw - 2 * m) / st.W, (ph - 2 * m) / st.H));
    return { pw, ph, s, ox: (pw - st.W * s) / 2, oy: (ph - st.H * s) / 2 };
  }
  function radiusMm(tone) {
    return RAD.d * (1 - RAD.v + RAD.v * (0.4 + 1.2 * tone));
  }
  // Dot positions in raster px with the Randomness scatter applied (sigma = half the slider times local spacing).
  function positions() {
    const amt = (num('jit') / 100) * 0.5, p = st.pts, o = st.off, sp = st.sp, W = st.ptsW, H = st.ptsH;
    const out = new Float32Array(st.N * 2);
    for (let i = 0; i < st.N; i++) {
      const s = sp[i] * amt;
      const x = p[i * 2] + o[i * 2] * s, y = p[i * 2 + 1] + o[i * 2 + 1] * s;
      out[i * 2] = x < 0 ? 0 : x > W ? W : x;
      out[i * 2 + 1] = y < 0 ? 0 : y > H ? H : y;
    }
    return out;
  }
  // step > 1 paints a thinned draft: every step-th dot, drawn slightly larger so the tone stays close.
  function paint(ctx, pxmm, g, showSource, step = 1) {
    ctx.fillStyle = $('paperc').value;
    ctx.fillRect(0, 0, g.pw * pxmm, g.ph * pxmm);
    if (showSource && st.src) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(st.src, g.ox * pxmm, g.oy * pxmm, st.W * g.s * pxmm, st.H * g.s * pxmm);
      return;
    }
    if (!st.pts) return;
    ctx.fillStyle = $('inkc').value;
    ctx.beginPath();
    // Points live in the raster they were solved on (ptsW); scale to the current one so a resolution change never shows them misplaced.
    const amt = (num('jit') / 100) * 0.5, p = st.pts, o = st.off, sp = st.sp, PW = st.ptsW, PH = st.ptsH;
    const k = g.s * pxmm * (st.W / PW), rs = Math.sqrt(step);
    const square = radiusMm(1) * pxmm * rs < 1.1; // below about a pixel squares are indistinguishable and paint roughly twice as fast
    for (let i = 0; i < st.N; i += step) {
      const s = sp[i] * amt;
      let x = p[i * 2] + o[i * 2] * s, y = p[i * 2 + 1] + o[i * 2 + 1] * s;
      x = x < 0 ? 0 : x > PW ? PW : x; y = y < 0 ? 0 : y > PH ? PH : y;
      const cx = g.ox * pxmm + x * k, cy = g.oy * pxmm + y * k, r = radiusMm(st.tone[i]) * pxmm * rs;
      if (square) ctx.rect(cx - r, cy - r, 2 * r, 2 * r);
      else { ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, 6.283185307); }
    }
    ctx.fill();
  }

  let rafId = 0;
  let fullTimer = 0;
  // Slider drags repaint a thinned draft, then one full repaint when the drag pauses. Only matters above 120k dots.
  function scheduleRedraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0; redraw(true);
      clearTimeout(fullTimer);
      if (st.N > 120000 && !st.solving) fullTimer = setTimeout(() => redraw(false), 220);
    });
  }

  function redraw(draft) {
    if (!st.W) return;
    const g = geom(), stage = $('stage');
    const pad = window.innerWidth <= 860 ? 56 : 98; // matches the sheet box padding, with a little to spare
    const fit = Math.min(Math.max(60, stage.clientWidth - pad) / g.pw, Math.max(60, stage.clientHeight - pad) / g.ph);
    const cssPerMm = fit * st.zoom, dpr = Math.min(2, window.devicePixelRatio || 1);
    let pxmm = cssPerMm * dpr;
    pxmm *= Math.min(1, 6000 / (Math.max(g.pw, g.ph) * pxmm));
    const key = [g.pw, g.ph, cssPerMm.toFixed(3), pxmm.toFixed(3)].join('|');
    if (key !== st.sizeKey) {
      st.sizeKey = key;
      cv.style.width = g.pw * cssPerMm + 'px';
      cv.style.height = g.ph * cssPerMm + 'px';
      cv.width = Math.round(g.pw * pxmm);
      cv.height = Math.round(g.ph * pxmm);
    }
    const step = draft && st.N > 120000 ? Math.ceil(st.N / 120000) : 1;
    paint(cv.getContext('2d'), cv.width / g.pw, g, st.compare, step);
    $('dimW').textContent = fmt(g.pw) + ' mm';
    $('dimH').textContent = fmt(g.ph) + ' mm';
    positionOverlay(g);
    if (!st.solving && st.pts && step === 1) updateStats();
  }

  function updateStats() {
    if (!st.pts) return;
    const g = geom();
    let area = 0;
    for (let i = 0; i < st.N; i++) { const r = radiusMm(st.tone[i]); area += Math.PI * r * r; }
    const cov = (area / (st.W * g.s * st.H * g.s)) * 100;
    $('specDots').textContent = st.N.toLocaleString();
    $('specSheet').textContent = fmt(g.pw) + ' × ' + fmt(g.ph) + ' mm';
    $('specDot').textContent = num('dia').toFixed(2) + ' mm' + (num('var') > 0 ? ' · varies' : '');
    $('specInk').textContent = (cov < 10 ? cov.toFixed(1) : Math.round(cov)) + '%' + (cov > 100 ? ' · overlap' : '');
    $('stats').textContent = st.compare ? 'Showing the original photo' : st.elapsed ? 'Ready · solved in ' + st.elapsed.toFixed(1) + ' s' : 'Ready';
    // In the darkest areas a hexagonal packing puts neighbours 1.075 spacings apart; dots wider than that merge.
    const nn = 1.075 * st.dense * g.s, dmax = 2 * radiusMm(1), warn = $('warn');
    if (st.dense > 0 && dmax > 0.95 * nn) {
      const fit = Math.max(0.05, Math.floor(((num('dia') * 0.9 * nn) / dmax) * 20) / 20);
      warn.textContent = 'Dots merge in the darkest areas. Spacing there is ' + nn.toFixed(2) + ' mm and the largest dot is ' + dmax.toFixed(2) + ' mm, so tonal steps are lost. Set dot size to ' + fit.toFixed(2) + ' mm or lower, or use a larger paper size.';
      warn.hidden = false;
    } else warn.hidden = true;
  }

  /* ---------- export ---------- */
  let noteTimer = 0;
  function note(msg) {
    $('dlnote').textContent = msg;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { $('dlnote').textContent = DL_NOTE; }, 5000);
  }
  async function save(filename, data) {
    if (!dl) { // plain browser (not claude.ai): normal file download
      try {
        const blob = data instanceof Blob ? data : new Blob([data], { type: filename.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        note('Saved ' + filename + '.');
      } catch (e) { note('Could not save the file' + (e && e.message ? ': ' + e.message : '.')); }
      return;
    }
    try {
      const r = await dl.save({ filename, data });
      note(r.status === 'saved' ? 'Saved ' + filename + '.' : 'Sent ' + filename + '.');
    } catch (e) {
      if (e && e.code === 'declined') note('Download cancelled.');
      else if (e && e.code === 'rate_limited') note('A save prompt is already open. Answer it, then try again.');
      else note('Could not save the file' + (e && e.message ? ': ' + e.message : '.'));
    }
  }
  function baseName() { return 'dots-assemble-' + $('paper').value.toLowerCase() + '-' + st.N + 'dots'; }

  async function exportPng() {
    if (!st.pts || st.solving) { note('Wait for the dots to finish spacing, then export.'); return; }
    const g = geom();
    let dpi = num('dpi'), pxmm = dpi / 25.4;
    const px = g.pw * g.ph * pxmm * pxmm;
    if (px > 64e6) { pxmm *= Math.sqrt(64e6 / px); dpi = Math.round(pxmm * 25.4); } // stay inside browser canvas limits
    const c = document.createElement('canvas');
    c.width = Math.round(g.pw * pxmm); c.height = Math.round(g.ph * pxmm);
    paint(c.getContext('2d'), c.width / g.pw, g, false);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!blob) { note('The browser could not encode a PNG this large. Choose a lower export resolution.'); return; }
    await save(baseName() + '-' + dpi + 'dpi.png', blob);
  }

  async function exportSvg() {
    if (!st.pts || st.solving) { note('Wait for the dots to finish spacing, then export.'); return; }
    const g = geom(), f = (v) => Math.round(v * 100) / 100, p = positions();
    const out = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + g.pw + 'mm" height="' + g.ph + 'mm" viewBox="0 0 ' + g.pw + ' ' + g.ph + '">',
      '<rect width="' + g.pw + '" height="' + g.ph + '" fill="' + $('paperc').value + '"/>',
      '<g fill="' + $('inkc').value + '">',
    ];
    if (st.N <= 150000) {
      for (let i = 0; i < st.N; i++) {
        out.push('<circle cx="' + f(g.ox + p[i * 2] * g.s) + '" cy="' + f(g.oy + p[i * 2 + 1] * g.s) + '" r="' + Math.round(radiusMm(st.tone[i]) * 1000) / 1000 + '"/>');
      }
    } else {
      // Large files: one stroked zero-length segment per dot, grouped into 24 size classes. About a third of the size of circles.
      const nb = 24, rs = new Float32Array(st.N);
      let rmin = Infinity, rmax = 0;
      for (let i = 0; i < st.N; i++) { const r = radiusMm(st.tone[i]); rs[i] = r; if (r < rmin) rmin = r; if (r > rmax) rmax = r; }
      const span = rmax - rmin, groups = Array.from({ length: nb }, () => []);
      for (let i = 0; i < st.N; i++) {
        const b = span < 1e-4 ? 0 : Math.min(nb - 1, Math.floor(((rs[i] - rmin) / span) * nb));
        groups[b].push('M' + f(g.ox + p[i * 2] * g.s) + ' ' + f(g.oy + p[i * 2 + 1] * g.s) + 'h0');
      }
      groups.forEach((d, b) => {
        if (!d.length) return;
        const r = span < 1e-4 ? rmax : rmin + ((b + 0.5) * span) / nb;
        out.push('<path fill="none" stroke="' + $('inkc').value + '" stroke-width="' + Math.round(2 * r * 1000) / 1000 + '" stroke-linecap="round" d="' + d.join('') + '"/>');
      });
    }
    out.push('</g>', '</svg>');
    await save(baseName() + '.svg', out.join('\n'));
  }

  /* ---------- stippled wordmark ---------- */
  // The masthead title is drawn with this page's own engine: dots scatter, then settle into the letters.
  function initMark() {
    const c = $('mark');
    if (!c) return;
    const RW = 760, RH = 96, N = 2200;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let m = null, raf = 0, t0 = 0, cw = 0;

    const build = () => {
      const off = document.createElement('canvas');
      off.width = RW; off.height = RH;
      const x = off.getContext('2d', { willReadFrequently: true });
      x.fillStyle = '#fff'; x.fillRect(0, 0, RW, RH);
      x.fillStyle = '#000'; x.textBaseline = 'alphabetic';
      const text = 'DOTS ASSEMBLE';
      const setFont = (px) => {
        x.font = '900 expanded ' + px + 'px Archivo, "Arial Black", Arial, sans-serif';
        if (x.font.indexOf(px + 'px') < 0) x.font = '900 ' + px + 'px Archivo, "Arial Black", Arial, sans-serif'; // browser without stretch keywords
      };
      setFont(100);
      let w = x.measureText(text).width;
      const fs = Math.max(20, Math.min(86, Math.floor((100 * (RW - 12)) / Math.max(1, w))));
      setFont(fs);
      w = x.measureText(text).width;
      x.fillText(text, (RW - w) / 2, (RH + fs * 0.72) / 2);
      const d = x.getImageData(0, 0, RW, RH).data;
      const gray = new Float32Array(RW * RH);
      for (let i = 0; i < gray.length; i++) gray[i] = d[i * 4] / 255;
      const dens = Stipple.buildDensity(gray, gray, new Float32Array(RW * RH), RW, RH, { auto: false, invert: false, bright: 0, contrast: 0, edge: 0, detail: 0 });
      const rng = Stipple.mulberry32(11);
      const pts = Stipple.initPoints(N, dens, RW, rng);
      for (let k = 0; k < 14; k++) Stipple.relaxStep(pts, N, dens, RW, RH, rng, k / 14);
      const start = new Float32Array(N * 2), delay = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        start[i * 2] = rng() * RW; start[i * 2 + 1] = rng() * RH;
        delay[i] = (pts[i * 2] / RW) * 0.5 + rng() * 0.08; // letters assemble left to right
      }
      return { pts, start, delay };
    };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1), w = c.clientWidth || RW;
      c.width = Math.round(w * dpr); c.height = Math.round((w * dpr * RH) / RW);
      cw = (w / RW) * dpr;
    };
    const draw = (T) => {
      if (!m) return;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#111';
      ctx.beginPath();
      const r = 1.15 * cw;
      for (let i = 0; i < N; i++) {
        let e = 1;
        if (T !== null) { const u = Math.min(1, Math.max(0, (T - m.delay[i] * 1000) / 1100)); e = 1 - Math.pow(1 - u, 3); }
        const px = (m.start[i * 2] + (m.pts[i * 2] - m.start[i * 2]) * e) * cw;
        const py = (m.start[i * 2 + 1] + (m.pts[i * 2 + 1] - m.start[i * 2 + 1]) * e) * cw;
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, 6.283185307);
      }
      ctx.fill();
    };
    const play = () => {
      t0 = performance.now();
      const step = (now) => {
        const T = now - t0;
        draw(T);
        if (T < 1800) raf = requestAnimationFrame(step); else { raf = 0; draw(null); }
      };
      raf = requestAnimationFrame(step);
    };
    const settle = () => { if (!raf) draw(null); };
    const begin = () => {
      try { m = build(); } catch (e) { return; }
      resize();
      if (reduce) draw(null); else play();
    };

    const fontReady = document.fonts && document.fonts.load
      ? Promise.race([document.fonts.load('900 86px Archivo'), new Promise((r) => setTimeout(r, 1500))])
      : Promise.resolve();
    fontReady.then(begin, begin);

    if (window.ResizeObserver) new ResizeObserver(() => { if (m) { resize(); settle(); } }).observe(c);
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', settle);
    }
    new MutationObserver(settle).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  /* ---------- subject mask ---------- */
  // st.mask: 1 = subject, 0 = background, at st.mw x st.mh. The solver thins the dots wherever it is 0.
  function maskMsg(t) { const el = $('maskMsg'); el.textContent = t; el.hidden = !t; }
  function updateUndo() { $('btnMaskUndo').disabled = !st.maskPrev; $('btnMaskClear').disabled = !st.maskOn; }
  function resetMaskUi() { maskMsg(''); updateUndo(); drawOverlay(); }
  let ovRaf = 0;
  function scheduleOverlay() { if (ovRaf) return; ovRaf = requestAnimationFrame(() => { ovRaf = 0; drawOverlay(); }); }
  // The overlay is its own canvas, so painting a stroke never repaints the dots.
  function drawOverlay() {
    const ov = $('ov');
    const show = !!(st.maskOn && st.mask && $('maskview').checked); // the tick box alone decides
    ov.hidden = !show;
    if (!show) return;
    if (ov.width !== st.mw || ov.height !== st.mh) { ov.width = st.mw; ov.height = st.mh; }
    const ctx = ov.getContext('2d'), img = ctx.createImageData(st.mw, st.mh), d = img.data, m = st.mask;
    for (let i = 0; i < m.length; i++) { d[i * 4] = 212; d[i * 4 + 1] = 46; d[i * 4 + 2] = 22; d[i * 4 + 3] = (1 - m[i]) * 110; }
    ctx.putImageData(img, 0, 0);
  }
  function positionOverlay(g) {
    const ov = $('ov');
    ov.style.left = (g.ox / g.pw) * 100 + '%'; ov.style.top = (g.oy / g.ph) * 100 + '%';
    ov.style.width = ((st.W * g.s) / g.pw) * 100 + '%'; ov.style.height = ((st.H * g.s) / g.ph) * 100 + '%';
  }

  // Perceptual-ish colour distance ("redmean"), 0 to about 765.
  const rmean = (r1, g1, b1, r2, g2, b2) => {
    const rm = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  };

  // Background = everything reachable from the chosen edges through pixels that match the edge colours and have no strong step between neighbours.
  function detectSubject() {
    if (!st.src) return;
    const sel = st.edges;
    if (!sel.top && !sel.left && !sel.right && !sel.bottom) { maskMsg('Pick at least one edge that shows background.'); return; }
    const w = st.mw, h = st.mh, n = w * h;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high'; x.drawImage(st.src, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    let R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { R[i] = d[i * 4]; G[i] = d[i * 4 + 1]; B[i] = d[i * 4 + 2]; }
    for (let k = 0; k < 2; k++) { R = Stipple.blur3(R, w, h); G = Stipple.blur3(G, w, h); B = Stipple.blur3(B, w, h); }

    const seeds = []; // a 3 px band along each chosen edge
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
      if ((sel.top && y < 3) || (sel.bottom && y >= h - 3) || (sel.left && xx < 3) || (sel.right && xx >= w - 3)) seeds.push(y * w + xx);
    }
    // Background colour model: up to 4 clusters from the seed colours (farthest-point start, then k-means).
    const stepS = Math.max(1, Math.ceil(seeds.length / 5000)), sp = [];
    for (let i = 0; i < seeds.length; i += stepS) sp.push(seeds[i]);
    const cr = [R[sp[0]]], cg = [G[sp[0]]], cb = [B[sp[0]]];
    while (cr.length < 4) {
      let best = -1, bd = -1;
      for (const p of sp) {
        let m = Infinity;
        for (let j = 0; j < cr.length; j++) m = Math.min(m, rmean(R[p], G[p], B[p], cr[j], cg[j], cb[j]));
        if (m > bd) { bd = m; best = p; }
      }
      if (bd < 40) break; // the remaining seed colours already sit close to a cluster
      cr.push(R[best]); cg.push(G[best]); cb.push(B[best]);
    }
    const K = cr.length;
    for (let it = 0; it < 8; it++) {
      const sr = new Float64Array(K), sg = new Float64Array(K), sb = new Float64Array(K), sc = new Float64Array(K);
      for (const p of sp) {
        let bj = 0, bd = Infinity;
        for (let j = 0; j < K; j++) { const dd = rmean(R[p], G[p], B[p], cr[j], cg[j], cb[j]); if (dd < bd) { bd = dd; bj = j; } }
        sr[bj] += R[p]; sg[bj] += G[p]; sb[bj] += B[p]; sc[bj]++;
      }
      for (let j = 0; j < K; j++) if (sc[j]) { cr[j] = sr[j] / sc[j]; cg[j] = sg[j] / sc[j]; cb[j] = sb[j] / sc[j]; }
    }
    const cost = new Float32Array(n); // distance to the nearest background colour
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let j = 0; j < K; j++) { const dd = rmean(R[i], G[i], B[i], cr[j], cg[j], cb[j]); if (dd < m) m = dd; }
      cost[i] = m;
    }

    const tol = 30 + 1.5 * num('sens'), stepTol = tol * 0.5;
    const bg = new Uint8Array(n), stack = new Int32Array(n);
    let top = 0;
    const grow = (p, q) => {
      if (!bg[q] && cost[q] < tol && rmean(R[p], G[p], B[p], R[q], G[q], B[q]) < stepTol) { bg[q] = 1; stack[top++] = q; }
    };
    for (const i of seeds) if (!bg[i] && cost[i] < tol) { bg[i] = 1; stack[top++] = i; }
    while (top) {
      const p = stack[--top], px = p % w;
      if (px > 0) grow(p, p - 1);
      if (px < w - 1) grow(p, p + 1);
      if (p >= w) grow(p, p - w);
      if (p < n - w) grow(p, p + w);
    }

    const S = new Float32Array(n);
    for (let i = 0; i < n; i++) S[i] = bg[i] ? 0 : 1;
    // Drop specks: keep subject blobs that cover at least 1.5% of the picture.
    const lab = new Int32Array(n), sizes = [0];
    for (let i = 0; i < n; i++) {
      if (!S[i] || lab[i]) continue;
      const id = sizes.length;
      let cnt = 0, tp = 0;
      stack[tp++] = i; lab[i] = id;
      while (tp) {
        const p = stack[--tp], px = p % w;
        cnt++;
        if (px > 0 && S[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[tp++] = p - 1; }
        if (px < w - 1 && S[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[tp++] = p + 1; }
        if (p >= w && S[p - w] && !lab[p - w]) { lab[p - w] = id; stack[tp++] = p - w; }
        if (p < n - w && S[p + w] && !lab[p + w]) { lab[p + w] = id; stack[tp++] = p + w; }
      }
      sizes.push(cnt);
    }
    let kept = 0;
    for (let i = 0; i < n; i++) if (S[i]) { if (sizes[lab[i]] < n * 0.015) S[i] = 0; else kept++; }
    const frac = kept / n;
    if (frac > 0.97) { maskMsg('Nothing looked like background. Raise Background tolerance, or paint the mask by hand.'); return; }
    if (frac < 0.03) { maskMsg('Almost everything matched the background colour. Lower Background tolerance, or untick an edge the subject touches.'); return; }
    st.maskPrev = st.mask ? st.mask.slice() : 'none';
    st.mask = Stipple.blur3(S, w, h);
    st.maskOn = true;
    maskMsg('Subject found: ' + Math.round(frac * 100) + '% of the picture. Red shows what gets thinned. Fix any mistakes with the brush.');
    updateUndo(); drawOverlay(); solve();
  }

  function stamp(cx, cy, r, target) {
    const w = st.mw, h = st.mh, m = st.mask;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    const hard = r * 0.55;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (dd > r) continue;
      const a = dd <= hard ? 1 : (r - dd) / (r - hard);
      const i = y * w + x;
      m[i] += (target - m[i]) * a;
    }
  }
  function maskPoint(e) {
    const rect = cv.getBoundingClientRect(), g = geom();
    const xmm = ((e.clientX - rect.left) / rect.width) * g.pw, ymm = ((e.clientY - rect.top) / rect.height) * g.ph;
    return [((xmm - g.ox) / (st.W * g.s)) * st.mw, ((ymm - g.oy) / (st.H * g.s)) * st.mh];
  }
  function paintAt(e) {
    const [px, py] = maskPoint(e), target = st.tool === 'keep' ? 1 : 0;
    const r = Math.max(1.5, ((num('bsize') / 100) * st.mw) / 2), step = Math.max(1, r * 0.3);
    if (!st.last) stamp(px, py, r, target);
    else {
      const dx = px - st.last[0], dy = py - st.last[1], k = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
      for (let i = 1; i <= k; i++) stamp(st.last[0] + (dx * i) / k, st.last[1] + (dy * i) / k, r, target);
    }
    st.last = [px, py];
    scheduleOverlay();
  }
  function moveRing(e) {
    const ring = $('ring');
    if (!st.tool) { ring.hidden = true; return; }
    const r = cv.getBoundingClientRect(), g = geom();
    const dcss = (num('bsize') / 100) * ((st.W * g.s) / g.pw) * r.width;
    ring.style.width = ring.style.height = dcss + 'px';
    ring.style.left = e.clientX - r.left + 'px'; ring.style.top = e.clientY - r.top + 'px';
    ring.hidden = false;
  }

  function wireMask() {
    document.querySelectorAll('[data-edge]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.edge;
      st.edges[k] = !st.edges[k]; b.setAttribute('aria-pressed', String(st.edges[k]));
    }));
    $('sens').addEventListener('input', labels);
    $('bsize').addEventListener('input', labels);
    ['bgd', 'soft'].forEach((id) => $(id).addEventListener('input', () => { labels(); if (st.maskOn) scheduleSolve(); }));
    $('maskview').addEventListener('change', drawOverlay);
    $('btnDetect').addEventListener('click', detectSubject);
    $('btnMaskClear').addEventListener('click', () => {
      if (!st.maskOn) return;
      st.maskPrev = st.mask; st.mask = null; st.maskOn = false;
      maskMsg(''); updateUndo(); drawOverlay(); solve();
    });
    $('btnMaskUndo').addEventListener('click', () => {
      const p = st.maskPrev;
      if (!p) return;
      st.maskPrev = null; st.mask = p === 'none' ? null : p; st.maskOn = !!st.mask;
      maskMsg(''); updateUndo(); drawOverlay(); solve();
    });
    document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
      st.tool = st.tool === b.dataset.tool ? null : b.dataset.tool;
      document.querySelectorAll('[data-tool]').forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.tool === st.tool)));
      document.querySelector('.sheet').classList.toggle('brush', !!st.tool);
      if (!st.tool) $('ring').hidden = true;
      drawOverlay();
    }));
    cv.addEventListener('pointerdown', (e) => {
      if (!st.tool || !st.src || e.button > 0) return;
      st.maskPrev = st.mask ? st.mask.slice() : 'none';
      if (!st.mask) st.mask = new Float32Array(st.mw * st.mh).fill(st.tool === 'keep' ? 0 : 1); // first "keep" stroke starts from nothing, first "remove" from everything
      st.maskOn = true; st.painting = true; st.last = null;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      e.preventDefault();
      maskMsg('');
      paintAt(e);
    });
    cv.addEventListener('pointermove', (e) => { moveRing(e); if (st.painting) paintAt(e); });
    const endStroke = () => {
      if (!st.painting) return;
      st.painting = false; st.last = null;
      updateUndo(); scheduleSolve();
    };
    cv.addEventListener('pointerup', endStroke);
    cv.addEventListener('pointercancel', endStroke);
    cv.addEventListener('pointerleave', () => { $('ring').hidden = true; });
  }

  /* ---------- wiring ---------- */
  function syncPresets() {
    const ink = $('inkc').value.toLowerCase(), paper = $('paperc').value.toLowerCase(), inv = $('invert').checked;
    let hit = -1;
    document.querySelectorAll('.preset').forEach((b, i) => {
      const p = PRESETS[i];
      const on = p.ink.toLowerCase() === ink && p.paper.toLowerCase() === paper && p.invert === inv;
      if (on) hit = i;
      b.setAttribute('aria-pressed', String(on));
    });
    $('presetName').textContent = hit >= 0 ? PRESETS[hit].name : 'Custom colours';
  }

  function init() {
    labels();
    getWorker(); // start parsing the solver early
    PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'preset'; b.title = p.name; b.setAttribute('aria-label', p.name);
      b.style.background = p.paper;
      const i = document.createElement('i'); i.style.background = p.ink; b.appendChild(i);
      b.addEventListener('click', () => {
        const flip = $('invert').checked !== p.invert;
        $('inkc').value = p.ink; $('paperc').value = p.paper; $('invert').checked = p.invert;
        syncPresets();
        if (flip) solve(); else redraw();
      });
      $('presets').appendChild(b);
    });

    ['count', 'bright', 'contrast', 'detail', 'edge', 'auto', 'invert', 'passes'].forEach((id) => {
      $(id).addEventListener('input', () => { labels(); syncPresets(); scheduleSolve(); });
    });
    ['dia', 'var', 'jit', 'paper', 'orient', 'margin', 'inkc', 'paperc'].forEach((id) => {
      $(id).addEventListener('input', () => { labels(); syncPresets(); scheduleRedraw(); });
    });
    $('btnShuffle').addEventListener('click', () => { st.seed = (Math.random() * 1e9) | 0; solve(); });
    $('btnSample').addEventListener('click', useSample);
    $('btnPng').addEventListener('click', exportPng);
    $('btnSvg').addEventListener('click', exportSvg);
    $('btnCompare').addEventListener('click', () => {
      st.compare = !st.compare;
      $('btnCompare').setAttribute('aria-pressed', String(st.compare));
      $('btnCompare').textContent = st.compare ? 'Showing original' : 'Compare original';
      redraw();
    });

    wireMask();
    $('file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
    const drop = $('drop');
    document.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
    document.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('over');
      if (e.dataTransfer && e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    });
    document.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) if (it.type.indexOf('image/') === 0) { loadFile(it.getAsFile()); break; }
    });

    document.querySelectorAll('.zoom button').forEach((b) => {
      b.addEventListener('click', () => {
        st.zoom = parseFloat(b.dataset.zoom);
        document.querySelectorAll('.zoom button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
        redraw();
        const s = $('stage');
        s.scrollLeft = (s.scrollWidth - s.clientWidth) / 2; s.scrollTop = (s.scrollHeight - s.clientHeight) / 2;
      });
    });
    let raf = 0;
    new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(redraw); }).observe($('stage'));

    // Inside claude.ai the host's download capability is used; anywhere else, plain anchor downloads.
    if (window.claude && window.claude.use) {
      window.claude.use('downloads').then((d) => { dl = d || null; }).catch(() => { dl = null; });
    }
    // Phones and low-memory devices: cap the dot count (150,000) so the tab does not run out of memory.
    const weak = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || (navigator.deviceMemory && navigator.deviceMemory <= 4) || window.innerWidth < 700;
    if (weak) {
      $('count').max = '82'; // 500 * 1000^0.82 ~ 150,000
      if (num('count') > 82) $('count').value = '77';
      const h = $('count').parentNode.querySelector('.hint');
      if (h) h.textContent = 'Capped at 150,000 on this device to keep the browser from running out of memory. Use a desktop for up to 500,000.';
    }
    syncPresets();
    useSample();
    setTimeout(initMark, 0);
  }
  init();
})();

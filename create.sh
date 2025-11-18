#!/usr/bin/env bash
set -euo pipefail

# 1) Init project + deps
npm init -y >/dev/null
npm i flag-icons jsdom fast-xml-parser color express glob --silent

# 2) Project structure
mkdir -p tools output public

# 3) Extractor: builds per-color SVG layers + manifest.json
cat > tools/extract-flag-layers.js <<'EOF'
#!/usr/bin/env node
/**
 * Extract per-color layers from all flag SVGs in flag-icons.
 * Output:
 *   output/<cc>/*.svg        (layers per color)
 *   output/manifest.json     ({cc: {colors:[hex...], files:[filename...]}})
 *
 * Notes:
 * - Handles fill and stroke; ignores 'none' and fully transparent.
 * - Normalizes color values to 6-char lowercase hex (#rrggbb).
 * - Preserves <defs>, viewBox, width/height, and clipping paths.
 * - For robustness, elements not matching current layer color have fill/stroke set to 'none'
 *   instead of being removed (avoids breaking clipPaths/masks).
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { XMLParser } = require('fast-xml-parser');
const Color = require('color');
const glob = require('glob');

const FLAGS_DIR = path.join(process.cwd(), 'node_modules', 'flag-icons', 'flags', '4x3');
const OUT_DIR = path.join(process.cwd(), 'output');

if (!fs.existsSync(FLAGS_DIR)) {
  console.error('Could not find flag-icons SVGs. Did npm install succeed?');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true });

function toHex(c) {
  try {
    if (!c) return null;
    const s = String(c).trim().toLowerCase();
    if (s === 'none' || s === 'transparent') return null;
    // Handle hex, rgb/rgba, hsl/hsla, named colors
    const hex = Color(s).hex().toLowerCase();
    // Normalize to #rrggbb
    const six = Color(hex).hex().toLowerCase();
    return six;
  } catch {
    // Some odd values like 'url(#id)' for paint servers; ignore those for color buckets
    return null;
  }
}

function walkElements(svgDoc) {
  const list = [];
  const treeWalker = svgDoc.createTreeWalker(svgDoc, 1 /* ELEMENT_NODE */);
  let node = treeWalker.currentNode;
  while (node) {
    list.push(node);
    node = treeWalker.nextNode();
  }
  return list;
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function getViewBox(svgEl) {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) return vb;
  // fallback: derive from width/height if present
  const w = svgEl.getAttribute('width');
  const h = svgEl.getAttribute('height');
  if (w && h) return `0 0 ${w} ${h}`;
  // default for flag-icons 4x3 assets tends to be viewBox present already
  return '0 0 640 480';
}

function collectColors(svgDoc) {
  const els = walkElements(svgDoc);
  const colors = [];
  for (const el of els) {
    if (!(el instanceof svgDoc.defaultView.Element)) continue;
    const f = el.getAttribute && el.getAttribute('fill');
    const s = el.getAttribute && el.getAttribute('stroke');
    const fh = toHex(f);
    const sh = toHex(s);
    if (fh) colors.push(fh);
    if (sh) colors.push(sh);
    // Some flags embed style attributes; try to parse inline style too
    const style = el.getAttribute && el.getAttribute('style');
    if (style) {
      const parts = style.split(';');
      for (const p of parts) {
        const [k, v] = p.split(':').map(x => x && x.trim().toLowerCase());
        if (!k || !v) continue;
        if (k === 'fill') {
          const hh = toHex(v);
          if (hh) colors.push(hh);
        }
        if (k === 'stroke') {
          const hh = toHex(v);
          if (hh) colors.push(hh);
        }
      }
    }
  }
  return unique(colors);
}

function writeLayer(svgSrc, cc, colorHex, index) {
  const dom = new JSDOM(svgSrc, { contentType: 'image/svg+xml' });
  const doc = dom.window.document;
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return null;

  // Ensure viewBox exists
  if (!svgEl.getAttribute('viewBox')) {
    svgEl.setAttribute('viewBox', getViewBox(svgEl));
  }
  // Remove width/height so layers scale naturally
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');

  // For each element: if its fill/stroke matches colorHex, keep; otherwise set to 'none'.
  const els = walkElements(doc);
  for (const el of els) {
    if (!(el instanceof dom.window.Element)) continue;
    if (el.tagName.toLowerCase() === 'svg' || el.tagName.toLowerCase() === 'defs') continue;

    const style = el.getAttribute('style') || '';
    // Extract any inline style fill/stroke
    const styleMap = {};
    for (const part of style.split(';')) {
      const [k, v] = part.split(':').map(x => x && x.trim().toLowerCase());
      if (k && v) styleMap[k] = v;
    }

    const rawFill = styleMap['fill'] ?? el.getAttribute('fill');
    const rawStroke = styleMap['stroke'] ?? el.getAttribute('stroke');

    const fh = toHex(rawFill);
    const sh = toHex(rawStroke);

    const matches =
      (fh && fh === colorHex) ||
      (sh && sh === colorHex);

    if (!matches) {
      // Turn off paint for non-matching elements.
      // Important: do NOT remove elements; they may be referenced by clipPath/masks.
      if (rawFill !== null) el.setAttribute('fill', 'none');
      if (rawStroke !== null) el.setAttribute('stroke', 'none');

      // Also scrub inline style paints
      if ('fill' in styleMap || 'stroke' in styleMap) {
        const newStyle = Object.entries(styleMap)
          .map(([k, v]) => {
            if (k === 'fill') return 'fill:none';
            if (k === 'stroke') return 'stroke:none';
            return `${k}:${v}`;
          })
          .join(';');
        if (newStyle) el.setAttribute('style', newStyle);
      }
    } else {
      // Normalize to the layer color to be safe/consistent
      if (fh) el.setAttribute('fill', colorHex);
      if (sh) el.setAttribute('stroke', colorHex);
    }
  }

  const outSvg = svgEl.outerHTML;
  const fname = `${cc}__${String(index).padStart(2, '0')}_${colorHex.replace('#', '')}.svg`;
  const dir = path.join('output', cc);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fname), outSvg, 'utf8');
  return fname;
}

function main() {
  const files = glob.sync(path.join(FLAGS_DIR, '*.svg')).sort();
  const manifest = {};
  console.log(`Processing ${files.length} flags from ${FLAGS_DIR}`);

  for (const file of files) {
    const cc = path.basename(file, '.svg'); // e.g., us, fr, de
    const svgSrc = fs.readFileSync(file, 'utf8');
    const dom = new JSDOM(svgSrc, { contentType: 'image/svg+xml' });
    const doc = dom.window.document;
    const svgEl = doc.querySelector('svg');
    if (!svgEl) continue;

    const colors = collectColors(doc);
    if (colors.length === 0) {
      // Edge case: no explicit colors; still copy as single layer
      const dir = path.join('output', cc);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${cc}__00_full.svg`), svgSrc, 'utf8');
      manifest[cc] = { colors: [], files: [`${cc}__00_full.svg`] };
      continue;
    }

    // Optional: put white/black last so the more distinctive colors show earlier.
    const order = colors.slice().sort((a, b) => {
      const rank = (hex) => {
        if (hex === '#ffffff') return 99;
        if (hex === '#000000') return 98;
        return 0;
      };
      return rank(a) - rank(b) || a.localeCompare(b);
    });

    const filesOut = [];
    order.forEach((hex, idx) => {
      const fname = writeLayer(svgSrc, cc, hex, idx);
      if (fname) filesOut.push(fname);
    });

    manifest[cc] = { colors: order, files: filesOut };
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Done. Wrote output/manifest.json');
}

main();
EOF
chmod +x tools/extract-flag-layers.js

# 4) Tiny server to host a guessing game over generated layers
cat > server.js <<'EOF'
#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const OUT_DIR = path.join(process.cwd(), 'output');
const PUB_DIR = path.join(process.cwd(), 'public');

app.use('/output', express.static(OUT_DIR, { fallthrough: false }));
app.use('/', express.static(PUB_DIR, { fallthrough: false }));

app.get('/api/manifest', (req, res) => {
  const mf = path.join(OUT_DIR, 'manifest.json');
  if (!fs.existsSync(mf)) return res.json({});
  const data = JSON.parse(fs.readFileSync(mf, 'utf8'));
  res.json(data);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Flag Layers Game running at http://localhost:${port}`);
});
EOF
chmod +x server.js

# 5) Minimal client to reveal layers one by one
cat > public/index.html <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Guess the Flag — Layer Reveal</title>
  <style>
    :root { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif }
    body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0b0d12; color: #e8eaed }
    .card { width: min(92vw, 820px); background: #11151c; border: 1px solid #2a2f3a; border-radius: 20px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,.35) }
    h1 { margin: 0 0 10px; font-size: 22px; font-weight: 600 }
    .flag-stage { position: relative; width: 640px; max-width: 100%; aspect-ratio: 4/3; margin: 16px auto; background: #0e1218; border-radius: 14px; overflow: hidden; border: 1px solid #2a2f3a }
    .layer { position: absolute; inset: 0; display: none }
    .layer.visible { display: block }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: space-between }
    button { background: #2b64ff; color: white; border: none; border-radius: 10px; padding: 10px 14px; font-weight: 600; cursor: pointer }
    button:disabled{ opacity: .55; cursor: not-allowed }
    .pill { padding: 6px 10px; border: 1px solid #2a2f3a; border-radius: 999px; font-size: 12px; opacity: .85 }
    .answer { font-size: 18px; font-weight: 600; letter-spacing: .3px }
    .tiny { font-size: 12px; opacity: .75 }
    .colors { display: flex; gap: 6px; align-items: center; margin-top: 8px }
    .swatch { width: 16px; height: 16px; border-radius: 4px; border: 1px solid #0006 }
    .controls { display: flex; gap: 8px; flex-wrap: wrap }
  </style>
</head>
<body>
  <div class="card">
    <h1>Guess the Flag — Layer Reveal</h1>
    <div class="row">
      <div class="pill" id="progress">– / –</div>
      <div class="colors" id="colors"></div>
    </div>
    <div class="flag-stage" id="stage"></div>
    <div class="row">
      <div class="controls">
        <button id="reveal">Reveal Next Layer</button>
        <button id="guess">Show Answer</button>
        <button id="skip">Skip Flag</button>
        <button id="reset">Restart Layers</button>
      </div>
      <div class="answer" id="answer"> </div>
    </div>
    <div class="tiny" style="margin-top:10px;">Tip: distinctive colors tend to appear first; white/black are shown last.</div>
  </div>

  <script>
    const stage = document.getElementById('stage');
    const answer = document.getElementById('answer');
    const progress = document.getElementById('progress');
    const colorsBox = document.getElementById('colors');
    const btnReveal = document.getElementById('reveal');
    const btnGuess  = document.getElementById('guess');
    const btnSkip   = document.getElementById('skip');
    const btnReset  = document.getElementById('reset');

    let manifest = {};
    let order = [];
    let idx = -1;
    let current = null;
    let visibleCount = 0;

    function isoToName(cc) {
      // Lightweight name mapping using Intl (fallback to code)
      try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc.toUpperCase()) || cc.toUpperCase();
      } catch {
        return cc.toUpperCase();
      }
    }

    function clearStage() {
      stage.innerHTML = '';
      colorsBox.innerHTML = '';
      visibleCount = 0;
      answer.textContent = ' ';
      progress.textContent = '– / –';
    }

    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i+1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    function loadFlag(cc) {
      clearStage();
      current = { cc, ...manifest[cc] };
      // Create img overlays for each layer file
      current.files.forEach((file, i) => {
        const img = document.createElement('img');
        img.className = 'layer';
        img.decoding = 'async';
        img.loading = 'eager';
        img.src = `/output/${cc}/${file}`;
        stage.appendChild(img);
      });

      // Color swatches (hidden order)
      current.colors.forEach(hex => {
        const sw = document.createElement('div');
        sw.className = 'swatch';
        sw.style.background = hex;
        colorsBox.appendChild(sw);
      });

      progress.textContent = `0 / ${current.files.length}`;
      btnReveal.disabled = false;
      btnReset.disabled = false;
      btnGuess.disabled = false;
    }

    function revealLayer() {
      const layers = stage.querySelectorAll('.layer');
      if (visibleCount >= layers.length) {
        btnReveal.disabled = true;
        return;
      }
      layers[visibleCount].classList.add('visible');
      visibleCount++;
      progress.textContent = `${visibleCount} / ${layers.length}`;
      if (visibleCount === layers.length) btnReveal.disabled = true;
    }

    function showAnswer() {
      if (!current) return;
      answer.textContent = isoToName(current.cc);
    }

    function restartLayers() {
      if (!current) return;
      const layers = stage.querySelectorAll('.layer');
      layers.forEach(l => l.classList.remove('visible'));
      visibleCount = 0;
      progress.textContent = `0 / ${layers.length}`;
      answer.textContent = ' ';
      btnReveal.disabled = false;
    }

    function nextFlag() {
      idx = (idx + 1) % order.length;
      const cc = order[idx];
      loadFlag(cc);
    }

    async function boot() {
      const res = await fetch('/api/manifest');
      manifest = await res.json();

      // Filter out flags with no files (unlikely) & build randomized order
      order = Object.keys(manifest).filter(cc => (manifest[cc].files || []).length > 0);
      shuffle(order);

      idx = -1;
      nextFlag();

      btnReveal.addEventListener('click', revealLayer);
      btnGuess.addEventListener('click', showAnswer);
      btnSkip.addEventListener('click', () => nextFlag());
      btnReset.addEventListener('click', restartLayers);
    }

    boot();
  </script>
</body>
</html>
EOF

# 6) Run the extractor, then start the server
node tools/extract-flag-layers.js
node server.js

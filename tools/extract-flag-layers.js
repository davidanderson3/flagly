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
const ColorModule = require('color');
const Color = ColorModule.default || ColorModule;
const glob = require('glob');

function brightnessScore(hex) {
  if (!hex) return 0;
  if (hex.toLowerCase() === '#ffffff') return -1;
  try {
    return Color(hex).luminosity();
  } catch {
    return 0;
  }
}
const countriesList = require('world-countries');

const SVG_NS = 'http://www.w3.org/2000/svg';
const TARGET_LAYERS = 6;
const SPLIT_ENTRY_THRESHOLD = 10;

const FLAGS_DIR = path.join(process.cwd(), 'node_modules', 'flag-icons', 'flags', '4x3');
const OUT_DIR = path.join(process.cwd(), 'output');

const locationByIso = new Map();
countriesList.forEach((country) => {
  const iso = country.cca2 && typeof country.cca2 === 'string' ? country.cca2.toLowerCase() : null;
  const latlng = Array.isArray(country.latlng) && country.latlng.length >= 2 ? country.latlng : null;
  if (!iso || !latlng) return;
  const [lat, lon] = latlng;
  if (typeof lat !== 'number' || typeof lon !== 'number') return;
  locationByIso.set(iso, { lat, lon });
});

const SKIP_CODES = new Set(['cp', 'xx', 'um']);

const MANUAL_LOCATIONS = new Map([
  ['arab', { lat: 25, lon: 45 }],
  ['asean', { lat: 12.5, lon: 103 }],
  ['cefta', { lat: 45.5, lon: 17 }],
  ['dg', { lat: -7.3, lon: 72.4 }],
  ['eac', { lat: 1, lon: 37 }],
  ['es-ct', { lat: 41.9, lon: 2.2 }],
  ['es-ga', { lat: 42.6, lon: -8 }],
  ['es-pv', { lat: 43, lon: -2.5 }],
  ['eu', { lat: 50, lon: 10 }],
  ['gb-eng', { lat: 52, lon: -1.5 }],
  ['gb-nir', { lat: 54.5, lon: -6 }],
  ['gb-sct', { lat: 56.5, lon: -4 }],
  ['gb-wls', { lat: 52.1, lon: -3.5 }],
  ['ic', { lat: 28.1, lon: -15.4 }],
  ['pc', { lat: -25, lon: -130.1 }],
  ['sh-ac', { lat: -7.9, lon: -14.3 }],
  ['sh-hl', { lat: -15.9, lon: -5.7 }],
  ['sh-ta', { lat: -37.1, lon: -12.3 }],
  ['un', { lat: 40.75, lon: -73.97 }],
]);

if (!fs.existsSync(FLAGS_DIR)) {
  console.error('Could not find flag-icons SVGs. Did npm install succeed?');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

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

function orderColorsForReveal(colors) {
  const primaries = [];
  const tail = [];
  colors.forEach((hex) => {
    if (!hex) return;
    const trimmed = hex.toLowerCase();
    if (trimmed === '#ffffff' || trimmed === '#fff' || trimmed === '#000000' || trimmed === '#000') {
      tail.push(trimmed);
    } else {
      primaries.push(trimmed);
    }
  });
  return [...primaries, ...tail];
}

function walkElements(svgDoc) {
  // Collect every element within the SVG document (including the root <svg>).
  return Array.from(svgDoc.querySelectorAll('*'));
}

function parseStyle(styleText) {
  const map = {};
  if (!styleText) return map;
  for (const part of styleText.split(';')) {
    const [rawK, rawV] = part.split(':');
    if (!rawK || !rawV) continue;
    const k = rawK.trim().toLowerCase();
    const v = rawV.trim();
    if (!k || !v) continue;
    map[k] = v;
  }
  return map;
}

function serializeStyle(map) {
  return Object.entries(map)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
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

function parseViewBox(vb) {
  if (!vb) return { minX: 0, minY: 0, width: 640, height: 480 };
  const parts = vb.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return { minX: 0, minY: 0, width: 640, height: 480 };
  }
  const [minX, minY, width, height] = parts;
  return { minX, minY, width, height };
}

function ensureDefs(doc, svgEl) {
  let defs = svgEl.querySelector('defs');
  if (!defs) {
    defs = doc.createElementNS(SVG_NS, 'defs');
    svgEl.insertBefore(defs, svgEl.firstChild);
  }
  return defs;
}

function collectColorMeta(svgDoc) {
  const els = walkElements(svgDoc);
  const meta = new Map(); // colorHex -> Map<elementIndex, entry>

  els.forEach((el, idx) => {
    if (!(el instanceof svgDoc.defaultView.Element)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'svg') return;

    const styleMap = parseStyle(el.getAttribute && el.getAttribute('style'));
    const fillSource = styleMap.hasOwnProperty('fill') ? 'style' : (el.hasAttribute && el.hasAttribute('fill') ? 'attr' : null);
    const strokeSource = styleMap.hasOwnProperty('stroke') ? 'style' : (el.hasAttribute && el.hasAttribute('stroke') ? 'attr' : null);

    const fillHex = toHex(
      fillSource === 'style'
        ? styleMap.fill
        : el.getAttribute && el.getAttribute('fill')
    );
    const strokeHex = toHex(
      strokeSource === 'style'
        ? styleMap.stroke
        : el.getAttribute && el.getAttribute('stroke')
    );

    const inDefs = Boolean(el.closest && el.closest('defs'));
    const addEntry = (colorHex, opts) => {
      if (!colorHex) return;
      if (!meta.has(colorHex)) meta.set(colorHex, new Map());
      const byElement = meta.get(colorHex);
      if (!byElement.has(idx)) {
        byElement.set(idx, {
          index: idx,
          keepFill: false,
          keepStroke: false,
          fillSource: null,
          strokeSource: null,
          inDefs,
        });
      }
      const entry = byElement.get(idx);
      if (opts.keepFill) {
        entry.keepFill = true;
        entry.fillSource = opts.fillSource ?? entry.fillSource;
      }
      if (opts.keepStroke) {
        entry.keepStroke = true;
        entry.strokeSource = opts.strokeSource ?? entry.strokeSource;
      }
    };

    if (fillHex && strokeHex && fillHex === strokeHex) {
      addEntry(fillHex, {
        keepFill: true,
        keepStroke: true,
        fillSource,
        strokeSource,
      });
    } else {
      if (fillHex) {
        addEntry(fillHex, {
          keepFill: true,
          fillSource,
        });
      }
      if (strokeHex) {
        addEntry(strokeHex, {
          keepStroke: true,
          strokeSource,
        });
      }
    }
  });

  return meta;
}

function splitIntoPieces(plan, pieceCount) {
  if (!plan || pieceCount <= 1) return null;
  const baseClip =
    plan.clip && plan.clip.type === 'rect'
      ? plan.clip
      : { type: 'rect', x0: 0, x1: 1, y0: 0, y1: 1 };
  const generation = plan.splitGeneration ?? 0;
  const orientation = generation % 2 === 0 ? 'vertical' : 'horizontal';
  const pieces = [];
  for (let i = 0; i < pieceCount; i++) {
    const nextClip = { type: 'rect', orientation };
    if (orientation === 'vertical') {
      const span = Math.max(baseClip.x1 - baseClip.x0, 0);
      nextClip.x0 = baseClip.x0 + span * (i / pieceCount);
      nextClip.x1 = baseClip.x0 + span * ((i + 1) / pieceCount);
      nextClip.y0 = baseClip.y0;
      nextClip.y1 = baseClip.y1;
    } else {
      const span = Math.max(baseClip.y1 - baseClip.y0, 0);
      nextClip.y0 = baseClip.y0 + span * (i / pieceCount);
      nextClip.y1 = baseClip.y0 + span * ((i + 1) / pieceCount);
      nextClip.x0 = baseClip.x0;
      nextClip.x1 = baseClip.x1;
    }

    pieces.push({
      color: plan.color,
      entries: plan.entries,
      clip: nextClip,
      zBase: plan.zBase,
      splitOffset: (plan.splitOffset ?? 0) * 10 + i,
      splitGeneration: generation + 1,
      forceTop: plan.forceTop,
      brightness: plan.brightness,
    });
  }
  return pieces;
}

function expandLargePlans(plans) {
  const expanded = [];
  plans.forEach((plan) => {
    if (!plan || !plan.entries || plan.entries.length < SPLIT_ENTRY_THRESHOLD) {
      expanded.push(plan);
      return;
    }
    const pieceCount = Math.min(3, Math.ceil(plan.entries.length / SPLIT_ENTRY_THRESHOLD));
    const pieces = splitIntoPieces(plan, pieceCount);
    if (pieces && pieces.length > 1) {
      expanded.push(...pieces);
      return;
    }
    expanded.push(plan);
  });
  return expanded;
}

function selectFinalPlans(plans, target, orderedColors) {
  if (plans.length <= target) return plans.slice();

  const byColor = new Map();
  plans.forEach((plan) => {
    if (!byColor.has(plan.color)) byColor.set(plan.color, []);
    byColor.get(plan.color).push(plan);
  });

  const included = new Set();
  const finalPlans = [];
  const pointers = new Map();
  const colors = [...orderedColors, ...Array.from(byColor.keys()).filter((c) => !orderedColors.includes(c))];

  for (const group of byColor.values()) {
    group.sort((a, b) => {
      const aEntries = Array.isArray(a.entries) ? a.entries.length : 0;
      const bEntries = Array.isArray(b.entries) ? b.entries.length : 0;
      if (bEntries !== aEntries) return bEntries - aEntries;
      return (a.splitOffset ?? 0) - (b.splitOffset ?? 0);
    });
  }

  for (const color of colors) {
    const group = byColor.get(color) || [];
    if (!group.length) continue;
    finalPlans.push(group[0]);
    included.add(group[0]);
    pointers.set(color, 1);
    if (finalPlans.length >= target) return finalPlans.slice(0, target);
  }

  let madeProgress = true;
  while (finalPlans.length < target && madeProgress) {
    madeProgress = false;
    for (const color of colors) {
      const group = byColor.get(color) || [];
      const idx = pointers.get(color) || 0;
      if (idx >= group.length) continue;
      const plan = group[idx];
      if (included.has(plan)) {
        pointers.set(color, idx + 1);
        continue;
      }
      finalPlans.push(plan);
      included.add(plan);
      pointers.set(color, idx + 1);
      madeProgress = true;
      if (finalPlans.length >= target) return finalPlans.slice(0, target);
    }
  }

  for (const plan of plans) {
    if (finalPlans.length >= target) break;
    if (included.has(plan)) continue;
    finalPlans.push(plan);
    included.add(plan);
  }

  return finalPlans.slice(0, target);
}

function writeLayer(svgSrc, cc, colorHex, index, layerEntries, clip) {
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

  const vb = parseViewBox(svgEl.getAttribute('viewBox'));

  // For each element: if its fill/stroke matches colorHex, keep; otherwise set to 'none'.
  const els = walkElements(doc);
  const targetMap = new Map();
  for (const entry of layerEntries) {
    targetMap.set(entry.index, entry);
  }

  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (!(el instanceof dom.window.Element)) continue;
    if (el.tagName.toLowerCase() === 'svg' || el.tagName.toLowerCase() === 'defs') continue;

    const styleMapRaw = parseStyle(el.getAttribute('style'));
    const styleMap = { ...styleMapRaw };
    const target = targetMap.get(i);
    const isTarget = Boolean(target);

    if (isTarget) {
      // Fill
      if (target.keepFill) {
        if (target.fillSource === 'style') {
          styleMap.fill = colorHex;
          el.setAttribute('fill', 'none');
        } else {
          el.setAttribute('fill', colorHex);
          if (styleMap.hasOwnProperty('fill')) styleMap.fill = 'none';
        }
      } else {
        el.setAttribute('fill', 'none');
        if (styleMap.hasOwnProperty('fill')) styleMap.fill = 'none';
      }

      // Stroke
      if (target.keepStroke) {
        if (target.strokeSource === 'style') {
          styleMap.stroke = colorHex;
          el.setAttribute('stroke', 'none');
        } else {
          el.setAttribute('stroke', colorHex);
          if (styleMap.hasOwnProperty('stroke')) styleMap.stroke = 'none';
        }
      } else {
        el.setAttribute('stroke', 'none');
        if (styleMap.hasOwnProperty('stroke')) styleMap.stroke = 'none';
      }
    } else {
      // Hide non-target elements entirely.
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', 'none');
      if (styleMap.hasOwnProperty('fill')) styleMap.fill = 'none';
      if (styleMap.hasOwnProperty('stroke')) styleMap.stroke = 'none';
    }

    if (Object.keys(styleMap).length > 0) {
      const styleString = serializeStyle(styleMap);
      if (styleString) {
        el.setAttribute('style', styleString);
      } else {
        el.removeAttribute('style');
      }
    } else if (el.hasAttribute('style')) {
      el.removeAttribute('style');
    }
  }

  if (clip) {
    const defs = ensureDefs(doc, svgEl);
    const clipId = `clip-${cc}-${String(index).padStart(2, '0')}`;
    const clipPath = doc.createElementNS(SVG_NS, 'clipPath');
    clipPath.setAttribute('id', clipId);
    clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse');

    if (clip.type === 'rect') {
      const rect = doc.createElementNS(SVG_NS, 'rect');
      const width = Math.max(vb.width * (clip.x1 - clip.x0), 0);
      const height = Math.max(vb.height * (clip.y1 - clip.y0), 0);
      rect.setAttribute('x', vb.minX + vb.width * clip.x0);
      rect.setAttribute('y', vb.minY + vb.height * clip.y0);
      rect.setAttribute('width', width);
      rect.setAttribute('height', height);
      clipPath.appendChild(rect);
    }

    defs.appendChild(clipPath);

    const group = doc.createElementNS(SVG_NS, 'g');
    group.setAttribute('clip-path', `url(#${clipId})`);
    const toMove = [];
    svgEl.childNodes.forEach((node) => {
      if (node.nodeType === 1 && node.tagName && node.tagName.toLowerCase() === 'defs') return;
      toMove.push(node);
    });
    toMove.forEach((node) => group.appendChild(node));
    svgEl.appendChild(group);
  }

  const outSvg = svgEl.outerHTML;
  const fname = `${cc}__${String(index).padStart(2, '0')}_${colorHex.replace('#', '')}.svg`;
  const dir = path.join(OUT_DIR, cc);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fname), outSvg, 'utf8');
  dom.window.close();
  return fname;
}

function main() {
  const files = glob.sync(path.join(FLAGS_DIR, '*.svg')).sort();
  const manifest = {};
  console.log(`Processing ${files.length} flags from ${FLAGS_DIR}`);

  for (const file of files) {
    const cc = path.basename(file, '.svg'); // e.g., us, fr, de
    if (SKIP_CODES.has(cc)) {
      const staleDir = path.join(OUT_DIR, cc);
      if (fs.existsSync(staleDir)) {
        fs.rmSync(staleDir, { recursive: true, force: true });
      }
      continue;
    }
    const svgSrc = fs.readFileSync(file, 'utf8');
    const manualLocation = MANUAL_LOCATIONS.get(cc);
    const resolvedLocation = locationByIso.get(cc) || manualLocation || null;
    const dom = new JSDOM(svgSrc, { contentType: 'image/svg+xml' });
    const doc = dom.window.document;
    const svgEl = doc.querySelector('svg');
    if (!svgEl) continue;

    const colorMeta = collectColorMeta(doc);
    const colors = Array.from(colorMeta.keys());

    // Clear existing directory for this flag to avoid stale layers.
    const flagOutDir = path.join(OUT_DIR, cc);
    if (fs.existsSync(flagOutDir)) {
      fs.rmSync(flagOutDir, { recursive: true, force: true });
    }
    fs.mkdirSync(flagOutDir, { recursive: true });
    const fullFileName = `${cc}__full.svg`;
    fs.writeFileSync(path.join(flagOutDir, fullFileName), svgSrc, 'utf8');

    if (colors.length === 0) {
      // Edge case: no explicit colors; still copy as single layer
      manifest[cc] = {
        colors: [],
        files: [fullFileName],
        z: [],
        full: fullFileName,
        location: resolvedLocation,
      };
      continue;
    }

    // Optional: put white/black last so the more distinctive colors show earlier.
    const colorReveal = orderColorsForReveal(colors);

    const layerPlans = [];

    colorReveal.forEach((hex) => {
      const entriesMap = colorMeta.get(hex);
      if (!entriesMap) return;
      const entries = Array.from(entriesMap.values()).sort((a, b) => a.index - b.index);
      if (entries.length === 0) return;

      const hexBrightness = brightnessScore(hex);

      const groups = [];
      let currentGroup = [entries[0]];
      for (let i = 1; i < entries.length; i++) {
        const prev = currentGroup[currentGroup.length - 1];
        const next = entries[i];
        if (next.index - prev.index <= 1) {
          currentGroup.push(next);
        } else {
          groups.push(currentGroup);
          currentGroup = [next];
        }
      }
      if (currentGroup.length) groups.push(currentGroup);

      groups.forEach((group) => {
        const maxIndex = group.reduce((acc, item) => Math.max(acc, item.index), group[0].index);
        const anyFill = group.some(item => item.keepFill);
        const anyStroke = group.some(item => item.keepStroke);
        const anyFillAndStroke = group.some(item => item.keepFill && item.keepStroke);
        let offset = 0;
        if (anyFillAndStroke) offset = 2;
        else if (anyStroke && !anyFill) offset = 1;
        const usesDefs = group.some(entry => entry.inDefs);
        layerPlans.push({
          color: hex,
          entries: group,
          clip: null,
          zBase: maxIndex * 10 + offset,
          splitOffset: 0,
          splitGeneration: 0,
          forceTop: usesDefs,
          brightness: hexBrightness,
        });
      });
    });

    let processedPlans = expandLargePlans(layerPlans);

    if (processedPlans.length > 0 && processedPlans.length < TARGET_LAYERS) {
      const targetLayers = TARGET_LAYERS;
      let cursor = 0;
      let guard = 0;

      while (processedPlans.length < targetLayers && processedPlans.length > 0 && guard < 60) {
        const index = cursor % processedPlans.length;
        const plan = processedPlans[index];
        const remaining = targetLayers - layerPlans.length;
        const pieceCount = Math.min(remaining + 1, 3);
        if (pieceCount <= 1) {
          cursor++;
          guard++;
          continue;
        }
        const pieces = splitIntoPieces(plan, pieceCount);
        if (pieces && pieces.length > 1) {
          processedPlans.splice(index, 1, ...pieces);
        }
        cursor++;
        guard++;
      }
    }

    layerPlans.splice(0, layerPlans.length, ...processedPlans);

    if (layerPlans.length > TARGET_LAYERS) {
      const selected = selectFinalPlans(layerPlans, TARGET_LAYERS, colorReveal);
      layerPlans.splice(0, layerPlans.length, ...selected);
    }

    // Order the plans by their rendering depth so stacking matches the flattened flag.
    layerPlans.sort((a, b) => {
      const brightnessDiff = (b.brightness ?? 0) - (a.brightness ?? 0);
      if (brightnessDiff !== 0) return brightnessDiff;
      const DETAIL_BOOST = 1_000_000;
      const depth = (plan) => {
        const base = plan.zBase ?? 0;
        const offset = plan.splitOffset ?? 0;
        return base * 1000 + offset + (plan.forceTop ? DETAIL_BOOST : 0);
      };
      return depth(a) - depth(b);
    });

    const filesOut = [];
    const colorsOut = [];
    const zStack = [];
    const baseUsage = new Map();
    let layerSeq = 0;

    layerPlans.forEach((plan) => {
      const fname = writeLayer(svgSrc, cc, plan.color, layerSeq, plan.entries, plan.clip);
      if (!fname) return;
      filesOut.push(fname);
      colorsOut.push(plan.color);
      const base = plan.zBase;
      const offset = baseUsage.get(base) || 0;
      baseUsage.set(base, offset + 1);
      zStack.push(base + offset);
      layerSeq++;
    });

    manifest[cc] = {
      colors: colorsOut,
      files: filesOut,
      z: zStack,
      full: fullFileName,
      location: resolvedLocation,
    };
    dom.window.close();
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Done. Wrote output/manifest.json');
}

main();

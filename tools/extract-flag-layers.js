#!/usr/bin/env node
/**
 * Region-based extractor:
 * - Render SVG with resvg
 * - Flood-fill connected regions per RGBA color
 * - Pack regions into up to TARGET_LAYERS buckets by area (largest buckets first)
 * - Emit PNG layers with transparent background (no overlap)
 * - Manifest lists layer files and dominant colors
 *
 * Notes:
 * - This aims for non-overlapping, visible first layers (size/brightness) and fixes canton/stripe overlap.
 * - Keeps full original SVG as `full` for reveal-at-end.
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');
const ColorModule = require('color');
const Color = ColorModule.default || ColorModule;
const { Resvg } = require('@resvg/resvg-js');
const { PNG } = require('pngjs');
const countriesList = require('world-countries');

const FLAGS_DIR = path.join(process.cwd(), 'node_modules', 'flag-icons', 'flags', '4x3');
const OUT_DIR = path.join(process.cwd(), 'output');
const TARGET_LAYERS = 6;
const MAX_PALETTE_COLORS = 8;
const MIN_COLOR_DISTANCE = 80; // Squash near-duplicate shades to keep flags flat.
const EDGE_FILL_SPAN = 8; // How many pixels to scan for missing edge coverage.

const SKIP_CODES = new Set(['asean', 'cp', 'eu', 'gb-wls', 'mf', 'um', 'un', 'xx']);

const locationByIso = new Map();
countriesList.forEach((country) => {
  const iso = country.cca2 && typeof country.cca2 === 'string' ? country.cca2.toLowerCase() : null;
  const latlng = Array.isArray(country.latlng) && country.latlng.length >= 2 ? country.latlng : null;
  if (!iso || !latlng) return;
  const [lat, lon] = latlng;
  if (typeof lat !== 'number' || typeof lon !== 'number') return;
  locationByIso.set(iso, { lat, lon });
});

const MANUAL_LOCATIONS = new Map([
  ['arab', { lat: 25, lon: 45 }],
  ['cefta', { lat: 45.5, lon: 17 }],
  ['dg', { lat: -7.3, lon: 72.4 }],
  ['eac', { lat: 1, lon: 37 }],
  ['es-ct', { lat: 41.9, lon: 2.2 }],
  ['es-ga', { lat: 42.6, lon: -8 }],
  ['es-pv', { lat: 43, lon: -2.5 }],
  ['gb-eng', { lat: 52, lon: -1.5 }],
  ['gb-sct', { lat: 56.5, lon: -4 }],
  ['gb-wls', { lat: 52.1, lon: -3.5 }],
  ['ic', { lat: 28.1, lon: -15.4 }],
  ['pc', { lat: -25, lon: -130.1 }],
  ['sh-ac', { lat: -7.9, lon: -14.3 }],
  ['sh-hl', { lat: -15.9, lon: -5.7 }],
  ['sh-ta', { lat: -37.1, lon: -12.3 }],
]);

function brightnessScore(hex) {
  if (!hex) return 0;
  try {
    return Color(hex).luminosity();
  } catch {
    return 0;
  }
}

function toHex(c) {
  try {
    if (!c) return null;
    const s = String(c).trim().toLowerCase();
    if (s === 'none' || s === 'transparent') return null;
    const hex = Color(s).hex().toLowerCase();
    return hex.length === 4 ? Color(hex).hex().toLowerCase() : hex;
  } catch {
    return null;
  }
}

function extractPalette(svgSrc) {
  const palette = new Set();
  const regex = /(fill|stroke)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(svgSrc))) {
    const hex = toHex(match[2]);
    if (hex) palette.add(hex);
  }
  const styleRegex = /style\s*=\s*["']([^"']+)["']/gi;
  while ((match = styleRegex.exec(svgSrc))) {
    const style = match[1];
    style.split(';').forEach((part) => {
      const [k, v] = part.split(':').map((t) => t && t.trim());
      if (!k || !v) return;
      if (k === 'fill' || k === 'stroke') {
        const hex = toHex(v);
        if (hex) palette.add(hex);
      }
    });
  }
  return Array.from(palette);
}

function quantizeBufferToPalette(buffer, palette) {
  if (!palette || !palette.length) return buffer;
  const pal = palette.map((hex) => {
    const c = Color(hex).rgb().array();
    return { hex, r: c[0], g: c[1], b: c[2] };
  });
  const out = Buffer.from(buffer);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a < 32) {
      out[i] = out[i + 1] = out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }
    const r = out[i];
    const g = out[i + 1];
    const b = out[i + 2];
    let best = pal[0];
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (const c of pal) {
      const dr = r - c.r;
      const dg = g - c.g;
      const db = b - c.b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    out[i] = best.r;
    out[i + 1] = best.g;
    out[i + 2] = best.b;
    out[i + 3] = 255;
  }
  return out;
}

function hexToRgb(hex) {
  try {
    return Color(hex).rgb().array();
  } catch {
    return null;
  }
}

function colorDistanceSq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return Number.MAX_SAFE_INTEGER;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function derivePaletteFromBitmap(buffer, maxColors = MAX_PALETTE_COLORS, minDistance = MIN_COLOR_DISTANCE) {
  if (!buffer || !buffer.length) return [];
  const counts = new Map();
  for (let i = 0; i < buffer.length; i += 4) {
    const a = buffer[i + 3];
    if (a < 32) continue;
    const r = buffer[i];
    const g = buffer[i + 1];
    const b = buffer[i + 2];
    const hex =
      '#' +
      [r, g, b]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')
        .toLowerCase();
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const palette = [];
  const minDistanceSq = minDistance * minDistance;
  for (const [hex] of sorted) {
    if (palette.length >= maxColors) break;
    const rgb = hexToRgb(hex);
    if (!rgb) continue;
    const isNear = palette.some((entry) => colorDistanceSq(entry.rgb, rgb) < minDistanceSq);
    if (isNear) continue;
    palette.push({ hex, rgb });
  }
  return palette.map((entry) => entry.hex);
}

function simplifyPalette(initialPalette, bitmapBuffer) {
  const basePalette = Array.isArray(initialPalette) ? initialPalette : [];
  const palette = [];
  const seen = new Set();
  const minDistanceSq = MIN_COLOR_DISTANCE * MIN_COLOR_DISTANCE;

  function tryAdd(hex) {
    if (!hex) return;
    const norm = hex.toLowerCase();
    if (seen.has(norm)) return;
    const rgb = hexToRgb(norm);
    if (!rgb) return;
    const isNear = palette.some((entry) => colorDistanceSq(entry.rgb, rgb) < minDistanceSq);
    if (isNear) return;
    palette.push({ hex: norm, rgb });
    seen.add(norm);
  }

  basePalette.forEach(tryAdd);
  if (!palette.length) {
    const derived = derivePaletteFromBitmap(bitmapBuffer, MAX_PALETTE_COLORS * 2, MIN_COLOR_DISTANCE);
    derived.forEach(tryAdd);
    if (!palette.length && derived.length) {
      tryAdd(derived[0]);
    }
  }

  return palette.slice(0, MAX_PALETTE_COLORS).map((entry) => entry.hex);
}

function rgbaToHex(r, g, b, a) {
  if (a === 0) return null;
  return (
    '#' +
    [r, g, b]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toLowerCase()
  );
}

function renderSvg(svgSrc) {
  // Force a consistent 4:3 viewport to avoid zoom/pan surprises.
  const resvg = new Resvg(svgSrc, {
    fitTo: { mode: 'width', value: 640 },
    background: 'rgba(0,0,0,0)',
  });
  const rendered = resvg.render();
  const pngBuf = Buffer.from(rendered.asPng());
  const png = PNG.sync.read(pngBuf);
  return { width: png.width, height: png.height, data: png.data };
}

function isNearlyWhite(r, g, b, a) {
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) return false;
  if (a < 16) return false;
  return r >= 250 && g >= 250 && b >= 250;
}

function extendEdgeCoverage(buffer, width, height) {
  for (let x = 0; x < width; x++) {
    let fillY = -1;
    let fillColor = null;
    for (let y = 0; y <= EDGE_FILL_SPAN && y < height; y++) {
      const idx = (y * width + x) * 4;
      const a = buffer[idx + 3];
      if (a === 0) continue;
      const r = buffer[idx];
      const g = buffer[idx + 1];
      const b = buffer[idx + 2];
      if (!isNearlyWhite(r, g, b, a)) {
        fillY = y;
        fillColor = [r, g, b, 255];
        break;
      }
    }
    if (fillColor && fillY > 0) {
      for (let y = 0; y < fillY; y++) {
        const dstIdx = (y * width + x) * 4;
        buffer[dstIdx] = fillColor[0];
        buffer[dstIdx + 1] = fillColor[1];
        buffer[dstIdx + 2] = fillColor[2];
        buffer[dstIdx + 3] = fillColor[3];
      }
    }
  }

  for (let y = 0; y < height; y++) {
    let fillX = -1;
    let fillColor = null;
    for (let x = 0; x <= EDGE_FILL_SPAN && x < width; x++) {
      const idx = (y * width + x) * 4;
      const a = buffer[idx + 3];
      if (a === 0) continue;
      const r = buffer[idx];
      const g = buffer[idx + 1];
      const b = buffer[idx + 2];
      if (!isNearlyWhite(r, g, b, a)) {
        fillX = x;
        fillColor = [r, g, b, 255];
        break;
      }
    }
    if (fillColor && fillX > 0) {
      for (let x = 0; x < fillX; x++) {
        const dstIdx = (y * width + x) * 4;
        buffer[dstIdx] = fillColor[0];
        buffer[dstIdx + 1] = fillColor[1];
        buffer[dstIdx + 2] = fillColor[2];
        buffer[dstIdx + 3] = fillColor[3];
      }
    }
  }
}

function segmentRegions(buffer, width, height) {
  const visited = new Uint8Array(width * height);
  const regions = [];
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  function idx(x, y) {
    return y * width + x;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      if (visited[i]) continue;
      const base = i * 4;
      const a = buffer[base + 3];
      if (a === 0) {
        visited[i] = 1;
        continue;
      }
      const r = buffer[base];
      const g = buffer[base + 1];
      const b = buffer[base + 2];
      const color = rgbaToHex(r, g, b, a);
      if (!color) {
        visited[i] = 1;
        continue;
      }

      const stack = [i];
      visited[i] = 1;
      const pixels = [];
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;

      while (stack.length) {
        const cur = stack.pop();
        pixels.push(cur);
        const cx = cur % width;
        const cy = Math.floor(cur / width);
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (const [dx, dy] of dirs) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = idx(nx, ny);
          if (visited[ni]) continue;
          const baseN = ni * 4;
          const ar = buffer[baseN + 3];
          if (ar === 0) {
            visited[ni] = 1;
            continue;
          }
          const nr = buffer[baseN];
          const ng = buffer[baseN + 1];
          const nb = buffer[baseN + 2];
          const nc = rgbaToHex(nr, ng, nb, ar);
          if (nc !== color) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }

      regions.push({
        color,
        pixels,
        area: pixels.length,
        bbox: { minX, minY, maxX, maxY },
      });
    }
  }
  return regions;
}

function packRegionsIntoLayers(regions, layerCount = TARGET_LAYERS) {
  if (regions.length === 0) return [];
  // Group by color first so solid flags (e.g., Denmark) keep full coverage in one layer.
  const byColor = new Map();
  regions.forEach((r) => {
    if (!byColor.has(r.color)) byColor.set(r.color, []);
    byColor.get(r.color).push(r);
  });

  let buckets = Array.from(byColor.entries()).map(([color, list]) => {
    const area = list.reduce((a, r) => a + r.area, 0);
    return { regions: list, area, colors: new Set([color]) };
  });

  // If too many colors, merge smallest buckets until within limit.
  while (buckets.length > layerCount) {
    buckets.sort((a, b) => a.area - b.area);
    const first = buckets.shift();
    const second = buckets.shift();
    const merged = {
      regions: [...first.regions, ...second.regions],
      area: first.area + second.area,
      colors: new Set([...first.colors, ...second.colors]),
    };
    buckets.push(merged);
  }

  buckets.sort((a, b) => b.area - a.area);

  // If we have fewer buckets than layers, split the largest buckets to reach the target.
  function splitBucket(bucket) {
    if (!bucket || !bucket.regions || !bucket.regions.length) return null;
    const regions = bucket.regions.slice().sort((a, b) => b.area - a.area);
    if (regions.length === 1) {
      const region = regions[0];
      if (!region.pixels || region.pixels.length < 2) return null;
      const half = Math.ceil(region.pixels.length / 2);
      const firstPixels = region.pixels.slice(0, half);
      const secondPixels = region.pixels.slice(half);
      if (!secondPixels.length) return null;
      const makeRegion = (pixels) => ({
        color: region.color,
        pixels,
        area: pixels.length,
        bbox: region.bbox,
      });
      const a = { regions: [makeRegion(firstPixels)], area: firstPixels.length, colors: new Set([region.color]) };
      const b = { regions: [makeRegion(secondPixels)], area: secondPixels.length, colors: new Set([region.color]) };
      return [a, b];
    }
    const a = { regions: [], area: 0, colors: new Set() };
    const b = { regions: [], area: 0, colors: new Set() };
    regions.forEach((reg) => {
      const target = a.area <= b.area ? a : b;
      target.regions.push(reg);
      target.area += reg.area;
      target.colors.add(reg.color);
    });
    return [a, b];
  }

  while (buckets.length < layerCount) {
    buckets.sort((a, b) => b.area - a.area);
    const candidate = buckets.find((b) => b.area > 1 && b.regions && b.regions.length);
    if (!candidate) break;
    const idx = buckets.indexOf(candidate);
    const parts = splitBucket(candidate);
    if (!parts || parts.length !== 2 || !parts[0] || !parts[1] || !parts[0].area || !parts[1].area) {
      break;
    }
    buckets.splice(idx, 1);
    buckets.push(parts[0], parts[1]);
  }

  function bucketScore(bucket) {
    const c = dominantColor(bucket);
    const b = brightnessScore(c);
    if (!Number.isFinite(b)) return -1;
    const penalty = b < 0.12 ? 1 : 0; // Push near-black layers to the end.
    return b - penalty;
  }

  // Reveal order: brighter layers first, darker (incl. black) last. Tie-break by area.
  buckets.sort((a, b) => {
    const diff = bucketScore(b) - bucketScore(a);
    if (diff !== 0) return diff;
    return a.area - b.area;
  });
  return buckets.slice(0, layerCount);
}

function writeLayerPng(cc, idx, bucket, width, height, srcBuffer, outDir) {
  const png = new PNG({ width, height, colorType: 6 });
  png.data.fill(0);
  const data = png.data;
  bucket.regions.forEach((region) => {
    region.pixels.forEach((pIdx) => {
      const srcBase = pIdx * 4;
      const dstBase = srcBase;
      data[dstBase] = srcBuffer[srcBase];
      data[dstBase + 1] = srcBuffer[srcBase + 1];
      data[dstBase + 2] = srcBuffer[srcBase + 2];
      data[dstBase + 3] = srcBuffer[srcBase + 3];
    });
  });
  const fname = `${cc}__${String(idx).padStart(2, '0')}.png`;
  const filePath = path.join(outDir, fname);
  fs.writeFileSync(filePath, PNG.sync.write(png));
  return fname;
}

function dominantColor(bucket) {
  // Pick the color with largest area in this bucket
  const areaByColor = new Map();
  bucket.regions.forEach((r) => {
    areaByColor.set(r.color, (areaByColor.get(r.color) || 0) + r.area);
  });
  let best = null;
  let bestArea = -1;
  for (const [c, a] of areaByColor.entries()) {
    if (a > bestArea) {
      bestArea = a;
      best = c;
    }
  }
  return best || '#ffffff';
}

function main() {
  if (!fs.existsSync(FLAGS_DIR)) {
    console.error('Could not find flag-icons SVGs. Did npm install succeed?');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = glob.sync(path.join(FLAGS_DIR, '*.svg')).sort();
  const manifest = {};
  console.log(`Processing ${files.length} flags from ${FLAGS_DIR}`);

  files.forEach((file) => {
    const cc = path.basename(file, '.svg');
    if (SKIP_CODES.has(cc)) {
      const staleDir = path.join(OUT_DIR, cc);
      if (fs.existsSync(staleDir)) {
        fs.rmSync(staleDir, { recursive: true, force: true });
      }
      return;
    }
    const svgSrc = fs.readFileSync(file, 'utf8');
    let palette = extractPalette(svgSrc);
    const manualLocation = MANUAL_LOCATIONS.get(cc);
    const resolvedLocation = locationByIso.get(cc) || manualLocation || null;

    // Render and segment
    const { width, height, data } = renderSvg(svgSrc);
    palette = simplifyPalette(palette, data);
    if (!palette.length) {
      console.warn(`Skipping ${cc}: could not derive a palette.`);
      return;
    }
    const quantized = quantizeBufferToPalette(data, palette);
    extendEdgeCoverage(quantized, width, height);
    const regions = segmentRegions(quantized, width, height);
    if (!regions.length) {
      return;
    }

    // Pack into layers
    const buckets = packRegionsIntoLayers(regions, TARGET_LAYERS);

    // Clear dir and write
    const flagOutDir = path.join(OUT_DIR, cc);
    if (fs.existsSync(flagOutDir)) {
      fs.rmSync(flagOutDir, { recursive: true, force: true });
    }
    fs.mkdirSync(flagOutDir, { recursive: true });

    // Save full original SVG
    const fullFileName = `${cc}__full.svg`;
    fs.writeFileSync(path.join(flagOutDir, fullFileName), svgSrc, 'utf8');

    const filesOut = [];
    const colorsOut = [];
    const zStack = [];

    buckets.forEach((bucket, idx) => {
      const fname = writeLayerPng(cc, idx, bucket, width, height, quantized, flagOutDir);
      filesOut.push(fname);
      colorsOut.push(dominantColor(bucket));
      zStack.push(idx);
    });

    manifest[cc] = {
      colors: colorsOut,
      files: filesOut,
      z: zStack,
      full: fullFileName,
      location: resolvedLocation,
    };
  });

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Done. Wrote output/manifest.json');
}

main();

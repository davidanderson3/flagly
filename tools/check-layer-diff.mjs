import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import { globSync } from 'glob';

const OUTPUT_ROOT = path.join(process.cwd(), 'public/output');
const DIFF_THRESHOLD = 5;

function loadPng(filePath) {
  const buffer = fs.readFileSync(filePath);
  return PNG.sync.read(buffer);
}

function averageDifference(pngA, pngB) {
  if (pngA.width !== pngB.width || pngA.height !== pngB.height) {
    throw new Error('Layer sizes differ');
  }
  const totalPixels = pngA.width * pngA.height;
  let total = 0;
  for (let i = 0; i < pngA.data.length; i += 4) {
    total += Math.abs(pngA.data[i] - pngB.data[i]);
    total += Math.abs(pngA.data[i + 1] - pngB.data[i + 1]);
    total += Math.abs(pngA.data[i + 2] - pngB.data[i + 2]);
  }
  return total / (totalPixels * 3);
}

function collectLayerPaths(countryDir) {
  return globSync('*.png', { cwd: countryDir })
    .sort()
    .map((file) => path.join(countryDir, file));
}

function checkCountryLayers(countryDir) {
  const layers = collectLayerPaths(countryDir);
  const warnings = [];
  for (let i = 1; i < layers.length; i += 1) {
    const previous = loadPng(layers[i - 1]);
    const current = loadPng(layers[i]);
    const diff = averageDifference(previous, current);
    if (diff <= DIFF_THRESHOLD) {
      warnings.push({
        prev: path.basename(layers[i - 1]),
        next: path.basename(layers[i]),
        diff: diff.toFixed(2),
      });
    }
  }
  return warnings;
}

function main() {
  if (!fs.existsSync(OUTPUT_ROOT)) {
    console.error('public/output is missing');
    process.exit(1);
  }

  const countries = fs
    .readdirSync(OUTPUT_ROOT)
    .filter((entry) =>
      fs.statSync(path.join(OUTPUT_ROOT, entry)).isDirectory()
    )
    .sort();

  const issues = [];
  for (const country of countries) {
    const countryDir = path.join(OUTPUT_ROOT, country);
    const warnings = checkCountryLayers(countryDir);
    if (warnings.length) {
      issues.push({ country, warnings });
    }
  }

  if (issues.length) {
    console.log('Layer difference warnings:');
    for (const issue of issues) {
      console.log(`- ${issue.country}:`);
      for (const warning of issue.warnings) {
        console.log(
          `   ${warning.prev} → ${warning.next} (avg diff ${warning.diff})`
        );
      }
    }
    process.exit(1);
  }

  console.log('All layers show significant change.');
}

main();

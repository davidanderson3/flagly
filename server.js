#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const OUT_DIR = path.join(process.cwd(), 'output');
const PUB_DIR = path.join(process.cwd(), 'public');

app.get('/api/manifest', (req, res) => {
  const mf = path.join(OUT_DIR, 'manifest.json');
  if (!fs.existsSync(mf)) return res.json({});
  const data = JSON.parse(fs.readFileSync(mf, 'utf8'));
  res.json(data);
});

app.use('/output', express.static(OUT_DIR, { fallthrough: false }));
app.use('/', express.static(PUB_DIR, { fallthrough: false }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Flag Layers Game running at http://localhost:${port}`);
});

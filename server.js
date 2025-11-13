// server.js
// Private CSV + simple auth. Serves static frontend and exposes /api/points securely.

const express = require('express');
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Basic Auth (username & password via env) ----
const AUTH_USER = process.env.BASIC_AUTH_USER || null;
const AUTH_PASS = process.env.BASIC_AUTH_PASS || null;

function requireAuth(req, res, next) {
  if (!AUTH_USER || !AUTH_PASS) return next(); // auth disabled if not set
  const hdr = req.headers['authorization'] || '';
  if (!hdr.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Protected"');
    return res.status(401).send('Authentication required');
  }
  const creds = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  const [u, p] = creds.split(':');
  if (u === AUTH_USER && p === AUTH_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Protected"');
  return res.status(401).send('Invalid credentials');
}

// Trust proxy when running behind a platform load balancer
app.set('trust proxy', true);

app.use(requireAuth); // Require Authentication

// Serve static files from /public (frontend)
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', extensions: ['html'] }));

// --- Healthcheck (for platform uptime monitoring) ---
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ---- CSV Loader with simple caching ----
const CSV_LOCAL_PATH = path.join(__dirname, 'data', 'Sites.csv');
let cache = { rows: null, mtimeMs: 0 };

// Parse coordinate that may be in DD or DMS format (e.g. 28.6139, 28°36'50"N, 77 12 30 E)
function parseCoord(value) {
  if (value == null) return NaN;
  if (typeof value === 'number') return value;

  let s = String(value).trim();
  if (!s) return NaN;

  // Support comma decimal separator, e.g. "28,6139"
  s = s.replace(',', '.');

  const hasDmsSymbols = /[°'"]/g.test(s);
  const hasHemisphere = /[NSEW]/i.test(s);

  // Plain decimal degrees (no DMS symbols and no hemisphere letters)
  if (!hasDmsSymbols && !hasHemisphere) {
    const num = Number(s);
    return Number.isNaN(num) ? NaN : num;
  }

  // ---- DMS parsing ----
  // Extract hemisphere (N/S/E/W) if present
  let hemi = null;
  const hemiMatch = s.match(/([NSEW])/i);
  if (hemiMatch) {
    hemi = hemiMatch[1].toUpperCase();
    s = s.replace(/[NSEW]/gi, ' ');
  }

  // Replace ° ' " with spaces and normalize whitespace
  s = s
    .replace(/°/g, ' ')
    .replace(/'/g, ' ')
    .replace(/"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = s.split(' ').filter(Boolean);
  if (parts.length === 0) return NaN;

  const deg = parseFloat(parts[0]);         // degrees
  const min = parseFloat(parts[1] || '0');  // minutes (optional)
  const sec = parseFloat(parts[2] || '0');  // seconds (optional)

  if (Number.isNaN(deg) || Number.isNaN(min) || Number.isNaN(sec)) return NaN;

  let dec = Math.abs(deg) + (min / 60) + (sec / 3600);

  // If degrees itself is negative, preserve sign
  if (deg < 0) dec *= -1;

  // Hemisphere overrides sign
  if (hemi === 'S' || hemi === 'W') dec = -Math.abs(dec);
  else if (hemi === 'N' || hemi === 'E') dec = Math.abs(dec);

  return dec;
}

// Case-insensitive key finder for flexible CSV headers
function findKey(obj, candidates) {
  const lower = Object.fromEntries(Object.keys(obj).map(k => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const hit = lower[c.toLowerCase()];
    if (hit) return hit;
  }
  return null;
}


function normalizeRows(rows) {
  const out = [];
  let dropped = 0;

  for (const row of rows) {
    const latKey  = findKey(row, ['lat', 'Latitude', 'y']);
    const lonKey  = findKey(row, ['lon', 'lng', 'Longitude', 'x']);
    const nameKey = findKey(row, ['user', 'username', 'name', 'label', 'Analyst']);

    if (!latKey || !lonKey || !nameKey) { dropped++; continue; }

    const lat = parseCoord(row[latKey]);
    const lon = parseCoord(row[lonKey]);
    const label = String(row[nameKey]).trim();

    if (Number.isNaN(lat) || Number.isNaN(lon) || !label) { dropped++; continue; }

    out.push({ lat, lon, label });
  }

  if (dropped) console.warn(`normalizeRows: dropped ${dropped} row(s) due to invalid/missing coords or label.`);
  return out;
}


async function loadCsvCached() {
  try {
    const stat = await fs.promises.stat(CSV_LOCAL_PATH);
    if (!cache.rows || stat.mtimeMs > cache.mtimeMs) {
      const text = await fs.promises.readFile(CSV_LOCAL_PATH, 'utf8');
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      const rows = Array.isArray(parsed.data) ? parsed.data : [];
      cache = { rows: normalizeRows(rows), mtimeMs: stat.mtimeMs };
    }
    return cache.rows;
  } catch (e) {
    console.error('CSV load error:', e.message);
    return [];
  }
}

// ---- Protected API ----
app.get('/api/points', requireAuth, async (req, res) => {
  const data = await loadCsvCached();
  res.set('Cache-Control', 'no-store');
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
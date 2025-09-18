// src/server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import crypto from 'crypto';
import compression from 'compression';
import fetch from 'node-fetch';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';


globalThis.fetch = fetch; // ensure fetch exists in Node

// --- Resolve __dirname in ES modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- App setup ---
const app = express();
const port = process.env.PORT || 3000;

// --- Simple in-memory cache for OpenCage ---
const ocCache = new Map(); // key => { t, body, status, contentType }
const OC_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const OC_MAX_ENTRIES = 300;

function ocGet(key) {
  const row = ocCache.get(key);
  if (!row) return null;
  if (Date.now() - row.t > OC_TTL_MS) { ocCache.delete(key); return null; }
  return row;
}
function ocSet(key, val) {
  if (ocCache.size >= OC_MAX_ENTRIES) {
    // drop oldest to keep memory bounded
    let oldestKey, oldestT = Infinity;
    for (const [k, v] of ocCache) if (v.t < oldestT) { oldestT = v.t; oldestKey = k; }
    if (oldestKey) ocCache.delete(oldestKey);
  }
  ocCache.set(key, { t: Date.now(), ...val });
}


// If behind a proxy (Railway/Render/Heroku), trust it so rate limits/IPs work
app.set('trust proxy', 1);

// Hide "X-Powered-By"
app.disable('x-powered-by');

// --- Security headers (Helmet) ---
// Content Security Policy tuned to your current client (Leaflet + CDNs + external APIs).
// Loosened where necessary (e.g., inline scripts for tiny globals, inline styles in your DOM injections).
app.use(
  helmet({
    // Allow cross-origin tiles/images (OSM, Wikipedia, etc.)
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // COEP can break third-party map tiles; keep it off
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Block everything by default, then open what you need
        "default-src": ["'self'"],
        // You use a couple of tiny inline <script> tags in index.html
        "script-src": [
          "'self'",
          "https://unpkg.com"
        ],
        // You use inline style attributes and CDN CSS
        "style-src": [
          "'self'",
          "'unsafe-inline'", 
          "https://unpkg.com", 
          "https://fonts.googleapis.com"
        ],
        // Leaflet pulls images/tiles; NASA/iNat/Wikipedia thumbs; also your uploaded files
        "img-src": [
          "'self'",
          "data:",
          "blob:",
          "https://tile.openstreetmap.org",
          "https://upload.wikimedia.org",
          "https://static.inaturalist.org",
          "https://epic.gsfc.nasa.gov",
          "https://apod.nasa.gov",
          "https://*"
        ],
        // Where fetch/XHR/WebSockets are allowed from the browser
        "connect-src": [
          "'self'",
          "https://api.inaturalist.org",
          "https://api.nasa.gov",
          "https://epic.gsfc.nasa.gov",
          "https://waterservices.usgs.gov",
          "https://en.wikipedia.org",
          "https://geocode.arcgis.com",
          "https://api.opencagedata.com",
          "https://photon.komoot.io",
          "https://geocoding.geo.census.gov",
          "https://tile.openstreetmap.org"
        ],
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'self'"],
        "upgrade-insecure-requests": []
      }
    }
  })
);

// --- Rate limiting (light, targeted) ---
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // 120 requests/min per IP to API routes
  standardHeaders: true,
  legacyHeaders: false
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 30,                  // 30 uploads per 10 minutes
  message: { error: 'Too many uploads, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// --- Compression (before static) ---
app.use(compression());

// --- Body parsing with tight-ish limits ---
app.use(express.json({ limit: '200kb' })); // your payloads are tiny JSON

// --- Static assets ---
// 1) Long-cache uploads (filenames are content-addressed-ish via timestamp/uuid)
app.use(
  '/uploads',
  express.static(path.join(__dirname, '../public/uploads'), {
    etag: true,
    immutable: true,
    maxAge: '30d'
  })
);

// 2) Index (no-store) so HTML changes are always fetched fresh
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 3) Everything else in /public with conservative caching (your current behavior)
app.use(
  express.static(path.join(__dirname, '../public'), {
    etag: true,
    lastModified: true,
    maxAge: 0,
    immutable: false
  })
);

// --- Simple health check for uptime monitors ---
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// --- Ensure file/dir helpers ---
function ensureFile(filePath, initialContent) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, initialContent, 'utf8');
}

// --- Data stores (Tips & Markers) ---
const TIPS_FILE = path.join(__dirname, '../data/tips.json');
ensureFile(TIPS_FILE, JSON.stringify({}));
function readTips() { return JSON.parse(fs.readFileSync(TIPS_FILE, 'utf8')); }
function writeTips(data) { fs.writeFileSync(TIPS_FILE, JSON.stringify(data, null, 2), 'utf8'); }

const MARKERS_FILE = path.join(__dirname, '../data/markers.json');
ensureFile(MARKERS_FILE, JSON.stringify([]));
function readMarkers() { return JSON.parse(fs.readFileSync(MARKERS_FILE, 'utf8')); }
function writeMarkers(data) { fs.writeFileSync(MARKERS_FILE, JSON.stringify(data, null, 2), 'utf8'); }

// --- Uploads setup (multer) ---
const UPLOAD_DIR = path.join(__dirname, '../public/uploads/tips');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];
    if (!safeExts.includes(ext)) return cb(new Error('Unsupported file extension'));
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 }, // 6MB
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(file.mimetype);
    if (!ok) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  }
});

// --- Tips key helpers & migration ---
(function migrateTipKeysOnce() {
  try {
    const all = readTips();
    let changed = false;
    const next = {};
    for (const [k, arr] of Object.entries(all)) {
      let nk = k;
      if (typeof k === 'string' && !k.includes(':')) {
        nk = /^\d{7,15}$/.test(k) ? `usgs:${k}` : `custom:${k}`;
      }
      if (nk !== k) changed = true;
      next[nk] = Array.isArray(arr) ? arr : [];
    }
    if (changed) writeTips(next);
  } catch (e) {
    console.warn('Tip key migration skipped:', e.message);
  }
})();

function tipKeyFrom(obj) {
  if (typeof obj?.key === 'string' && obj.key.includes(':')) return obj.key;
  if (obj?.siteId) return `usgs:${obj.siteId}`;
  if (obj?.markerIndex != null) return `custom:${obj.markerIndex}`;
  return null;
}
function findTipIndex(arr, { id, index }) {
  if (id) {
    const i = arr.findIndex(t => t.id === id);
    if (i !== -1) return i;
  }
  if (index != null) return Number(index);
  return -1;
}

// --- Apply rate limits to API/proxy routes ---
app.use(
  [
    '/api/tips',
    '/api/markers',
    '/api/tip-photos',
    '/api/wikipedia/nearby',
    '/api/wiki/nearby',
    '/api/wikidata/nearby',
    '/api/wiki/historic',
    '/api/wikidata/historic',
    '/api/photon',
    '/api/census/oneline',
    '/api/census/address',
    '/api/opencage',
    '/api/3wa'
  ],
  apiLimiter
);

// --- Tips API ---
app.get('/api/tips', (req, res) => {
  const key = tipKeyFrom(req.query);
  if (!key) return res.json([]);
  const viewer = req.query.viewer || null;
  const all = readTips();
  const raw = all[key] || [];
  const out = raw.filter(
    t =>
      t.status === 'published' ||
      (viewer && t.userId && t.userId === viewer && t.status === 'draft')
  );
  res.json(out);
});

app.post('/api/tips', (req, res) => {
  const key = tipKeyFrom(req.body);
  const { text } = req.body || {};
  if (!key || !text) return res.status(400).json({ error: 'Missing target or text' });

  const all = readTips();
  const tip = {
    id: crypto.randomUUID(),
    text: String(text),
    timestamp: Date.now(),
    userId: req.body?.userId || null,
    photoUrl: req.body?.photoUrl || null,
    status: req.body?.status === 'draft' ? 'draft' : 'published'
  };

  all[key] = all[key] || [];
  all[key].push(tip);
  writeTips(all);
  res.status(201).json(tip);
});

app.put('/api/tips', (req, res) => {
  const key = tipKeyFrom(req.body);
  const { id, index, text } = req.body || {};
  if (!key || (!text && !Object.prototype.hasOwnProperty.call(req.body, 'photoUrl')))
    return res.status(400).json({ error: 'Missing key and updates' });

  const all = readTips();
  const arr = all[key] || [];
  const i = findTipIndex(arr, { id, index });
  if (i < 0 || !arr[i]) return res.status(404).json({ error: 'Tip not found' });

  if (text) arr[i].text = String(text);
  if (Object.prototype.hasOwnProperty.call(req.body, 'photoUrl')) {
    arr[i].photoUrl = req.body.photoUrl;
  }
  arr[i].timestamp = Date.now();
  writeTips(all);
  res.json(arr[i]);
});

app.put('/api/tips/publish', (req, res) => {
  const key = tipKeyFrom(req.body);
  const { id, index, userId } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const all = readTips();
  const arr = all[key] || [];
  const i = findTipIndex(arr, { id, index });
  if (i < 0) return res.status(404).json({ error: 'Tip not found' });

  const t = arr[i];
  if (t.userId && userId && t.userId !== userId) {
    return res.status(403).json({ error: 'Not your draft' });
  }
  t.status = 'published';
  t.timestamp = Date.now();
  writeTips(all);
  res.json(t);
});

app.delete('/api/tips', (req, res) => {
  const key = tipKeyFrom(req.body);
  const { index } = req.body || {};
  if (!key || index == null) return res.status(400).json({ error: 'Missing key/index' });
  const all = readTips();
  if (!all[key] || !all[key][index]) return res.status(404).json({ error: 'Tip not found' });
  all[key].splice(index, 1);
  writeTips(all);
  res.status(204).end();
});

// --- Markers API ---
app.get('/api/markers', (_req, res) => res.json(readMarkers()));

app.post('/api/markers', (req, res) => {
  const { lat, lon, title, description, category } = req.body || {};
  if (lat == null || lon == null || !title) return res.status(400).end();
  const list = readMarkers();
  const marker = { lat, lon, title, description, category, timestamp: Date.now() };
  list.push(marker);
  writeMarkers(list);
  res.status(201).json(marker);
});

app.put('/api/markers', (req, res) => {
  const { index, lat, lon, title, description, category } = req.body || {};
  if (index == null || !title) return res.status(400).end();
  const list = readMarkers();
  if (!list[index]) return res.status(404).end();
  list[index] = { lat, lon, title, description, category, timestamp: Date.now() };
  writeMarkers(list);
  res.json(list[index]);
});

app.delete('/api/markers', (req, res) => {
  const { index } = req.body || {};
  if (index == null) return res.status(400).end();
  const list = readMarkers();
  if (!list[index]) return res.status(404).end();
  list.splice(index, 1);
  writeMarkers(list);
  res.status(204).end();
});

// --- what3words proxy ---
app.get('/api/3wa', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    const key = process.env.W3W_API_KEY?.trim();
    if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });
    if (!key) return res.status(500).json({ error: 'Missing W3W_API_KEY' });

    const url = new URL('https://api.what3words.com/v3/convert-to-3wa');
    url.searchParams.set('coordinates', `${lat},${lon}`);
    url.searchParams.set('key', key);
    url.searchParams.set('language', 'en');

    const r = await fetch(url);
    const body = await r.json().catch(() => ({}));
    if (r.ok && body?.words) return res.status(200).json({ words: body.words });
    res.status(r.status).json(body);
  } catch (_e) {
    res.status(500).json({ error: 'server error' });
  }
});

// --- Photo upload endpoint (limited) ---
app.post('/api/tip-photos', uploadLimiter, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/tips/${req.file.filename}` });
});

// >>> Wikipedia Nearby proxy (with back-compat)
const wikiCache = new Map();
const WIKI_TTL_MS = 10 * 60 * 1000;

async function wikipediaNearbyHandler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    let km = Math.min(Math.max(Number(req.query.km) || 8, 1), 100);
    let limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const key = `${lat.toFixed(3)}:${lon.toFixed(3)}:${km}:${limit}`;
    const hit = wikiCache.get(key);
    if (hit && Date.now() - hit.t < WIKI_TTL_MS) return res.json(hit.data);

    const u = new URL('https://en.wikipedia.org/w/api.php');
    const MAX_RADIUS_M = 10000; // MediaWiki cap
    const radiusM = Math.min(Math.round(km * 1000), MAX_RADIUS_M);

    u.searchParams.set('format', 'json');
    u.searchParams.set('action', 'query');
    u.searchParams.set('generator', 'geosearch');
    u.searchParams.set('ggscoord', `${lat}|${lon}`);
    u.searchParams.set('ggsradius', String(radiusM));
    u.searchParams.set('ggslimit', String(limit));
    u.searchParams.set('prop', 'coordinates|pageimages|extracts|info');
    u.searchParams.set('coprop', 'type|name|dim|country|region|globe|primary');
    u.searchParams.set('colimit', 'max');
    u.searchParams.set('exintro', '1');
    u.searchParams.set('explaintext', '1');
    u.searchParams.set('exlimit', 'max');
    u.searchParams.set('piprop', 'thumbnail');
    u.searchParams.set('pithumbsize', '320');
    u.searchParams.set('inprop', 'url');

    const r = await fetch(u, { headers: { 'User-Agent': 'ElectricGavinoe/1.0 (+local)' } });
    const j = await r.json();

    if (j?.error) {
      return res.status(502).json({ error: 'Wikipedia error', detail: j.error.info || j.error.code });
    }

    const haversineKm = (aLat, aLon, bLat, bLon) => {
      const toRad = d => (d * Math.PI) / 180;
      const R = 6371;
      const dLat = toRad(bLat - aLat);
      const dLon = toRad(bLon - aLon);
      const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    };

    const pages = j.query?.pages || {};
    const rows = Object.values(pages)
      .map(p => {
        const coord = p.coordinates?.[0];
        const distKm =
          coord?.lat != null && coord?.lon != null
            ? Math.round(haversineKm(lat, lon, coord.lat, coord.lon) * 10) / 10
            : null;
        return {
          pageid: p.pageid,
          title: p.title,
          extract: p.extract || '',
          lat: coord?.lat ?? null,
          lon: coord?.lon ?? null,
          distKm,
          thumb: p.thumbnail?.source || null,
          url: p.fullurl || p.canonicalurl || `https://en.wikipedia.org/?curid=${p.pageid}`
        };
      })
      .sort((a, b) => (a.distKm ?? 1e9) - (b.distKm ?? 1e9))
      .slice(0, limit);

    console.log('[wiki] rows=', rows.length, 'for', lat, lon, 'km=req', km, 'km=used', Math.min(km, 10));
    wikiCache.set(key, { t: Date.now(), data: rows });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'server error', detail: String(e?.message || e) });
  }
}

app.get('/api/wikipedia/nearby', wikipediaNearbyHandler);
// Back-compat aliases for older clients:
app.get(
  ['/api/wiki/nearby', '/api/wikidata/nearby', '/api/wiki/historic', '/api/wikidata/historic'],
  wikipediaNearbyHandler
);

// --- Photon proxy (avoids CORS; keeps your origin) ---
app.get('/api/photon', async (req, res) => {
  try {
    const upstream = new URL('https://photon.komoot.io/api/');
    for (const [k, v] of Object.entries(req.query)) upstream.searchParams.set(k, String(v));

    const r = await fetch(upstream.toString(), {
      headers: { 'User-Agent': 'ElectricGavinoe/1.0 (+local)' }
    });
    const body = await r.text();

    res.set('Content-Type', r.headers.get('content-type') || 'application/json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: 'Photon proxy failed', detail: String(e?.message || e) });
  }
});

// --- US Census proxies (avoid CORS) ---
app.get('/api/census/oneline', async (req, res) => {
  try {
    const u = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
    u.searchParams.set('address', String(req.query.address || ''));
    u.searchParams.set('benchmark', String(req.query.benchmark || 'Public_AR_Current'));
    u.searchParams.set('format', 'json');

    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'ElectricGavinoe/1.0 (+local)' } });
    const body = await r.text();
    res.set('Content-Type', r.headers.get('content-type') || 'application/json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: 'Census oneline proxy failed', detail: String(e?.message || e) });
  }
});

app.get('/api/census/address', async (req, res) => {
  try {
    const u = new URL('https://geocoding.geo.census.gov/geocoder/locations/address');
    for (const k of ['street', 'city', 'state', 'zip', 'benchmark']) {
      if (req.query[k]) u.searchParams.set(k, String(req.query[k]));
    }
    if (!u.searchParams.get('benchmark')) u.searchParams.set('benchmark', 'Public_AR_Current');
    u.searchParams.set('format', 'json');

    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'ElectricGavinoe/1.0 (+local)' } });
    const body = await r.text();
    res.set('Content-Type', r.headers.get('content-type') || 'application/json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: 'Census address proxy failed', detail: String(e?.message || e) });
  }
});

// --- OpenCage proxy (requires OPENCAGE_KEY in .env) ---
app.get('/api/opencage', async (req, res) => {
  try {
    const key = process.env.OPENCAGE_KEY?.trim();
    if (!key) return res.status(500).json({ error: 'Missing OPENCAGE_KEY' });

    // Sanitize/Clamp inputs
    const q = String(req.query.q || '').slice(0, 200); // prevent abuse
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), 10);
    const language = req.query.language ? String(req.query.language) : undefined;
    const no_annotations = req.query.no_annotations ? String(req.query.no_annotations) : undefined;
    const countrycode = req.query.countrycode ? String(req.query.countrycode) : undefined;
    const proximity = req.query.proximity ? String(req.query.proximity) : undefined;

    const cacheKey = JSON.stringify({ q, limit, language, no_annotations, countrycode, proximity });
    const hit = ocGet(cacheKey);
    if (hit) {
      res.set('Content-Type', hit.contentType || 'application/json; charset=utf-8');
      return res.status(hit.status || 200).send(hit.body);
    }

    const u = new URL('https://api.opencagedata.com/geocode/v1/json');
    u.searchParams.set('key', key);
    u.searchParams.set('q', q);
    u.searchParams.set('limit', String(limit));
    if (language) u.searchParams.set('language', language);
    if (no_annotations) u.searchParams.set('no_annotations', no_annotations);
    if (countrycode) u.searchParams.set('countrycode', countrycode);
    if (proximity) u.searchParams.set('proximity', proximity);

    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'ElectricGavinoe/1.0 (+local)' } });
    const body = await r.text();
    const contentType = r.headers.get('content-type') || 'application/json; charset=utf-8';

    ocSet(cacheKey, { body, status: r.status, contentType });

    res.set('Content-Type', contentType);
    return res.status(r.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: 'OpenCage proxy failed', detail: String(e?.message || e) });
  }
});


// --- Upload errors & generic error handler ---

// in src/server.js (anywhere above the 404 handler)
app.get('/api/config', (_req, res) => {
  res.json({
    opencageEnabled: Boolean(process.env.OPENCAGE_KEY),
    // don't send the NASA key value unless you want it public
  });
});


// --- 404 logger ---
app.use((req, res) => {
  console.warn('404 for path:', req.method, req.originalUrl);
  res.status(404).send('Not found');
});

// (Keeps Multer errors clean; prevents stack traces from leaking)
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (typeof err?.message === 'string' &&
     (err.message.includes('Unsupported file extension') || err.message.includes('Only image'))) {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Start server ---
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

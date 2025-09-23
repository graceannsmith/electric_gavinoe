// src/server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import crypto from 'crypto';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// Node ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ──────────────────────────────────────────────────────────────────────────────
// App setup
// ──────────────────────────────────────────────────────────────────────────────
const app  = express();
const port = process.env.PORT || 3000;

// If behind a proxy (Railway/Render/Heroku), trust it so rate limits/IPs work
app.set('trust proxy', 1);

// Hide "X-Powered-By"
app.disable('x-powered-by');

// Security headers (CSP tuned for your current client)
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "https://unpkg.com"],
        "style-src": ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com"],
        "img-src": [
          "'self'", "data:", "blob:",
          "https://tile.openstreetmap.org",
          "https://upload.wikimedia.org",
          "https://static.inaturalist.org",
          "https://epic.gsfc.nasa.gov",
          "https://apod.nasa.gov",
          "https://*"
        ],
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
        "frame-ancestors": ["'self'"]
      }
    }
  })
);

// Compression + JSON body parsing
app.use(compression());
app.use(express.json({ limit: '200kb' })); // your payloads are tiny JSON

// ──────────────────────────────────────────────────────────────────────────────
/** Rate limits */
// ──────────────────────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { error: 'Too many uploads, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Apply limits to API/proxy routes
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
    '/api/3wa', '/api/nasa/apod', '/api/nasa/epic'
  ],
  apiLimiter
);

// ──────────────────────────────────────────────────────────────────────────────
/** Static assets (uploads + built client) */
// ──────────────────────────────────────────────────────────────────────────────
const PUBLIC_UPLOADS_DIR = path.join(__dirname, '../public/uploads'); // serves /uploads/**
app.use('/uploads', express.static(PUBLIC_UPLOADS_DIR, {
  etag: true, immutable: true, maxAge: '30d'
}));

const distDir = path.join(__dirname, '../dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, {
    etag: true, lastModified: true, immutable: true, maxAge: '1y', index: false
  }));
  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// ──────────────────────────────────────────────────────────────────────────────
/** Small file stores for markers/tips */
// ──────────────────────────────────────────────────────────────────────────────
function ensureFile(filePath, initialContent) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, initialContent, 'utf8');
}

const DATA_DIR = path.join(__dirname, '../data');
const MARKERS_FILE = path.join(DATA_DIR, 'markers.json');
const TIPS_FILE    = path.join(DATA_DIR, 'tips.json');

ensureFile(MARKERS_FILE, JSON.stringify([]));
ensureFile(TIPS_FILE, JSON.stringify({}));

function readMarkers() { 
  return readJSONSafe(MARKERS_FILE, []);
}
function writeMarkers(arr) {
  fs.writeFileSync(MARKERS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

function readTips() {
  return readJSONSafe(TIPS_FILE, {});
}
function writeTips(data) {
  fs.writeFileSync(TIPS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ──────────────────────────────────────────────────────────────────────────────
/** Multer upload for tip photos */
// ──────────────────────────────────────────────────────────────────────────────
const TIP_UPLOAD_DIR = path.join(PUBLIC_UPLOADS_DIR, 'tips');
fs.mkdirSync(TIP_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TIP_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];
    if (!safeExts.includes(ext)) return cb(new Error('Unsupported file extension'));
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(file.mimetype);
    if (!ok) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
/** Config endpoint (lets client know which optional keys exist) */
// ──────────────────────────────────────────────────────────────────────────────
// src/server.js
app.get('/api/config', (_req, res) => {
  res.json({
    opencageEnabled: Boolean(process.env.OPENCAGE_KEY),
    hasNasa: Boolean(process.env.NASA_API_KEY)
  });
});

// ──────────────────────────────────────────────────────────────────────────────
/** Markers API (used by client/src/main.js) */
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/markers', (_req, res) => res.json(readMarkers()));

app.post('/api/markers', (req, res) => {
  const { lat, lon, title, description, category, userId } = req.body || {};
  if (lat == null || lon == null || !title) return res.status(400).json({ error: 'Missing fields' });
  const list = readMarkers();
  const marker = { lat, lon, title, description, category, userId: userId || null, timestamp: Date.now() };
  list.push(marker);
  writeMarkers(list);
  res.status(201).json(marker);
});

app.put('/api/markers', (req, res) => {
  const { index, lat, lon, title, description, category } = req.body || {};
  if (index == null || !title) return res.status(400).json({ error: 'Missing index/title' });
  const list = readMarkers();
  if (!list[index]) return res.status(404).json({ error: 'Not found' });
  list[index] = { lat, lon, title, description, category, timestamp: Date.now() };
  writeMarkers(list);
  res.json(list[index]);
});

app.delete('/api/markers', (req, res) => {
  const { index } = req.body || {};
  if (index == null) return res.status(400).json({ error: 'Missing index' });
  const list = readMarkers();
  if (!list[index]) return res.status(404).json({ error: 'Not found' });
  list.splice(index, 1);
  writeMarkers(list);
  res.status(204).end();
});

function readJSONSafe(file, fallback) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    console.warn('[data] recovering from bad JSON in', path.basename(file), e.message);
    try { fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8'); } catch {}
    return fallback;
  }
}


// ──────────────────────────────────────────────────────────────────────────────
/** Tips API (Perceptacle) */
// ──────────────────────────────────────────────────────────────────────────────
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

app.get('/api/tips', (req, res) => {
  const key = tipKeyFrom(req.query);
  if (!key) return res.json([]);
  const viewer = req.query.viewer || null;
  const all = readTips();
  const raw = all[key] || [];
  const out = raw.filter(
    t => t.status === 'published' || (viewer && t.userId && t.userId === viewer && t.status === 'draft')
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
    return res.status(400).json({ error: 'Missing key/updates' });

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

// Photo upload for tips
app.post('/api/tip-photos', uploadLimiter, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/tips/${req.file.filename}` });
});

// ──────────────────────────────────────────────────────────────────────────────
/** Proxies your client uses */
// ──────────────────────────────────────────────────────────────────────────────

// Wikipedia Nearby (with simple cache)
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
    const radiusM = Math.min(Math.round(km * 1000), 10000);

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

    if (j?.error) return res.status(502).json({ error: 'Wikipedia error', detail: j.error.info || j.error.code });

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

    wikiCache.set(key, { t: Date.now(), data: rows });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'server error', detail: String(e?.message || e) });
  }
}
app.get('/api/wikipedia/nearby', wikipediaNearbyHandler);
app.get(['/api/wiki/nearby', '/api/wikidata/nearby', '/api/wiki/historic', '/api/wikidata/historic'], wikipediaNearbyHandler);

// Photon proxy
app.get('/api/photon', async (req, res) => {
  try {
    const upstream = new URL('https://photon.komoot.io/api/');
    for (const [k, v] of Object.entries(req.query)) upstream.searchParams.set(k, String(v));
    const r = await fetch(upstream.toString(), { headers: { 'User-Agent': 'ElectricGavinoe/1.0 (+local)' } });
    const body = await r.text();
    res.set('Content-Type', r.headers.get('content-type') || 'application/json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: 'Photon proxy failed', detail: String(e?.message || e) });
  }
});

// US Census proxies
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

// OpenCage proxy (requires OPENCAGE_KEY)
const ocCache = new Map(); // key => { t, body, status, contentType }
const OC_TTL_MS = 5 * 60 * 1000;
const OC_MAX_ENTRIES = 300;
const ocGet = (key) => {
  const row = ocCache.get(key);
  if (!row) return null;
  if (Date.now() - row.t > OC_TTL_MS) { ocCache.delete(key); return null; }
  return row;
};
const ocSet = (key, val) => {
  if (ocCache.size >= OC_MAX_ENTRIES) {
    let oldestKey, oldestT = Infinity;
    for (const [k, v] of ocCache) if (v.t < oldestT) { oldestT = v.t; oldestKey = k; }
    if (oldestKey) ocCache.delete(oldestKey);
  }
  ocCache.set(key, { t: Date.now(), ...val });
};

app.get('/api/opencage', async (req, res) => {
  try {
    const key = process.env.OPENCAGE_KEY?.trim();
    if (!key) return res.status(500).json({ error: 'Missing OPENCAGE_KEY' });

    const q = String(req.query.q || '').slice(0, 200);
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
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: 'OpenCage proxy failed', detail: String(e?.message || e) });
  }
});

// what3words proxy (requires W3W_API_KEY)
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
  } catch {
    res.status(500).json({ error: 'server error' });
  }
});

// src/server.js — NASA proxies
app.get('/api/nasa/apod', async (_req, res) => {
  try {
    const key = process.env.NASA_API_KEY?.trim();
    if (!key) return res.status(500).json({ error: 'Missing NASA_API_KEY' });
    const r = await fetch(`https://api.nasa.gov/planetary/apod?api_key=${key}&thumbs=true`);
    const j = await r.json().catch(() => ({}));
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(502).json({ error: 'NASA APOD proxy failed', detail: String(e?.message || e) });
  }
});

app.get('/api/nasa/epic', async (_req, res) => {
  try {
    const key = process.env.NASA_API_KEY?.trim();
    if (!key) return res.status(500).json({ error: 'Missing NASA_API_KEY' });
    const r = await fetch(`https://api.nasa.gov/EPIC/api/natural/images?api_key=${key}`);
    const j = await r.json().catch(() => ([]));
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(502).json({ error: 'NASA EPIC proxy failed', detail: String(e?.message || e) });
  }
});


// --- SPA fallback for client-side routing (must come before the 404) ---
if (fs.existsSync(distDir)) {
  app.get(/^\/(?!api|uploads|health|assets|favicon\.ico).*/, (req, res) => {
    // Anything that's not an API/static path falls back to the app shell
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// ──────────────────────────────────────────────────────────────────────────────
/** Errors & 404 */
// ──────────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  console.warn('404:', req.method, req.originalUrl);
  res.status(404).send('Not found');
});

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

// ──────────────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});

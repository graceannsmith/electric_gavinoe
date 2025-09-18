// public/main.js

window.APP_CONFIG = { OPENCAGE_ENABLED: false, NASA_API_KEY: '' };
fetch('/api/config').then(r => r.json()).then(c => {
  if (c?.opencageEnabled) window.APP_CONFIG.OPENCAGE_ENABLED = true;
}).catch(() => {});

console.log('EG main.js v2025-09-13a');

const map = L.map('map', { preferCanvas:true, zoomAnimation:true, markerZoomAnimation:false })
  .setView([36.0840, -94.1739], 9.5);
window.map = map; // some helpers check this

const markerLayer = L.layerGroup().addTo(map);
const customLayer = L.layerGroup().addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  updateWhenIdle: true,
  updateWhenZooming: false,
  keepBuffer: 0,
  crossOrigin: true
}).addTo(map);



// ===== USGS request management helpers =====
let usgsAbortController = null;
const ivCache = new Map(); // id -> { t: timestampMs, last } for 5 min

function freshIV(id) {
  const row = ivCache.get(id);
  return row && (Date.now() - row.t) < 5 * 60 * 1000 ? row.last : null;
}

async function pLimitAll(limit, items, handler) {
  const ret = [];
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await handler(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return ret;
}

/* ============================
   Geocoder (smart + resilient)
   ============================ */

/** Normalize US address input for better matching (drop ZIP+4, collapse spaces, expand common abbrevs) */
function normalizeUSQuery(q) {
  let s = String(q || '').trim();
  s = s.replace(/[\s,]+/g, ' ');          // collapse whitespace/commas
  s = s.replace(/\b(\d{5})-\d{4}\b/, '$1'); // ZIP+4 -> ZIP5
  s = s.replace(/\bRd\b\.?/i, ' Road');     // light expansion example
  return s;
}
function normalizeIntlQuery(q) {
  return String(q || '')
    .trim()
    .replace(/\s+,/g, ',')
    .replace(/,\s+/g, ', ')
    .replace(/[\s,]+/g, ' ');
}

const STATE_ABBR_RE = /\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/i;
function isLikelyUS(q) {
  const s = String(q || '').toUpperCase();
  return /\b\d{5}(?:-\d{4})?\b/.test(s) || STATE_ABBR_RE.test(s) || /\bUSA|UNITED STATES\b/.test(s);
}


// Minimal local ZIP hints for city names around Union Star Rd
const ZIP_HINTS = {
  'WEST FORK,AR': ['72774'],
  'GREENLAND,AR': ['72737'],
  'WINSLOW,AR': ['72959']
};

/** US Census geocoder fallback (excellent rural coverage; no key needed) */
async function geocodeWithCensus(oneLine, benchmark = 'Public_AR_Current') {
  const u = new URL('/api/census/oneline', window.location.origin);
  u.searchParams.set('address', oneLine);
  u.searchParams.set('benchmark', benchmark);

  const r = await fetch(u.toString(), { headers: { 'Accept': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  const hits = j?.result?.addressMatches || [];
  return hits.map(m => {
    const lat = +m?.coordinates?.y, lon = +m?.coordinates?.x;
    return {
      name: m?.matchedAddress || oneLine,
      center: L.latLng(lat, lon),
      bbox: L.latLngBounds([lat, lon], [lat, lon])
    };
  });
}
async function geocodeWithOpenCage(oneLine) {
  const u = new URL('/api/opencage', window.location.origin);
  u.searchParams.set('q', oneLine);
  u.searchParams.set('limit', '5');
  const r = await fetch(u.toString());
  const j = await r.json().catch(() => ({}));

  const results = j?.results || [];
  return results.map(v => {
    const lat = +v?.geometry?.lat, lon = +v?.geometry?.lng;
    const b = v?.bounds;
    const bbox = b
      ? L.latLngBounds([+b.south, +b.west], [+b.north, +b.east])
      : L.latLngBounds([lat, lon], [lat, lon]);
    return { name: v.formatted || oneLine, center: L.latLng(lat, lon), bbox };
  });
}


// Providers (Leaflet-Control-Geocoder v3 uses Promises)
const primary = L.Control.Geocoder.nominatim();

const photon = (L.Control?.Geocoder?.photon)
  ? L.Control.Geocoder.photon({
      serviceUrl: '/api/photon',                 // ← your proxy
      geocodingQueryParams: { lang: 'en', limit: 8 }
    })
  : null;


function splitUSAddress(q) {
  const s0 = String(q || '').trim()
    .replace(/\s+,/g, ',')
    .replace(/,\s+/g, ', ')
    .replace(/\s+/g, ' ');
  const U = s0.toUpperCase();

  // Find the last 2-letter state
  const STATE_RE = /\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/g;
  let state = '', stateIdx = -1, m;
  while ((m = STATE_RE.exec(U)) !== null) { state = m[1]; stateIdx = m.index; }

  // ZIP only counts if it's after the state and at end
  let zip = '';
  const zipMatch = U.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (zipMatch && stateIdx !== -1 && zipMatch.index > stateIdx) {
    zip = zipMatch[1];
  }

  let pre = stateIdx !== -1 ? s0.slice(0, stateIdx).replace(/,\s*$/, '').trim() : s0;
  let city = '';

  if (stateIdx !== -1) {
    const parts = pre.split(',').map(t => t.trim()).filter(Boolean);
    if (parts.length >= 2) {
      city = parts.pop();              // “…, CITY”
      pre  = parts.join(', ');
    } else {
      // If it starts with a house number, try last 2 tokens as a two-word city
      const tokens = pre.split(' ');
      if (tokens.length >= 3 && /^\d+[A-Z]?$/.test(tokens[0])) {
        city = tokens.slice(-2).join(' ');
        pre  = tokens.slice(0, -2).join(' ');
      }
    }
  }

  const street = pre.trim();
  return { street, city, state, zip };
}


async function geocodeWithCensusParts(q, benchmark = 'Public_AR_Current') {
  const { street, city, state, zip } = splitUSAddress(q);
  if (!street) return [];

  // Build candidate (city,zip) combos to try
  const combos = [];
  const key = (city && state) ? `${city.toUpperCase()},${state.toUpperCase()}` : '';

  // 1) As parsed
  combos.push({ street, city, state, zip });

  // 2) Known zips for the city (if no zip provided)
  if (!zip && key && ZIP_HINTS[key]) {
    for (const z of ZIP_HINTS[key]) combos.push({ street, city, state, zip: z });
    // also try street + state + zip (no city)
    for (const z of ZIP_HINTS[key]) combos.push({ street, city: '', state, zip: z });
  }

  // 3) If we *do* have a zip, also try street+state+zip (no city)
  if (zip && state) combos.push({ street, city: '', state, zip });

  // 4) Dedup
  const seen = new Set();
  const uniq = combos.filter(c => {
    const k = JSON.stringify([c.street,c.city,c.state,c.zip]);
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  // Try each combo against your proxy
  for (const c of uniq) {
    const u = new URL('/api/census/address', window.location.origin);
    u.searchParams.set('street', c.street);
    if (c.city)  u.searchParams.set('city', c.city);
    if (c.state) u.searchParams.set('state', c.state);
    if (c.zip)   u.searchParams.set('zip', c.zip);
    u.searchParams.set('benchmark', benchmark);

    const r = await fetch(u.toString(), { headers: { 'Accept': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    const hits = j?.result?.addressMatches || [];
    if (hits.length) {
      return hits.map(m => {
        const lat = +m.coordinates.y, lon = +m.coordinates.x;
        return {
          name: m.matchedAddress || [c.street, c.city, c.state, c.zip].filter(Boolean).join(', '),
          center: L.latLng(lat, lon),
          bbox: L.latLngBounds([lat, lon], [lat, lon])
        };
      });
    }
  }

  return [];
}

async function geocodeWithArcGIS(oneLine, countryCode) {
  const u = new URL('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates');
  u.searchParams.set('f', 'json');
  u.searchParams.set('SingleLine', oneLine);
  u.searchParams.set('outFields', 'Match_addr,Addr_type');
  u.searchParams.set('maxLocations', '5');
  if (countryCode) u.searchParams.set('countryCode', countryCode);

  const r = await fetch(u.toString());
  const j = await r.json().catch(() => ({}));
  const cands = j?.candidates || [];
  return cands.map(c => ({
    name: c.attributes?.Match_addr || oneLine,
    center: L.latLng(+c.location.y, +c.location.x),
    bbox: L.latLngBounds([+c.location.y, +c.location.x], [+c.location.y, +c.location.x])
  }));
}






// Promise-based smart geocoder: bounded Nominatim → unbounded Nominatim → Photon → (US-only) Census → ArcGIS → (optional) OpenCage
const smartGeocoder = {
  async geocode(query, ctx) {
    const us = isLikelyUS(query);
    const q = us ? normalizeUSQuery(query) : normalizeIntlQuery(query);

    // 1) Nominatim, bounded to current view for relevance
    try {
      primary.options.geocodingQueryParams = us
        ? { countrycodes: 'us', viewbox: map.getBounds().toBBoxString(), bounded: 1 }
        : { viewbox: map.getBounds().toBBoxString(), bounded: 1 };

      const r1 = await primary.geocode(q, ctx);
      if (Array.isArray(r1) && r1.length) return r1;
    } catch {}

    // 2) Nominatim, unbounded (global), still bias to US if detected
    try {
      primary.options.geocodingQueryParams = us ? { countrycodes: 'us' } : {};
      const r2 = await primary.geocode(q, ctx);
      if (Array.isArray(r2) && r2.length) return r2;
    } catch {}

    // 3) Photon (OSM-based; good interpolation)
    try {
      if (photon) {
        const r3 = await photon.geocode(q, ctx);
        if (Array.isArray(r3) && r3.length) return r3;
      }
    } catch {}

    // 4–6) US Census (only if it looks like a US query)
    if (us) {
      try {
        const r4 = await geocodeWithCensus(q, 'Public_AR_Current');
        if (r4?.length) return r4;
      } catch {}

      try {
        const r5 = await geocodeWithCensusParts(q, 'Public_AR_Current');
        if (r5?.length) return r5;
      } catch {}

      try {
        const r6 = await geocodeWithCensusParts(q, 'Public_AR_Census2020');
        if (r6?.length) return r6;
      } catch {}
    }

    // 7) ArcGIS World (great rural/global fallback)
    try {
      const r7 = await geocodeWithArcGIS(q, us ? 'USA' : undefined);
      if (r7?.length) return r7;
    } catch {}

    // 8) OpenCage (optional; gated to avoid 500 spam if no key)
    try {
      if (window.APP_CONFIG?.OPENCAGE_ENABLED) {
      const r8 = await geocodeWithOpenCage(q);
      if (r8?.length) return r8;
      }

    } catch {}

    return [];
  },

  async suggest(query, ctx) {
    if (!photon) return [];
    const q = isLikelyUS(query) ? normalizeUSQuery(query) : normalizeIntlQuery(query);
    try {
      const s = await photon.suggest(q, ctx);
      return Array.isArray(s) ? s : [];
    } catch {
      return [];
    }
  },

  reverse(location, scale) {
    if (typeof primary.reverse === 'function') return primary.reverse(location, scale);
    if (photon && typeof photon.reverse === 'function') return photon.reverse(location, scale);
    return Promise.resolve([]);
  }
};


const geocoderControl = L.Control.geocoder({
  collapsed: false,
  position: 'topright',
  geocoder: smartGeocoder,
  defaultMarkGeocode: false,
  placeholder: 'Search address or place… (worldwide)',
  suggestMinLength: photon ? 3 : 9999,
  errorMessage: 'No suggestions — press Enter to search',
  suggestTimeout: 250
})

.on('markgeocode', (e) => {
  const bbox = e.geocode.bbox || L.latLngBounds(e.geocode.center, e.geocode.center);
  map.fitBounds(bbox, { maxZoom: 17 });
})
.addTo(map);


// Keep control interactive and above the map UI; let plugin handle Enter/clicks.
(function ensureGeocoderTop() {
  const el = geocoderControl._container;
  if (!el) return;
  el.style.zIndex = 2001;
  L.DomEvent.disableClickPropagation(el);
  L.DomEvent.disableScrollPropagation(el);
})();

// Sidebar
const sidebar = L.control.sidebar({ container: 'sidebar', position: 'left', closeButton: true, autopan: false }).addTo(map);
sidebar.open('details');

// === Draggable sidebar width ===
(function addSidebarResizer(){
  const root = document.getElementById('sidebar');
  if (!root) return;

  const BORDER_W = parseFloat(getComputedStyle(root).getPropertyValue('--border-w')) || 12;

  function getContentWidthPx() {
    const rect = root.getBoundingClientRect();
    return Math.max(0, rect.width - 2 * BORDER_W);
  }

  // Apply saved width (or sync current) on every load
  (function initSidebarWidth(){
    const saved = parseFloat(localStorage.getItem('egSidebarWpx') || '');
    const contentPx = isNaN(saved)
      ? getContentWidthPx()
      : Math.max(280, Math.min(saved, 900));
    root.style.setProperty('--sidebar-content', `${Math.round(contentPx)}px`);
  })();

  if (!root.querySelector('.sidebar-resizer')) {
    const handle = document.createElement('div');
    handle.className = 'sidebar-resizer';
    handle.title = 'Drag to resize';
    root.appendChild(handle);

    if (window.L?.DomEvent) {
      L.DomEvent.disableClickPropagation(handle);
      L.DomEvent.disableScrollPropagation(handle);
    }

    let startX = 0, startW = 0, dragging = false;
    let reenable = null;

    function onDown(e){
      const x = (e.touches?.[0]?.clientX ?? e.clientX);
      startX = x;
      startW = getContentWidthPx();
      dragging = true;
      root.classList.add('is-resizing');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';

      if (window.map) {
        const was = {
          dragging: map.dragging.enabled(),
          scroll: map.scrollWheelZoom.enabled?.() ?? true,
          dbl: map.doubleClickZoom.enabled?.() ?? true,
          box: map.boxZoom.enabled?.() ?? true
        };
        reenable = () => {
          if (was.dragging) map.dragging.enable(); else map.dragging.disable?.();
          if (was.scroll)   map.scrollWheelZoom.enable?.(); else map.scrollWheelZoom.disable?.();
          if (was.dbl)      map.doubleClickZoom.enable?.(); else map.doubleClickZoom.disable?.();
          if (was.box)      map.boxZoom.enable?.(); else map.boxZoom.disable?.();
        };
        map.dragging.disable?.();
        map.scrollWheelZoom.disable?.();
        map.doubleClickZoom.disable?.();
        map.boxZoom.disable?.();
      }

      window.addEventListener('mousemove', onMove, { passive:false });
      window.addEventListener('touchmove', onMove, { passive:false });
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchend', onUp);
      e.preventDefault();
      e.stopPropagation?.();
    }

    function onMove(e){
      if (!dragging) return;
      const x = (e.touches?.[0]?.clientX ?? e.clientX);
      const dx = x - startX;

      const viewportCap = Math.max(200, window.innerWidth * 0.98 - 2 * BORDER_W);
      const maxPx = Math.min(viewportCap, 900);
      const next = Math.max(280, Math.min(startW + dx, maxPx));

      root.style.setProperty('--sidebar-content', `${Math.round(next)}px`);
      localStorage.setItem('egSidebarWpx', String(Math.round(next)));
      window.map?.invalidateSize?.({ animate: false });

      e.preventDefault();
      e.stopPropagation?.();
    }

    function onUp(){
      dragging = false;
      root.classList.remove('is-resizing');
      window.map?.invalidateSize?.({ animate: false });
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      reenable?.(); reenable = null;

      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
    }

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: true });
  }
})();


// 3) Upload helper for tip photos
async function uploadTipPhoto(file) {
  const fd = new FormData();
  fd.append("photo", file);
  const resp = await fetch("/api/tip-photos", { method: "POST", body: fd });
  if (!resp.ok) throw new Error(`Upload failed: ${await resp.text()}`);
  const data = await resp.json();
  return data.url;
}

// 4) State + user
let activeType = null, activeId = null;
let userId = localStorage.getItem('egUserId');
if (!userId) {
  const gen = (crypto && crypto.randomUUID) ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now());
  userId = gen; localStorage.setItem('egUserId', userId);
}
const TIP_SORT_KEY = 'egTipSort';
const getTipSort = () => localStorage.getItem(TIP_SORT_KEY) || 'newest';
const setTipSort = (v) => localStorage.setItem(TIP_SORT_KEY, v);

let currentMarkerData = null;
const escapeHTML = (s) => (s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// 5) Category helpers (custom markers)
const CATEGORY_META = {
  plant:   { label: 'Plant',   glyph: '🌿', class: 'mk--plant'   },
  history: { label: 'History', glyph: '🏛', class: 'mk--history' },
  misc:    { label: 'Misc',    glyph: '📍', class: 'mk--misc'    }
};
function normalizeCategory(raw){
  const k = String(raw||'').trim().toLowerCase();
  return (k in CATEGORY_META) ? k : (['plant','history','misc'].includes(k) ? k : 'misc');
}
function categoryLabel(cat){ return (CATEGORY_META[cat]?.label) || 'Misc'; }
function categoryGlyph(cat){ return (CATEGORY_META[cat]?.glyph) || '📍'; }
function makeCategoryIcon(cat){
  const key = normalizeCategory(cat);
  const meta = CATEGORY_META[key] || CATEGORY_META.misc;
  return L.divIcon({
    className: 'mk-wrap',
    html: `<div class="mk ${meta.class}"><span class="mk__glyph">${meta.glyph}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28]
  });
}

// 6) what3words helper
async function fetch3wa(lat, lon) {
  const res = await fetch(`/api/3wa?lat=${lat}&lon=${lon}`);
  const json = await res.json();
  return json.words || '';
}

// iNaturalist nearby (client-only; CORS OK)
async function fetchINatNearby(lat, lon, km = 5, limit = 10) {
  const u = new URL('https://api.inaturalist.org/v1/observations');
  u.search = new URLSearchParams({
    lat: lat.toFixed(6),
    lng: lon.toFixed(6),
    radius: String(km), per_page: String(limit),
    order: 'desc', order_by: 'observed_on', photos: 'true'
  });
  const r = await fetch(u); if (!r.ok) throw new Error('iNat failed');
  const j = await r.json();
  return (j.results || []).map(o => ({
    id: o.id,
    title: o.taxon?.preferred_common_name || o.taxon?.name || o.species_guess || 'Observation',
    img: o.photos?.[0]?.url?.replace('square', 'small') || null,
    url: o.uri || `https://www.inaturalist.org/observations/${o.id}`,
    when: o.observed_on_details?.date || o.time_observed_at || ''
  }));
}

// Wikipedia Nearby (via your server proxy)
async function fetchWikipediaNearby(lat, lon, km = 50, limit = 20) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Invalid coordinates');
  const url = new URL('/api/wikipedia/nearby', window.location.origin);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('km', String(km));
  url.searchParams.set('limit', String(limit));
  const r = await fetch(url.toString());
  const ct = r.headers.get('content-type') || '';
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); }
  catch { console.error('[wiki] Non-JSON response. content-type=', ct, ' body=', text.slice(0, 400)); throw new Error('Bad JSON from server'); }
  if (!Array.isArray(data)) throw new Error('Unexpected response shape');
  return data;
}

// tiny list renderer
function renderApiList(rows) {
  const list = document.getElementById('api-result-list');
  list.innerHTML = rows.map(r => r.html).join('') || '<li>Nothing found.</li>';
}

// NASA APOD (daily) + EPIC fallback (robust)
async function injectNasaCard() {
  const host = document.getElementById('pane-details-content') || document.body;
  if (!host || document.getElementById('nasa-card')) return;

  const key = (window.APP_CONFIG?.NASA_API_KEY || 'DEMO_KEY');
  const wrap = document.createElement('div');
  wrap.id = 'nasa-card';
  wrap.style.cssText = 'margin:8px 0;padding:8px;border-radius:10px;background:#111;color:#eee';
  wrap.innerHTML = `<div>🚀 <strong>Space image of the day</strong></div><div id="nasa-card-body">Loading…</div>`;
  host.prepend(wrap);

  const show = (imgUrl, linkUrl, title, date, caption) => {
    document.getElementById('nasa-card-body').innerHTML =
      `<div style="display:flex;gap:8px;align-items:flex-start;">
         <img src="${imgUrl}" alt="" style="max-width:120px;border-radius:8px" loading="lazy">
         <div>
           <div><a href="${linkUrl}" target="_blank" rel="noopener" style="color:#9cf">${escapeHTML(title)}</a></div>
           <small>${escapeHTML(date || '')}${caption ? ' — ' + escapeHTML(caption) : ''}</small>
         </div>
       </div>`;
  };

  try {
    const r = await fetch(`https://api.nasa.gov/planetary/apod?api_key=${key}&thumbs=true`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || (!j.url && !j.thumbnail_url)) throw new Error('APOD unavailable');
    const img = j.media_type === 'video' ? j.thumbnail_url : j.url;
    show(img, j.hdurl || j.url || img, j.title || 'APOD', j.date || '', '');
    return;
  } catch {}

  try {
    const r2 = await fetch(`https://api.nasa.gov/EPIC/api/natural/images?api_key=${key}`);
    const frames = await r2.json();
    if (!Array.isArray(frames) || !frames.length) throw new Error('EPIC empty');
    const f = frames[0];
    const dt = new Date(f.date);
    const yyyy = dt.getUTCFullYear(), mm = String(dt.getUTCMonth()+1).padStart(2,'0'), dd = String(dt.getUTCDate()).padStart(2,'0');
    const url = `https://epic.gsfc.nasa.gov/archive/natural/${yyyy}/${mm}/${dd}/png/${f.image}.png`;
    show(url, url, `DSCOVR/EPIC – ${f.caption || 'Earth'}`, f.date, f.caption || '');
  } catch {
    document.getElementById('nasa-card-body').textContent = 'NASA image unavailable (rate limit or network).';
  }
}

/* ============================
   Details pane + Perceptacle
   ============================ */
function showDetails(html, coords) {
  const pane = document.getElementById('pane-details-content');

  const legacyActions = document.getElementById('details-actions');
  if (legacyActions) legacyActions.style.display = 'none';

  if (coords?.length === 2) pane.dataset.coords = `${coords[0]},${coords[1]}`;
  else delete pane.dataset.coords;

  const metaBlock = `
  <div class="details-header" style="margin-top:6px">
    <div>
      ${activeType === 'usgs'
        ? `<span class="readonly-pill">USGS marker · read-only</span>`
        : `<span class="readonly-pill">Custom marker</span>`}
    </div>
    ${activeType === 'custom' ? `
      <div class="hover-controls">
        <button class="hover-btn" id="btn-edit-marker" title="Edit marker">✏️</button>
        <button class="hover-btn" id="btn-delete-marker" title="Delete marker">🗑</button>
      </div>` : ``}
  </div>
`;

  const infoBlock = `<div id="marker-info">${html}</div>`;

  const exploreBlock = `
  <div id="api-explore" style="margin:.5rem 0;">
    <div style="display:flex;flex-wrap:wrap;gap:.5rem;">
      <button id="btn-inat" title="iNaturalist recent observations">🪲 iNaturalist</button>
      <button id="btn-wiki-historic" title="Wikipedia Nearby">📚 Wikipedia Nearby</button>
    </div>
    <ul id="api-result-list" style="margin:.5rem 0 0; padding-left:0; list-style:none; max-height:220px; overflow:auto;"></ul>
  </div>
`;

  pane.innerHTML = `
  ${infoBlock}
  ${metaBlock}
  ${exploreBlock}
  <p id="w3w-footer"></p>
  <hr/>
  <h1 class="section-title">Perceptacle</h1>
  <form id="tip-inline-form">
    <textarea id="tip-inline-text" rows="3" placeholder="Add an observation… " style="flex:1;width:100%"></textarea>
    <input id="tip-inline-file" type="file" accept="image/*" style="display:none" />
    <button type="button" id="tip-attach-btn" title="Attach photo">📎</button>
    <button type="submit" id="tip-preview-btn">Preview</button>
  </form>

  <div id="tip-toolbar">
    <label for="tip-sort">Sort</label>
    <select id="tip-sort">
      <option value="newest">Newest</option>
      <option value="oldest">Oldest</option>
    </select>
  </div>

  <ul id="tip-inline-list"></ul>
`;

  const [lat, lon] = (pane.dataset.coords || '').split(',').map(Number);
  const listEl = () => document.getElementById('api-result-list');

  document.getElementById('btn-inat')?.addEventListener('click', async () => {
    listEl().innerHTML = '<li>Loading iNaturalist…</li>';
    try {
      const obs = await fetchINatNearby(lat, lon, 5, 10);
      const rows = obs.map(o => ({
        html: `<li class="api-card">
                 <div><a href="${o.url}" target="_blank" rel="noopener">${escapeHTML(o.title)}</a>
                 <small style="color:#666"> — ${escapeHTML(o.when||'')}</small></div>
                 ${o.img ? `<img src="${o.img}" alt="" style="max-width:120px;border-radius:8px;margin-top:4px" loading="lazy">` : ''}
               </li>`
      }));
      renderApiList(rows);
    } catch {
      listEl().innerHTML = '<li>Sorry, iNaturalist request failed.</li>';
    }
  });

  // Wikipedia Nearby button wiring
  document.getElementById('btn-wiki-historic')?.addEventListener('click', async () => {
    let qLat = Number(currentMarkerData?.lat);
    let qLon = Number(currentMarkerData?.lon);

    if (!Number.isFinite(qLat) || !Number.isFinite(qLon)) {
      const paneEl = document.getElementById('pane-details-content');
      if (paneEl?.dataset?.coords) {
        const [a, b] = paneEl.dataset.coords.split(',').map(Number);
        qLat = Number.isFinite(a) ? a : qLat;
        qLon = Number.isFinite(b) ? b : qLon;
      }
    }

    if (!Number.isFinite(qLat) || !Number.isFinite(qLon)) {
      const c = map.getCenter();
      qLat = c.lat; qLon = c.lng;
    }

    const list = document.getElementById('api-result-list');
    list.innerHTML = '<li class="api-card">Searching Wikipedia nearby…</li>';

    try {
      console.debug('[wiki] querying', { lat: qLat, lon: qLon });
      const rows = await fetchWikipediaNearby(qLat, qLon, 8, 20);
      console.debug('[wiki] results', rows?.length, rows?.[0]);

      const header = `<li class="api-card" style="opacity:.8">
        <small>Results near ${qLat.toFixed(3)}, ${qLon.toFixed(3)}</small>
      </li>`;

      if (!Array.isArray(rows) || rows.length === 0) {
        list.innerHTML = header + '<li class="api-card">No results.</li>';
        return;
      }

      list.innerHTML = header + rows.map(r => {
        const meta = r.distKm != null ? `~${r.distKm} km` : '';
        return `<li class="api-card">
          <div><a href="${r.url}" target="_blank" rel="noopener"><strong>${escapeHTML(r.title)}</strong></a>
          ${meta ? ` <small style="color:#666">${escapeHTML(meta)}</small>` : ''}</div>
          ${r.thumb ? `<img src="${r.thumb}" alt="" style="max-width:120px;border-radius:8px;margin-top:4px" loading="lazy">` : ''}
          ${r.extract ? `<div style="margin-top:4px;color:#333">${escapeHTML(r.extract)}</div>` : ''}
        </li>`;
      }).join('');
    } catch (e) {
      list.innerHTML = `<li class="api-card">Wikipedia request failed: ${escapeHTML(e.message || 'error')}</li>`;
    }
  });

  const sortSel = pane.querySelector('#tip-sort');
  if (sortSel) {
    sortSel.value = getTipSort();
    sortSel.addEventListener('change', () => { setTipSort(sortSel.value); renderInlineTips(); });
  }

  sidebar.open('details');

  // what3words footer
  const coordParts = pane.dataset.coords?.split(',') || [];
  if (coordParts.length === 2) {
    const [latS, lonS] = coordParts;
    fetch3wa(latS, lonS)
      .then(words => {
        document.getElementById('w3w-footer').innerHTML = words
          ? `<strong>3 Words:</strong> ${words} <a href="https://what3words.com/${words}" target="_blank" rel="noopener">what is this?</a>`
          : '';
      })
      .catch(() => { document.getElementById('w3w-footer').textContent = ''; });
  }

  if (activeType === 'custom') {
    pane.querySelector('#btn-edit-marker')?.addEventListener('click', openCustomEditForm);
    pane.querySelector('#btn-delete-marker')?.addEventListener('click', deleteCustomMarkerInline);
  }

  // ---- Perceptacle: attach / drag ----
  const textEl   = document.getElementById('tip-inline-text');
  const fileEl   = document.getElementById('tip-inline-file');
  const attachBtn= document.getElementById('tip-attach-btn');
  const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
  function setPendingFile(f){
    if (f.size > MAX_IMAGE_BYTES) throw new Error('Image too large (max 6MB).');
    if (!f.type.startsWith('image/')) throw new Error('Only image files are allowed.');
  }
  attachBtn?.addEventListener('click', () => fileEl?.click());
  fileEl?.addEventListener('change', () => {
    const f = fileEl.files?.[0]; if (!f) return;
    try { setPendingFile(f); } catch(e){ alert(e.message); fileEl.value=''; }
  });
  ['dragenter','dragover'].forEach(ev =>
    textEl?.addEventListener(ev, e => { e.preventDefault(); textEl.classList.add('drop-target'); })
  );
  ['dragleave','dragend'].forEach(ev =>
    textEl?.addEventListener(ev, () => textEl.classList.remove('drop-target'))
  );
  textEl?.addEventListener('drop', e => {
    e.preventDefault(); textEl.classList.remove('drop-target');
    const file = [...(e.dataTransfer?.files||[])].find(f=>f.type.startsWith('image/')) || null;
    if (!file) return;
    try { setPendingFile(file); } catch(err){ alert(err.message); }
  });

  // ---- Inline tips ----
  async function renderInlineTips() {
    if (activeType !== 'usgs' && activeType !== 'custom') return;
    const q = activeType === 'usgs' ? `siteId=${activeId}` : `markerIndex=${activeId}`;
    const res = await fetch(`/api/tips?${q}&viewer=${encodeURIComponent(userId)}`);
    const tips = await res.json();

    const list = document.getElementById('tip-inline-list');
    const order = getTipSort();
    const pairs = tips.map((t, i) => ({ t, i })).sort((a,b) => {
      const ta = +a.t.timestamp || 0, tb = +b.t.timestamp || 0;
      return order === 'newest' ? (tb - ta) : (ta - tb);
    });

    list.innerHTML = pairs.map(({ t, i }) => {
  const ts = new Date(t.timestamp).toLocaleString();
  const img = t.photoUrl ? `<img class="tip-photo" src="${t.photoUrl}" alt="Tip photo" loading="lazy">` : '';
  const isOwnDraft = (t.status === 'draft' && t.userId === userId);
  const draftPill = isOwnDraft ? `<span class="pill">Draft (private)</span>` : '';
  const actions = isOwnDraft
    ? `<div class="tip-actions">
         <button class="edit-tip">Edit</button>
         <button class="publish-tip">Publish</button>
         <button class="delete-tip">Delete</button>
       </div>`
    : `<button class="edit-tip" title="Edit tip">✏️</button>
       <button class="delete-tip" title="Delete tip">🗑</button>`;

  return `
    <li class="tip-item ${isOwnDraft ? 'draft' : ''}" data-tip-index="${i}" data-tip-id="${t.id||''}">
      <div class="tip-text">${escapeHTML(t.text)} ${draftPill}</div>
      ${img}
      ${actions}
      <span class="timestamp">(${ts})</span>
    </li>`;
}).join('');


    // Delegated actions
    list.onclick = async (ev) => {
      const li = ev.target.closest('.tip-item'); if (!li) return;
      const idx = +li.dataset.tipIndex;
      const tipId = li.dataset.tipId || null;

      if (ev.target.classList.contains('publish-tip')) {
        await fetch('/api/tips/publish', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(activeType === 'usgs'
            ? { siteId: activeId, id: tipId, userId }
            : { markerIndex: activeId, id: tipId, userId })
        });
        return renderInlineTips();
      }

      if (ev.target.classList.contains('delete-tip')) {
        await fetch('/api/tips', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(activeType === 'usgs'
            ? { siteId: activeId, index: idx }
            : { markerIndex: activeId, index: idx })
        });
        return renderInlineTips();
      }

      if (ev.target.classList.contains('edit-tip')) {
        const q2 = activeType === 'usgs' ? `siteId=${activeId}` : `markerIndex=${activeId}`;
        const current = await (await fetch(`/api/tips?${q2}&viewer=${encodeURIComponent(userId)}`)).json();
        const t = current[idx]; const originalText = t?.text ?? '';
        li.innerHTML = `
          <form class="tip-edit-form" data-tip-id="${tipId}">
            <textarea rows="3" style="width:100%;">${escapeHTML(originalText)}</textarea>
            <div style="margin-top:6px; display:flex; gap:8px; flex-wrap:wrap;">
              <button class="attach-new" type="button">📎 Replace photo</button>
              <button class="remove-photo" type="button">Remove photo</button>
              <button type="submit">Save</button>
              <button class="cancel-tip" type="button">Cancel</button>
              <input type="file" class="hidden-file" accept="image/*" style="display:none" />
            </div>
          </form>
        `;
        const form = li.querySelector('form');
        const hidden = form.querySelector('.hidden-file');
        let newPhotoUrl = undefined;

        form.querySelector('.attach-new')?.addEventListener('click', ()=> hidden.click());
        hidden.addEventListener('change', async () => {
          const f = hidden.files?.[0]; if (!f) return;
          try { newPhotoUrl = await uploadTipPhoto(f); }
          catch(e){ alert(e.message || 'Upload failed'); newPhotoUrl = undefined; hidden.value=''; }
        });
        form.querySelector('.remove-photo')?.addEventListener('click', ()=> { newPhotoUrl = null; });

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const newText = form.querySelector('textarea').value.trim();
          const body = activeType === 'usgs' ? { siteId: activeId, id: tipId } : { markerIndex: activeId, id: tipId };
          if (newText) body.text = newText;
          if (newPhotoUrl !== undefined) body.photoUrl = newPhotoUrl;
          await fetch('/api/tips', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          renderInlineTips();
        });
        form.querySelector('.cancel-tip')?.addEventListener('click', () => renderInlineTips());
      }
    };
  }

  // Initial tips render
  renderInlineTips();

  // Preview (create draft)
  document.getElementById('tip-inline-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const txt = document.getElementById('tip-inline-text').value.trim();
    if (!txt) return;

    const fileElLocal = document.getElementById('tip-inline-file');
    let photoUrl = null;

    if (fileElLocal?.files?.[0]) {
      try { photoUrl = await uploadTipPhoto(fileElLocal.files[0]); }
      catch (err) { console.warn('Photo upload failed; continuing without photo', err); }
    }

    const base = { text: txt, userId, photoUrl, status: 'draft' };
    const payload = activeType === 'usgs' ? { ...base, siteId: activeId } : { ...base, markerIndex: activeId };

    await fetch('/api/tips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

    document.getElementById('tip-inline-text').value = '';
    if (fileElLocal) fileElLocal.value = '';
    await renderInlineTips();
  });
} // end showDetails

// 7) Custom marker inline edit + delete
async function openCustomEditForm() {
  if (activeType !== 'custom') return;
  const all = await (await fetch('/api/markers')).json();
  const m = all[activeId]; if (!m) return;

  const info = document.getElementById('marker-info'); if (!info) return;
  info.innerHTML = `
    <form class="marker-edit-form" id="marker-edit-form">
      <label>Title <input name="title" value="${escapeHTML(m.title || '')}" /></label>
      <label>Description <textarea name="description" rows="3">${escapeHTML(m.description || '')}</textarea></label>
      <label>Category <input name="category" value="${escapeHTML(m.category || '')}" /></label>
      <div class="marker-edit-actions">
        <button type="submit">Save</button>
        <button type="button" id="marker-cancel">Cancel</button>
      </div>
    </form>
  `;

  const form = document.getElementById('marker-edit-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const title = String(fd.get('title') || '').trim();
    const description = String(fd.get('description') || '').trim();
    const category = String(fd.get('category') || '').trim();
    if (!title) return;

    const payload = { index: activeId, lat: m.lat, lon: m.lon, title, description, category };
    const res = await fetch('/api/markers', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const updated = await res.json();

    currentMarkerData = { type: 'custom', index: activeId, title: updated.title, lat: updated.lat, lon: updated.lon };
    await loadCustomMarkers();

    const html = `
      <h1 class="section-title">${escapeHTML(updated.title)}</h1>
      <p><strong>Category:</strong> ${escapeHTML(updated.category || '')}</p>
      <p>${escapeHTML(updated.description || '')}</p>
      <p><em>${new Date(updated.timestamp).toLocaleString()}</em></p>
    `;
    showDetails(html, [updated.lat, updated.lon]);
  });

  document.getElementById('marker-cancel')?.addEventListener('click', async () => {
    const all2 = await (await fetch('/api/markers')).json();
    const m2 = all2[activeId]; if (!m2) return;
    const html = `
      <h1 class="section-title">${escapeHTML(m2.title)}</h1>
      <p><strong>Category:</strong> ${escapeHTML(m2.category || '')}</p>
      <p>${escapeHTML(m2.description || '')}</p>
      <p><em>${new Date(m2.timestamp).toLocaleString()}</em></p>
    `;
    showDetails(html, [m2.lat, m2.lon]);
  });
}

async function deleteCustomMarkerInline() {
  if (activeType !== 'custom') return;
  if (!confirm('Remove this marker?')) return;
  await fetch('/api/markers', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: activeId })
  });
  await loadCustomMarkers();
  sidebar.close();
}

// 8) Load USGS gauges (within viewport) — abortable + throttled + cached
async function loadUSGSGages() {
  if (usgsAbortController) usgsAbortController.abort();
  usgsAbortController = new AbortController();
  const { signal } = usgsAbortController;

  markerLayer.clearLayers();

  if (map.getZoom() < 7) return;

  const b = map.getBounds();
  const sw = b.getSouthWest(), ne = b.getNorthEast();
  const params = [
    sw.lng.toFixed(7),
    sw.lat.toFixed(7),
    ne.lng.toFixed(7),
    ne.lat.toFixed(7)
  ].join(',');
  const siteUrl = `https://waterservices.usgs.gov/nwis/site/?format=rdb&siteType=ST&siteStatus=all&parameterCd=00065&bBox=${params}`;

  try {
    const res = await fetch(siteUrl, { signal });
    if (!res.ok) return;

    const text = await res.text();
    const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
    if (!lines.length) return;

    const header = lines.shift().split('\t');
    const sites = lines
      .map(l => {
        const cols = l.split('\t');
        const obj = {};
        header.forEach((h, i) => (obj[h] = cols[i]));
        return obj;
      })
      .filter(s => /^[0-9]+$/.test(s.site_no))
      .filter(s => Number.isFinite(+s.dec_lat_va) && Number.isFinite(+s.dec_long_va));

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 5);

    await pLimitAll(6, sites, async (site) => {
      const id = site.site_no;
      const lat = +site.dec_lat_va;
      const lon = +site.dec_long_va;

      let last = freshIV(id);
      let unit = 'ft';

      if (!last) {
        const ivUrl = new URL('https://waterservices.usgs.gov/nwis/iv');
        ivUrl.searchParams.set('format', 'json');
        ivUrl.searchParams.set('sites', id);
        ivUrl.searchParams.set('parameterCd', '00065');

        const ivRes = await fetch(ivUrl, { signal }).catch(() => null);
        if (!ivRes || !ivRes.ok) return;

        const ivJson = await ivRes.json().catch(() => ({}));
        const series = ivJson.value?.timeSeries || [];
        const vals = series[0]?.values?.[0]?.value || [];
        if (!series.length || !vals.length) return;

        last = vals[vals.length - 1];
        unit = series[0]?.variable?.unit?.unitCode || unit;

        ivCache.set(id, { t: Date.now(), last: { ...last, unit } });
      } else {
        unit = last.unit || unit;
      }

      if (new Date(last.dateTime) < cutoff) return;

      const infoHtml = `
        <h1 class="section-title">${escapeHTML(site.station_nm)} (USGS #${id})</h1>
        <p><strong>Stage:</strong> ${escapeHTML(last.value)} ${escapeHTML(unit)}</p>
        <p><em>as of ${new Date(last.dateTime).toLocaleString()}</em></p>
      `;

      L.marker([lat, lon]).addTo(markerLayer).on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        activeType = 'usgs';
        activeId = id;
        currentMarkerData = { type: 'usgs', id, title: site.station_nm, lat, lon };
        showDetails(infoHtml, [lat, lon]);
      });
    });
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.error('Error loading USGS sites:', err);
    }
  }
}

// 9) Load custom markers
async function loadCustomMarkers() {
  customLayer.clearLayers();
  const markers = await (await fetch('/api/markers')).json();

  markers.forEach((m, i) => {
    const cat = normalizeCategory(m.category);
    const infoHtml = `
      <h1 class="section-title">${escapeHTML(m.title)}</h1>
      <p><strong>Category:</strong> ${escapeHTML(categoryLabel(cat))} ${categoryGlyph(cat)}</p>
      <p>${escapeHTML(m.description || '')}</p>
      <p><em>${new Date(m.timestamp).toLocaleString()}</em></p>
    `;

    L.marker([m.lat, m.lon], { icon: makeCategoryIcon(cat), title: m.title })
      .addTo(customLayer)
      .on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        activeType = 'custom'; activeId = i;
        currentMarkerData = { type: 'custom', index: i, title: m.title, lat: m.lat, lon: m.lon };
        showDetails(infoHtml, [m.lat, m.lon]);
      });
  });
}

// 10) Click to create new custom marker (guided popup)
map.off('click');
map.on('click', (e) => {
  const { lat, lng } = e.latlng;

  const title = prompt('Name this marker:');
  if (!title || !title.trim()) return;

  const defaultCat = 'misc';
  const popup = L.popup({ closeOnClick: false, autoClose: true })
    .setLatLng([lat, lng])
    .setContent(`
      <form class="mk-form" id="new-marker-form">
        <div><strong>Choose an icon:</strong></div>
        <div class="row">
          <label><input type="radio" name="category" value="plant"> 🌿 Plant</label>
          <label><input type="radio" name="category" value="history"> 🏛 History</label>
          <label><input type="radio" name="category" value="misc" checked> 📍 Misc</label>
        </div>
        <div><strong>Description</strong> <small>(be specific for future categorization)</small></div>
        <textarea name="description" placeholder="e.g. “Blackberry thicket; ripens late June. Easy bank access; watch for bees.”"></textarea>
        <div class="actions">
          <button type="button" id="mk-cancel">Cancel</button>
          <button type="submit">Save</button>
        </div>
      </form>
    `)
    .openOn(map);

  const container = popup.getElement();
  const form = container?.querySelector('#new-marker-form');
  const btnCancel = container?.querySelector('#mk-cancel');

  btnCancel?.addEventListener('click', () => { map.closePopup(popup); });

  form?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const category = normalizeCategory(fd.get('category') || defaultCat);
    const description = String(fd.get('description') || '').trim();

    const resp = await fetch('/api/markers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon: lng, title: title.trim(), description, category, userId })
    });
    const created = await resp.json().catch(() => null);

    map.closePopup(popup);
    await loadCustomMarkers();

    try {
      const all = await (await fetch('/api/markers')).json();
      let idx = all.findIndex(m => m.timestamp === created?.timestamp && m.lat === lat && m.lon === lng && m.title === title.trim());
      if (idx < 0) idx = all.length - 1;

      const cat = normalizeCategory(all[idx]?.category);
      const infoHtml = `
        <h1 class="section-title">${escapeHTML(all[idx]?.title || title.trim())}</h1>
        <p><strong>Category:</strong> ${escapeHTML(categoryLabel(cat))} ${categoryGlyph(cat)}</p>
        <p>${escapeHTML(all[idx]?.description || description)}</p>
        <p><em>${new Date(all[idx]?.timestamp || Date.now()).toLocaleString()}</em></p>
      `;
      activeType = 'custom'; activeId = idx;
      currentMarkerData = { type: 'custom', index: idx, title: all[idx]?.title || title.trim(), lat, lon: lng };
      showDetails(infoHtml, [lat, lng]);
    } catch {}
  });
});

// 11) Debounce viewport loads
function debounce(fn, d){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), d); }; }
map.on('moveend', debounce(() => { loadUSGSGages(); loadCustomMarkers(); }, 500));

L.control.layers(
  {}, // no base layers here
  { 'USGS Gages': markerLayer, 'Custom Markers': customLayer }
).addTo(map);


// 12) Initial load
loadUSGSGages();
loadCustomMarkers();
injectNasaCard();

// -----------------
// Optional: ad-hoc tester in console
// window.debugGeocodeAll = async (q) => {
//   const qn = normalizeUSQuery(q);
//   console.log('Testing:', qn);
//   try { primary.options.geocodingQueryParams = { countrycodes:'us', bounded:1, viewbox:map.getBounds().toBBoxString() }; } catch {}
//   console.log('Nominatim(bounded):', await primary.geocode(qn));
//   try { primary.options.geocodingQueryParams = { countrycodes:'us' }; } catch {}
//   console.log('Nominatim(unbounded):', await primary.geocode(qn));
//   if (photon) console.log('Photon:', await photon.geocode(qn));
//   console.log('Census:', await geocodeWithCensus(qn));
// };

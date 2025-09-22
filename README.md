# _Electric Gavinoe_
#### By Graceann Smith

####_Leaflet + Express app to explore USGS gages and add your own custom markers with a comfy sidebar and a “Perceptacle” tips thread. Includes handy server proxies (Wikipedia, US Census, Photon, OpenCage) so the browser doesn’t fight CORS.

---

##Stack

* _Client:** Vite, Leaflet, `leaflet-sidebar-v2`, `leaflet-control-geocoder`_
* _Server:** Node/Express (ESM), Helmet, compression, rate limiters_
* _Storage:** Simple JSON files for tips/markers_
* _Proxies:** Photon, US Census, Wikipedia, OpenCage (opt-in), what3words_
* _Build:** Vite static build served by Express in production_

---

## Prerequisites

**_Node:** **v20.x LTS** recommended  
  (this repo targets Node 20; Node 22 can break some transitive deps)
**_npm:** comes with Node
** _.env:** put your keys here (see below). **Do not commit this file.**

*-Optional (recommended): pin the project to Node 20 with nvm

**_```bash
**_echo "20" > .nvmrc
**_nvm install
**_nvm use
**_ ```

---

# Quick Start (Development)

```bash
## 1) Install deps
npm install

## 2) Create env file from template (then fill real values)
cp .env.example .env

## 3) Run the Express API (port 3000)
npm run dev:server

## 4) In a second terminal, run the Vite dev server (port 5173)
npm run dev:vite

## 5) Open the app (Vite dev)
open http://localhost:5173
In dev, the browser app runs on 5173 and proxies /api/* to the Express server on 3000 (see vite.config.js).

#Production

## Build the client to /dist
###npm run build

## Start the Express server (serves /dist on port 3000 by default)
###npm start

## Open:
###open http://localhost:3000

##Environment Variables
###Create .env in the project root. A template is provided in .env.example.

## Server
###PORT=3000
###NODE_ENV=development

## Optional: enables the /api/opencage proxy
###OPENCAGE_KEY=your-opencage-key-here

## Required for /api/3wa (what3words)
###W3W_API_KEY=your-what3words-key-here

## Optional: NASA key (client uses DEMO_KEY by default)
###NASA_API_KEY=your-nasa-key-here

#Project Structure

.
├─ client/                 # Vite app
│  ├─ index.html
│  ├─ src/main.js          # Leaflet app + UI
│  ├─ style.css, fonts.css
│  └─ (assets…)
├─ src/server.js           # Express API + proxies + static serving
├─ data/
│  ├─ markers.json         # created at runtime
│  └─ tips.json            # created at runtime
├─ public/uploads/tips/    # uploaded tip photos (created at runtime)
├─ dist/                   # production build output (generated)
├─ .env                    # your real secrets (not committed)
├─ .env.example            # template for contributors
├─ vite.config.js
└─ package.json

#Available Scripts
###npm run dev:server – start Express with nodemon on 3000
###npm run dev:vite – start Vite dev server on 5173
###npm run build – build client to /dist
###npm start – start Express in production mode (serves /dist)
##Optional one-liner dev script (needs concurrently):

###”dev”: "concurrently -n server,vite -c green,cyan \"npm:dev:server\" \"npm:dev:vite\""
Install helper:

###npm i -D concurrently

#Features
**_USGS gages within the current viewport (stage value with timestamp)
**_Custom markers: click map → name, pick category (🌿/🏛/📍), add description
**_Sidebar with draggable width, sticky title styling
**_Perceptacle (tips): add draft/published notes per marker (optional photo)
**_Search: smart geocoder (Nominatim bounded/unbounded → Photon → US Census (US only) → ArcGIS → optional OpenCage)
**_Explore: Wikipedia Nearby (proxied), iNaturalist observations (client-side)

#API (Server)
##Health
**_GET /health → { "ok": true }
##Markers
**_GET /api/markers → [{ lat, lon, title, description, category, timestamp }, …]
**_POST /api/markers###Body:###→ 201 Created
##PUT /api/markers###Body:###{ "index": 0, "lat": 36.1, "lon": -94.17, "title": "Updated", "description": "…", "category": "history" }
##DELETE /api/markers###Body:###{ "index": 0 }
###→ 204 No Content
#Tips
##Keys are implicit:
**_USGS: usgs:<siteId>
**_Custom marker: custom:<markerIndex>
**_GET /api/tips?siteId=07055660&viewer=<uuid> or ?markerIndex=0&viewer=<uuid>**_Returns published tips + your own drafts (if viewer matches the tip’s userId).
**_POST /api/tips###{ "siteId": "07055660", "text": "High today", "userId": "<uuid>", "photoUrl": null, "status": "draft" }
**_PUT /api/tips – update text and/or photoUrl by id or index
**_PUT /api/tips/publish###{ "siteId": "07055660", "id": "<tipId>", "userId": "<uuid>" }
**_DELETE /api/tips###{ "siteId": "07055660", "index": 2 }
###→ 204 No Content
#Tip Photos
**_POST /api/tip-photos (multipart, field photo) → { "url": "/uploads/tips/<file>" }__(Limit: 6 MB; images only (jpeg/png/webp/gif/heic/heif))
#Proxies (to avoid CORS & rate-limit politely)
**_GET /api/wikipedia/nearby?lat=..&lon=..&km=8&limit=20
**_GET /api/photon?... (passes through query params)
**_GET /api/census/oneline?address=...&benchmark=Public_AR_Current
**_GET /api/census/address?street=...&city=...&state=...&zip=...&benchmark=...
**_GET /api/opencage?q=...&limit=5 (requires OPENCAGE_KEY)
**_GET /api/3wa?lat=..&lon=.. (requires W3W_API_KEY)

#Development Notes
**_Dev vs Prod***_Dev UI at 5173, API at 3000. Prod serves static files from /dist at 3000.
**_Data persistence***_JSON files live in data/; great for local use. For multi-user/deploy, swap to a database.
**_Uploads***_Saved to public/uploads/tips/; served under /uploads/tips/....

#Troubleshooting
**_ECONNREFUSED for /api/... in Vite dev console**_Express isn’t running. Start it in another terminal:###npm run dev:server
**_Ensure vite.config.js has:###proxy: { '/api': 'http://localhost:3000', '/uploads': 'http://localhost:3000' }
**_NASA 429 Too Many Requests***_You’re using DEMO_KEY. Add NASA_API_KEY to .env and restart the server (and update /api/config if you expose the key).
**_Leaflet default marker icons missing in production***_Add near your Leaflet imports in client/src/main.js:###import L from 'leaflet';
###import 'leaflet/dist/leaflet.css';
###import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
###import markerIcon from 'leaflet/dist/images/marker-icon.png';
###import markerShadow from 'leaflet/dist/images/marker-shadow.png';

###L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow
});

**_L is not defined***_Ensure you import Leaflet via ESM (import L from 'leaflet') and the bundle is loading (no CDN race in Vite).
**_Cannot find module './helpers/merge-exports' (iconv-lite)***_Use Node 20.x LTS. If you’re on Node 22+, switch and reinstall deps:###nvm use 20
###rm -rf node_modules package-lock.json
###npm install
**_/api/config 500 in dev***_If that route was removed/changed, the client’s fetch('/api/config') fails. Restore it or guard the call (the client already .catch()es).

#Security & CSP
##Helmet sets a restrictive Content Security Policy. If you add new CDNs/APIs, extend:
**_script-src, style-src for CDNs
**_img-src for tiles/thumbnails
**_connect-src for new API hosts
**_See src/server.js → helmet({ contentSecurityPolicy }).

#Contributing
##PRs welcomed! Please:
**_Keep changes small and focused
**_Update .env.example if you add/remove configuration
**_Update this README for new features
##Git quick start

###git checkout -b feature/short-name
###git add .
###git commit -m "feat: short description"
###git push -u origin feature/short-name


#License
MIT

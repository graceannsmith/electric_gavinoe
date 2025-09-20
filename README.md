# Electric Gavinoe

Leaflet + Express app to explore USGS gages and custom markers with a comfy sidebar and “Perceptacle” tips.

## Stack
- Node/Express (ESM)
- Leaflet + leaflet-sidebar + leaflet-control-geocoder
- Simple JSON storage for tips/markers
- Proxies for Photon, US Census, Wikipedia, etc.
- Helmet, rate limiters, compression

## Local Setup
```bash
cp .env.example .env
npm install
npm start
# open http://localhost:3000

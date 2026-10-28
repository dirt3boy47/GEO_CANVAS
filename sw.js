/* GeoCanvas service worker: the app works offline after the first visit.
   App files: network first, so a new version shows as soon as it is online; the cached copy is used offline
   (or when the network takes more than 4 s).
   Queensland imagery tiles: cache-first from "gc-tiles" (filled by viewing or by "Save this area for offline use"). */
var SHELL = 'gc-shell-v10'; // GeoCanvas 2026-10-28.4
var ASSETS = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/proj4.js', 'vendor/jszip.min.js', 'vendor/togeojson.js', 'vendor/geotiff.js',
  'js/geo.js', 'js/ink.js', 'js/store.js', 'js/importers.js', 'js/exporters.js', 'js/app.js', 'js/draw.js', 'js/photos.js', 'js/panels.js', 'js/measure.js', 'js/cadastre.js', 'js/georef.js', 'js/cad.js', 'js/cloud.js',
  'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js'];
var TILE_HOST = 'spatial-img.information.qld.gov.au';
var MAX_TILES = 6000;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf('gc-shell-') === 0 && k !== SHELL; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
var puts = 0;
function trim(cache) {
  return cache.keys().then(function (ks) { if (ks.length <= MAX_TILES) return; return Promise.all(ks.slice(0, ks.length - MAX_TILES).map(function (k) { return cache.delete(k); })); });
}
self.addEventListener('fetch', function (e) {
  var req = e.request; if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin && /\/api\//.test(url.pathname)) return; // cloud sync: always live
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL).then(function (c) {
      var cached = function () { return c.match(req, { ignoreSearch: true }).then(function (hit) { return hit || c.match('index.html'); }); };
      var net = fetch(req).then(function (r) { if (r && r.ok && r.type === 'basic') c.put(req, r.clone()); return r; });
      return new Promise(function (resolve) {
        var done = false, finish = function (r) { if (!done && r) { done = true; resolve(r); } };
        var slow = setTimeout(function () { cached().then(finish); }, 4000);
        net.then(function (r) { clearTimeout(slow); finish(r); }, function () { clearTimeout(slow); cached().then(function (h) { finish(h || Response.error()); }); });
      });
    }));
    return;
  }
  if (url.hostname === TILE_HOST && /\/tile\//.test(url.pathname)) {
    e.respondWith(caches.open('gc-tiles').then(function (c) {
      return c.match(req.url).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (r) {
          if (r && r.ok && (r.type === 'cors' || r.type === 'basic')) { c.put(req.url, r.clone()); if (++puts % 200 === 0) trim(c); }
          return r;
        });
      });
    }));
  }
});

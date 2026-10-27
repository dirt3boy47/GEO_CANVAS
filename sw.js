/* GeoCanvas service worker: the app works offline after the first visit.
   App files: served from cache, refreshed in the background (new versions show on the next launch).
   Queensland imagery tiles: cache-first from "gc-tiles" (filled by viewing or by "Save this area for offline use"). */
var SHELL = 'gc-shell-v2';
var ASSETS = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/proj4.js', 'vendor/jszip.min.js', 'vendor/togeojson.js', 'vendor/geotiff.js',
  'js/geo.js', 'js/ink.js', 'js/store.js', 'js/importers.js', 'js/exporters.js', 'js/app.js', 'js/draw.js', 'js/panels.js', 'js/cloud.js'];
var TILE_HOST = 'spatial-img.information.qld.gov.au';
var MAX_TILES = 6000;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
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
      return c.match(req, { ignoreSearch: true }).then(function (hit) {
        var net = fetch(req).then(function (r) { if (r && r.ok && r.type === 'basic') c.put(req, r.clone()); return r; });
        if (hit) { e.waitUntil(net.catch(function () {})); return hit; }
        return net.catch(function () { return c.match('index.html'); });
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

/* GeoCanvas service worker: the app works offline after the first visit.
   App files: straight from this version's saved copy, so the app opens at once even on a weak signal. Every release
   changes SHELL below, so the browser installs the new service worker (fetching the new files) in the background and
   the page reloads into it (js/panels.js); files missing from the copy come from the network.
   Queensland imagery, lot-boundary and Map library tiles: saved offline areas ("gc-offline", never trimmed) first; imagery seen while
   browsing is kept in "gc-tiles" (trimmed to the newest tiles). Downloads for offline areas (cache: no-store) pass straight through. */
var SHELL = 'gc-shell-v26'; // GeoCanvas 2026-10-29.10
var ASSETS = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/proj4.js', 'vendor/jszip.min.js', 'vendor/togeojson.js', 'vendor/geotiff.js',
  'js/geo.js', 'js/ink.js', 'js/store.js', 'js/importers.js', 'js/exporters.js', 'js/app.js', 'js/draw.js', 'js/photos.js', 'js/cards.js', 'js/camera.js', 'js/register.js', 'js/panels.js', 'js/measure.js', 'js/cadastre.js', 'js/georef.js', 'js/geopdf.js', 'js/cad.js', 'js/library.js', 'js/mymaps.js', 'js/offline.js', 'js/ui.js', 'js/phone.js', 'js/cloud.js',
  'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js'];
var TILE_HOST = 'spatial-img.information.qld.gov.au', LOT_HOST = 'spatial-gis.information.qld.gov.au';
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
      var nav = req.mode === 'navigate';
      // pages: the saved './' (not 'index.html': the server redirects that to '/', and a redirected answer can't open a page)
      return c.match(nav ? './' : req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (r) { if (r && r.ok && r.type === 'basic' && !nav) c.put(req, r.clone()); return r; },
          function () { return nav ? c.match('./').then(function (h) { return h || Response.error(); }) : Response.error(); });
      });
    }));
    return;
  }
  // map images from ArcGIS servers (QLD imagery, lot boundaries, Map library services): saved offline areas first
  var img = url.hostname === TILE_HOST && /\/tile\//.test(url.pathname), lots = !img && /\/(MapServer|ImageServer)\/(export|exportImage|tile\/)/.test(url.pathname);
  if ((img || lots) && req.cache !== 'no-store') {
    e.respondWith(caches.open('gc-offline').then(function (o) { return o.match(req.url); }).then(function (saved) {
      if (saved) return saved;
      if (!img) return fetch(req);
      return caches.open('gc-tiles').then(function (c) {
        return c.match(req.url).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (r) {
            if (r && r.ok && (r.type === 'cors' || r.type === 'basic')) { c.put(req.url, r.clone()); if (++puts % 200 === 0) trim(c); }
            return r;
          });
        });
      });
    }));
  }
});

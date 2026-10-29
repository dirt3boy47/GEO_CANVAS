/* Replacement for the old "geo" Worker (geo.dirt3boy47.workers.dev), the first upload of GeoCanvas that never updates.
   Anyone opening the old address is sent to the live app, and phones that saved the old app for offline use get a
   service worker that clears the old copy and moves them across too.
   Deploy: Cloudflare dashboard › Workers & Pages › delete "geo" › Create › Start with Hello World › name it "geo" ›
   Deploy › Edit code › paste this file › Deploy. */
const NEW = 'https://geo-canvas.dirt3boy47.workers.dev';
const SW = `self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); })
    .then(function () { return self.registration.unregister(); })
    .then(function () { return self.clients.matchAll({ type: 'window' }); })
    .then(function (cs) { cs.forEach(function (c) { c.navigate('${NEW}/'); }); }));
});`;
export default {
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.endsWith('/sw.js')) return new Response(SW, { headers: { 'content-type': 'application/javascript', 'cache-control': 'no-store' } });
    return Response.redirect(NEW + u.pathname + u.search, 302);
  }
};

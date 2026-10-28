/* GeoCanvas web — offline maps. Snip an area of the map (drag a box, or draw freehand around a corridor) and its
   Queensland aerial imagery and lot boundaries are saved on this device, so the map works with no signal.
   Tiles go into the "gc-offline" cache: the service worker serves it first and never trims it (casual browsing uses
   "gc-tiles", which is trimmed). Saved areas belong to this device, not to a project; the list is in localStorage.
   Only Queensland Government services are saved (CC BY 4.0); Esri and OpenStreetMap terms do not allow bulk saving. */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, map = GC.map, $ = GC.$, esc = GC.esc;
  var CACHE = 'gc-offline', KEY = 'gc.offline', ZMIN = 10, MAX_TILES = 40000, BIG = 15000;
  var EST = { img: 22000, lots: 5000, svc: 15000 }; // typical bytes per tile, for the estimate before downloading
  var DETAIL = [[17, 'Suburb (about 1 m)'], [18, 'Street (about 0.5 m)'], [19, 'Site (about 0.25 m)'], [20, 'Maximum (about 0.15 m)']];

  // ---------- saved areas ----------
  function areas() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } }
  function saveAreas(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* storage full: tiles are still cached */ } }
  function putArea(a) { var list = areas().filter(function (x) { return x.id !== a.id; }); list.push(a); saveAreas(list); }

  // ---------- which tiles cover an area ----------
  /** Rows of tile columns at zoom z that touch the polygon [[lon,lat],…]: [{ y, spans: [[x0,x1],…] }]. */
  function tileRows(poly, z) {
    var n = Math.pow(2, z), P = poly.map(function (p) { var m = Geo.merc(p[0], p[1]); return [m[0] * n, m[1] * n]; });
    var y0 = Infinity, y1 = -Infinity;
    P.forEach(function (p) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
    var rows = [], clampX = function (x) { return Math.max(0, Math.min(n - 1, Math.floor(x))); };
    for (var j = Math.max(0, Math.floor(y0)); j <= Math.min(n - 1, Math.floor(y1)); j++) {
      var spans = [], cross = [], mid = j + 0.5;
      for (var i = 0, k = P.length - 1; i < P.length; k = i++) {
        var a = P[k], b = P[i];
        // the part of this edge inside the row band: those tiles hold the boundary
        var lo = Math.max(j, Math.min(a[1], b[1])), hi = Math.min(j + 1, Math.max(a[1], b[1]));
        if (lo <= hi) {
          var xs = a[1] === b[1] ? [a[0], b[0]] : [lo, hi].map(function (y) { return a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]); });
          spans.push([clampX(Math.min(xs[0], xs[1])), clampX(Math.max(xs[0], xs[1]))]);
        }
        if ((a[1] > mid) !== (b[1] > mid)) cross.push(a[0] + (b[0] - a[0]) * (mid - a[1]) / (b[1] - a[1]));
      }
      cross.sort(function (p, q) { return p - q; });
      for (i = 0; i + 1 < cross.length; i += 2) spans.push([clampX(cross[i]), clampX(cross[i + 1])]); // inside
      if (!spans.length) continue;
      spans.sort(function (p, q) { return p[0] - q[0]; });
      var merged = [spans[0].slice()];
      spans.slice(1).forEach(function (s) { var m = merged[merged.length - 1]; if (s[0] <= m[1] + 1) m[1] = Math.max(m[1], s[1]); else merged.push(s.slice()); });
      rows.push({ y: j, spans: merged });
    }
    return rows;
  }
  function countTiles(poly, z0, z1) {
    var c = 0;
    for (var z = z0; z <= z1; z++) tileRows(poly, z).forEach(function (r) { r.spans.forEach(function (s) { c += s[1] - s[0] + 1; }); });
    return c;
  }
  var SOURCES = {
    img: function (z, x, y) { return GC.QLD_TILES.replace('{z}', z).replace('{y}', y).replace('{x}', x); },
    lots: function (z, x, y) { return GC.cadastre.tileUrl({ x: x, y: y, z: z }); }
  };
  function sourcesOf(a) { return a.lots && GC.cadastre ? ['img', 'lots'] : ['img']; }
  function urlsOf(a) {
    var out = [];
    sourcesOf(a).forEach(function (s) {
      for (var z = ZMIN; z <= a.zmax; z++) tileRows(a.poly, z).forEach(function (r) {
        r.spans.forEach(function (sp) { for (var x = sp[0]; x <= sp[1]; x++) out.push(SOURCES[s](z, x, r.y)); });
      });
    });
    // map services from the Map library (geology, topography…), up to their own deepest zoom
    if (GC.library) (a.services || []).forEach(function (s) {
      for (var z = ZMIN; z <= Math.min(a.zmax, s.maxNative); z++) tileRows(a.poly, z).forEach(function (r) {
        r.spans.forEach(function (sp) { for (var x = sp[0]; x <= sp[1]; x++) out.push(GC.library.tileUrl(s, z, x, r.y)); });
      });
    });
    return out;
  }
  function estimate(a) {
    var n = countTiles(a.poly, ZMIN, a.zmax), lots = a.lots ? n : 0, svc = 0;
    (a.services || []).forEach(function (s) { svc += countTiles(a.poly, ZMIN, Math.min(a.zmax, s.maxNative)); });
    return { tiles: n + lots + svc, bytes: n * EST.img + lots * EST.lots + svc * EST.svc };
  }
  function mb(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB'; }
  function num(n) { return n.toLocaleString(); }

  // ---------- downloading ----------
  var job = null;
  function fetchTile(u) {
    // no-store: the service worker lets it through to the network instead of answering from its own caches
    var get = function () { return fetch(u, { mode: 'cors', cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r; }); };
    return get().catch(function () { return new Promise(function (r) { setTimeout(r, 800); }).then(get); });
  }
  /** Saves every tile of the area; refresh re-downloads tiles already saved. */
  function download(a, refresh, onProgress) {
    var urls = urlsOf(a), cancelled = false, started = Date.now();
    job = { area: a, done: 0, ok: 0, fail: 0, bytes: 0, total: urls.length, cancel: function () { cancelled = true; } };
    var j = job, i = 0, lastSave = 0;
    var record = function () { a.saved = j.ok; a.tiles = j.total; a.failed = j.fail; a.bytes = (refresh ? 0 : a.bytesBefore || 0) + j.bytes; a.updated = Date.now(); a.complete = j.ok === j.total; putArea(a); };
    a.bytesBefore = refresh ? 0 : a.bytes || 0;
    return caches.open(CACHE).then(function (cache) {
      var one = function (u) {
        return (refresh ? Promise.resolve(null) : cache.match(u)).then(function (hit) {
          if (hit) { j.ok++; return; }
          return fetchTile(u).then(function (r) {
            var type = r.headers.get('Content-Type') || 'image/png';
            return r.blob().then(function (b) { j.bytes += b.size; return cache.put(u, new Response(b, { headers: { 'Content-Type': type } })); });
          }).then(function () { j.ok++; }, function () { j.fail++; });
        });
      };
      var worker = function () {
        if (cancelled || i >= urls.length) return Promise.resolve();
        return one(urls[i++]).then(function () {
          j.done++; if (onProgress) onProgress(j);
          if (j.done - lastSave >= 200) { lastSave = j.done; record(); }
          return worker();
        });
      };
      return Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    }).then(function () {
      if (j.ok || areas().some(function (x) { return x.id === a.id; })) record();
      job = null; j.cancelled = cancelled; j.seconds = (Date.now() - started) / 1000;
      applyOffline();
      return j;
    }, function (e) { job = null; throw e; });
  }
  /** Removes the area's tiles that no other saved area also uses. */
  function removeArea(a) {
    var keep = {};
    areas().forEach(function (x) { if (x.id !== a.id) urlsOf(x).forEach(function (u) { keep[u] = 1; }); });
    saveAreas(areas().filter(function (x) { return x.id !== a.id; }));
    var drop = urlsOf(a).filter(function (u) { return !keep[u]; });
    return caches.open(CACHE).then(function (c) {
      var k = 0, step = function () {
        if (k >= drop.length) return Promise.resolve();
        var part = drop.slice(k, k += 200);
        return Promise.all(part.map(function (u) { return c.delete(u); })).then(step);
      };
      return step();
    }).then(function () { applyOffline(); });
  }

  // ---------- working offline ----------
  // With no internet, imagery is drawn from the deepest zoom that was saved (enlarged), instead of blank tiles.
  var switched = null;
  function savedZoom() { var z = 0; areas().forEach(function (a) { if (a.saved) z = Math.max(z, a.zmax); }); return z; }
  function tune(l) {
    if (!(l instanceof L.TileLayer) || !(l._url === GC.QLD_TILES || l._gcService || (GC.cadastre && l === GC.cadastre.tiles))) return;
    if (l._gcNative == null) l._gcNative = l.options.maxNativeZoom;
    var z = savedZoom(), want = navigator.onLine === false && z ? Math.min(l._gcNative, z) : l._gcNative;
    if (l.options.maxNativeZoom !== want) { l.options.maxNativeZoom = want; if (l._map) l.redraw(); }
  }
  function applyOffline() {
    map.eachLayer(tune);
    var key = $('basemap').value, off = navigator.onLine === false;
    if (off && savedZoom() && !/^qld|^none$/.test(key)) {
      switched = key; GC.setBasemap('qld', { fallback: true });
      GC.toast('No internet: showing your saved offline imagery (QLD aerial).', null, 6000);
    } else if (!off && switched) {
      var back = switched; switched = null;
      if ($('basemap').value === 'qld') GC.setBasemap(back, { fallback: true });
    }
  }
  map.on('layeradd', function (e) { tune(e.layer); });
  global.addEventListener('online', applyOffline);
  global.addEventListener('offline', applyOffline);

  // ---------- snipping: drag a box or draw around the area ----------
  var snip = null, sel = null;
  function startSnip(mode) {
    if (job) { GC.toast('A download is still running.', 'warn'); return; }
    clearSelection();
    if (GC.mode === 'draw') GC.setMode('nav');
    if (GC.measure && GC.measure.isOn()) GC.measure.close();
    mode = mode || 'box';
    var el = document.createElement('div'); el.id = 'snip';
    el.innerHTML = '<canvas></canvas><div id="snip-bar" class="panel"><span id="snip-msg"></span>' +
      '<div class="seg"><button data-m="box">Box</button><button data-m="free">Freehand</button></div>' +
      '<button class="btn" data-a="cancel">Cancel</button></div>';
    document.body.appendChild(el); document.body.classList.add('snipping');
    var cv = el.querySelector('canvas'), x = cv.getContext('2d'), dpr = Math.min(2, global.devicePixelRatio || 1), pts = [], down = false;
    var size = function () { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px'; paint(); };
    var setMode = function (m) {
      mode = m; pts = []; paint();
      [].forEach.call(el.querySelectorAll('.seg button'), function (b) { b.classList.toggle('on', b.getAttribute('data-m') === m); });
      el.querySelector('#snip-msg').textContent = m === 'box' ? 'Drag a box over the area to save' : 'Draw around the area to save (e.g. along the pipeline)';
    };
    var shape = function () {
      if (mode === 'box') { if (pts.length < 2) return null; var a = pts[0], b = pts[pts.length - 1]; return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]; }
      return pts.length > 2 ? pts : null;
    };
    function paint() {
      x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, innerWidth, innerHeight);
      x.fillStyle = 'rgba(8, 14, 12, 0.48)'; x.fillRect(0, 0, innerWidth, innerHeight);
      var s = shape(); if (!s) return;
      x.beginPath(); s.forEach(function (p, i) { if (i) x.lineTo(p[0], p[1]); else x.moveTo(p[0], p[1]); }); x.closePath();
      x.globalCompositeOperation = 'destination-out'; x.fillStyle = '#000'; x.fill(); x.globalCompositeOperation = 'source-over';
      x.lineWidth = 2; x.strokeStyle = '#fff'; x.setLineDash([7, 5]); x.stroke(); x.setLineDash([]);
    }
    cv.addEventListener('pointerdown', function (e) { down = true; pts = [[e.clientX, e.clientY]]; try { cv.setPointerCapture(e.pointerId); } catch (er) { /* old Safari */ } e.preventDefault(); });
    cv.addEventListener('pointermove', function (e) {
      if (!down) return;
      var p = [e.clientX, e.clientY], last = pts[pts.length - 1];
      if (mode === 'box') pts[1] = p; else if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) > 5) pts.push(p);
      paint();
    });
    var up = function () {
      if (!down) return; down = false;
      var s = shape(), xs = s ? s.map(function (p) { return p[0]; }) : [0], ys = s ? s.map(function (p) { return p[1]; }) : [0];
      if (!s || Math.max.apply(null, xs) - Math.min.apply(null, xs) < 24 || Math.max.apply(null, ys) - Math.min.apply(null, ys) < 24) { pts = []; paint(); return; }
      if (s.length > 300) { var k = s.length / 300; s = s.filter(function (p, i) { return Math.floor(i / k) !== Math.floor((i - 1) / k); }); }
      var r = map.getContainer().getBoundingClientRect();
      var poly = s.map(function (p) { var ll = map.containerPointToLatLng([p[0] - r.left, p[1] - r.top]); return [+ll.lng.toFixed(6), +ll.lat.toFixed(6)]; });
      endSnip(); showSelection(poly, mode);
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    el.querySelector('[data-a=cancel]').onclick = function () { endSnip(); };
    [].forEach.call(el.querySelectorAll('.seg button'), function (b) { b.onclick = function () { setMode(b.getAttribute('data-m')); }; });
    global.addEventListener('resize', size);
    snip = { el: el, size: size };
    setMode(mode); size();
  }
  function endSnip() {
    if (!snip) return;
    global.removeEventListener('resize', snip.size);
    snip.el.parentNode.removeChild(snip.el); snip = null; document.body.classList.remove('snipping');
  }

  // ---------- the selection on the map, and the save card ----------
  function clearSelection() {
    if (!sel) return;
    sel.layers.forEach(function (l) { map.removeLayer(l); });
    if (sel.panel.parentNode) sel.panel.parentNode.removeChild(sel.panel);
    sel = null;
  }
  function maskOf(poly) {
    var world = [[-85, -360], [85, -360], [85, 360], [-85, 360]], hole = poly.map(function (p) { return [p[1], p[0]]; });
    return [L.polygon([world, hole], { stroke: false, fillColor: '#081410', fillOpacity: 0.45, interactive: false }),
      L.polygon(hole, { color: '#fff', weight: 2, dashArray: '7 5', fill: false, interactive: false })];
  }
  function showSelection(poly, mode) {
    var n = areas().length + 1, zDefault = 19;
    var a = { id: 'oa' + Date.now().toString(36), name: 'Offline area ' + n, poly: poly, shape: mode, zmax: zDefault, lots: true, created: Date.now() };
    var svcs = GC.library ? GC.library.visibleServices() : []; // maps from the Map library that are showing
    var panel = document.createElement('div'); panel.id = 'offline-panel'; panel.className = 'panel pop';
    panel.innerHTML = '<div class="pop-title">Save for offline use <button class="ib" data-a="x" title="Close" aria-label="Close">&times;</button></div>' +
      '<label class="field">Name<input type="text" id="off-name"></label>' +
      '<label class="field">Detail<select id="off-z">' + DETAIL.map(function (d) { return '<option value="' + d[0] + '"' + (d[0] === zDefault ? ' selected' : '') + '>' + d[1] + '</option>'; }).join('') + '</select></label>' +
      '<label class="opt"><input type="checkbox" id="off-lots" checked> Lot boundaries (QLD cadastre)</label>' +
      svcs.map(function (s, i) { return '<label class="opt"><input type="checkbox" data-svc="' + i + '" checked> ' + esc(s.name) + '</label>'; }).join('') +
      '<div id="off-est"></div><div id="off-prog" hidden><div class="off-bar"><i></i></div><span></span></div>' +
      '<p class="hint">Saves Queensland aerial imagery (© State of Queensland, CC BY 4.0) on this device. Other basemaps can’t be saved: their terms don’t allow it.</p>' +
      '<div class="row-btns"><button class="btn" data-a="redraw">Redraw</button><button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="go">Download</button></div>';
    document.body.appendChild(panel);
    var q = function (s) { return panel.querySelector(s); };
    sel = { area: a, layers: maskOf(poly), panel: panel };
    sel.layers.forEach(function (l) { l.addTo(map); });
    q('#off-name').value = a.name;
    var est = null;
    var update = function () {
      a.zmax = +q('#off-z').value; a.lots = q('#off-lots').checked;
      a.services = svcs.filter(function (s, i) { return q('[data-svc="' + i + '"]').checked; }); est = estimate(a);
      var too = est.tiles > MAX_TILES;
      q('#off-est').innerHTML = too ? '<b class="fail">Too big: ' + num(est.tiles) + ' tiles.</b> Choose less detail or a smaller area.' :
        '<b>About ' + mb(est.bytes) + '</b> · ' + num(est.tiles) + ' tiles' + (est.tiles > BIG ? '<br>Large download: use Wi-Fi.' : '');
      q('[data-a=go]').disabled = too;
      if (!too && navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (s) {
        if (s.quota && s.quota - s.usage < est.bytes * 1.2) q('#off-est').innerHTML += '<br><b class="fail">Not enough storage left for GeoCanvas (' + mb(s.quota - s.usage) + ' free).</b>';
      }, function () {});
    };
    q('#off-z').onchange = update; q('#off-lots').onchange = update; [].forEach.call(panel.querySelectorAll('[data-svc]'), function (c) { c.onchange = update; }); update();
    var close = function () { if (job) return; clearSelection(); };
    q('[data-a=x]').onclick = close; q('[data-a=cancel]').onclick = function () { if (job) { job.cancel(); return; } close(); };
    q('[data-a=redraw]').onclick = function () { startSnip(mode); };
    q('[data-a=go]').onclick = function () {
      a.name = q('#off-name').value.trim() || a.name;
      run(a, false, panel);
    };
  }
  /** Runs a download with progress in the card (when given) or in a toast-sized card of its own. */
  function run(a, refresh, panel) {
    if (job) { GC.toast('A download is already running.', 'warn'); return Promise.resolve(); }
    if (!global.caches) { GC.toast('This browser cannot store maps offline.', 'err'); return Promise.resolve(); }
    if (!panel) {
      clearSelection();
      panel = document.createElement('div'); panel.id = 'offline-panel'; panel.className = 'panel pop';
      panel.innerHTML = '<div class="pop-title">' + esc(a.name) + '</div><div id="off-prog"><div class="off-bar"><i></i></div><span></span></div><div class="row-btns"><button class="btn" data-a="cancel">Stop</button></div>';
      document.body.appendChild(panel);
      panel.querySelector('[data-a=cancel]').onclick = function () { if (job) job.cancel(); };
      sel = { area: a, layers: maskOf(a.poly), panel: panel }; sel.layers.forEach(function (l) { l.addTo(map); });
    }
    var q = function (s) { return panel.querySelector(s); };
    [].forEach.call(panel.querySelectorAll('input, select, [data-a=go], [data-a=redraw], [data-a=x]'), function (e) { e.disabled = true; });
    if (q('[data-a=cancel]')) q('[data-a=cancel]').textContent = 'Stop';
    q('#off-prog').hidden = false;
    var bar = q('.off-bar i'), txt = q('#off-prog span');
    return download(a, refresh, function (j) {
      bar.style.width = (100 * j.done / j.total).toFixed(1) + '%';
      txt.textContent = (refresh ? 'Updating' : 'Saving') + '… ' + num(j.done) + ' of ' + num(j.total) + ' tiles' + (j.bytes ? ' · ' + mb(j.bytes) : '') + (j.fail ? ' · ' + num(j.fail) + ' failed' : '');
    }).then(function (j) {
      clearSelection();
      if (!j.ok) GC.toast('Nothing could be saved. Check the internet connection (the Queensland imagery service must be reachable).', 'err', 9000);
      else if (j.cancelled) GC.toast('Stopped. “' + a.name + '” is partly saved; tap Resume in Offline maps to finish it.', 'warn', 8000);
      else GC.toast('“' + a.name + '” is saved for offline use (' + num(j.ok) + ' tiles, about ' + mb(a.bytes || j.bytes) + ').' + (j.fail ? ' ' + num(j.fail) + ' tiles failed: tap Resume in Offline maps to retry them.' : ''), j.fail ? 'warn' : null, 8000);
    }, function (e) { clearSelection(); GC.toast('Could not save the map: ' + e.message, 'err', 8000); });
  }

  // ---------- the Offline maps list ----------
  var flash = null;
  function showArea(a) {
    if (flash) { map.removeLayer(flash); clearTimeout(flash.t); }
    flash = L.polygon(a.poly.map(function (p) { return [p[1], p[0]]; }), { color: '#3fbf96', weight: 3, fillOpacity: 0.08, interactive: false }).addTo(map);
    map.fitBounds(flash.getBounds(), { padding: [40, 40] });
    var f = flash; f.t = setTimeout(function () { if (flash === f) { map.removeLayer(f); flash = null; } }, 8000);
  }
  function open() {
    var list = areas().sort(function (p, q) { return (q.updated || q.created) - (p.updated || p.created); });
    var label = function (z) { var d = DETAIL.filter(function (x) { return x[0] === z; })[0]; return d ? d[1].replace(/ \(.*/, '') : 'zoom ' + z; };
    var rows = list.map(function (a) {
      var when = new Date(a.updated || a.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      return '<div class="off-row" data-id="' + esc(a.id) + '"><div class="off-txt"><b>' + esc(a.name) + '</b><small>' + label(a.zmax) + ' detail' + (a.lots ? ' + lot boundaries' : '') + ((a.services || []).length ? ' + ' + a.services.map(function (s) { return esc(s.name); }).join(', ') : '') +
        ' · ' + num(a.saved || 0) + ' tiles · about ' + mb(a.bytes || 0) + ' · ' + when + (a.complete ? '' : ' · <span class="fail">incomplete</span>') + '</small></div>' +
        '<button class="btn" data-a="show">Show</button><button class="btn" data-a="upd">' + (a.complete ? 'Update' : 'Resume') + '</button><button class="btn" data-a="del" title="Delete" aria-label="Delete"><svg><use xlink:href="#i-trash"/></svg></button></div>';
    }).join('');
    GC.modal('<h2>Offline maps</h2><p class="sub">Save aerial imagery and lot boundaries for the areas you work in, so the map works with no signal. Saved on this device only.</p>' +
      (rows ? '<div class="list">' + rows + '</div>' : '<p class="hint">No saved areas yet. Tap <b>Select an area</b>, then drag a box over the map (or draw around a corridor).</p>') +
      '<p class="hint" id="off-store"></p>' +
      '<div class="actions"><button class="btn" data-a="close">Close</button><button class="btn" data-a="free">Draw freehand</button><button class="btn primary" data-a="new">Select an area</button></div>',
      function (el, close) {
        el.querySelector('[data-a=close]').onclick = close;
        el.querySelector('[data-a=new]').onclick = function () { close(); startSnip('box'); };
        el.querySelector('[data-a=free]').onclick = function () { close(); startSnip('free'); };
        [].forEach.call(el.querySelectorAll('.off-row'), function (row) {
          var a = list.filter(function (x) { return x.id === row.getAttribute('data-id'); })[0];
          row.querySelector('[data-a=show]').onclick = function () { close(); showArea(a); };
          row.querySelector('[data-a=upd]').onclick = function () { close(); map.fitBounds(L.polygon(a.poly.map(function (p) { return [p[1], p[0]]; })).getBounds(), { padding: [40, 40] }); run(a, a.complete); };
          row.querySelector('[data-a=del]').onclick = function () {
            close();
            GC.confirm('Delete “' + a.name + '”?', 'Its saved imagery is removed from this device (tiles also used by another saved area are kept).', 'Delete', true).then(function (ok) {
              if (ok) removeArea(a).then(function () { GC.toast('“' + a.name + '” deleted.'); });
            });
          };
        });
        var st = el.querySelector('#off-store');
        if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (e) { st.textContent = 'GeoCanvas uses ' + mb(e.usage) + ' on this device (about ' + mb(Math.max(0, e.quota - e.usage)) + ' free for it). Add GeoCanvas to the Home Screen so iOS keeps saved maps.'; }, function () {});
      });
  }

  $('btn-offline').onclick = open;
  setTimeout(applyOffline, 0);
  GC.offline = { open: open, select: startSnip, areas: areas, estimate: estimate, urlsOf: urlsOf, tileRows: tileRows, countTiles: countTiles, download: download, remove: removeArea, run: run };
})(window);

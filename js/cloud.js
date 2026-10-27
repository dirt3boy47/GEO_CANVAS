/* GeoCanvas web — cloud sync with the team's GeoCanvas Worker (worker/index.js, Cloudflare D1).
   The iPad's own storage (IndexedDB) stays the working copy, so everything still works offline; the cloud
   is a shared copy that every device with the team passcode merges with.

   Cloud model: a project is a manifest {meta, order, layers: {layerId: hash}, files, blobs}. Layer data is
   stored as content-addressed blobs; drawings, GPS tracks and waypoints are split into "packs" of items with
   boundaries chosen by item id, so a new stroke re-uploads one small pack, not the whole layer.

   Merging: p.cloud remembers the last synced state (revision plus hashes per layer, per item). On a sync the
   local and cloud versions are compared with that base, three ways: a side that did not change takes the
   other side; when both changed the same drawing/track/waypoint layer, items are merged one by one (strokes
   added on two iPads are both kept); for other layers, and for the same item edited on both, this device wins. */
(function (global) {
  'use strict';
  var GC = global.GC, Store = global.Store, Ink = global.Ink;
  var $ = GC.$, esc = GC.esc;

  // ---------- hashing (cyrb53, two lanes → 106 bits, synchronous so merges need no awaits) ----------
  function cyrb(str, seed) {
    var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (var i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  function pad14(n) { var s = n.toString(16); while (s.length < 14) s = '0' + s; return s; }
  function hash(str) { return pad14(cyrb(str, 1)) + pad14(cyrb(str, 2)); }

  // ---------- layer analysis ----------
  // Layers whose content is a list of items with stable keys: merged item by item and split into packs.
  var COLL = {
    drawing: { f: 'items', key: function (it) { return it.id; }, clean: function (it) { return Ink.stripCache(it); } },
    track: { f: 'tracks', key: function (t) { return 's' + t.started; }, clean: function (t) { return { name: t.name, points: t.points, distance: t.distance, started: t.started }; } },
    waypoints: { f: 'waypoints', key: function (w) { return w.time != null ? 't' + w.time : 'j' + hash(JSON.stringify(w)); }, clean: function (w) { return w; } }
  };
  var linfo = new WeakMap(), icache = new WeakMap(), gcache = new WeakMap(), dirtyGen = 0;
  // Imported GIS geometry is stored as its own blob, so showing/hiding placemarks or restyling re-sends only a few bytes.
  function geoHash(g) { var h = gcache.get(g); if (!h) { h = hash(JSON.stringify(g)); gcache.set(g, h); } return h; }
  // Plan and GeoTIFF images likewise: changing opacity must not re-send the picture.
  var BIG = { vector: 'geojson', raster: 'dataURL' }, strHash = {};
  function bigHash(l) {
    var v = l[BIG[l.kind]]; if (v == null) return null;
    if (typeof v !== 'string') return geoHash(v);
    var k = v.length + ':' + v.slice(-64); if (!strHash[k]) strHash[k] = hash(v); return strHash[k];
  }
  function bigText(l) { var v = l[BIG[l.kind]]; return typeof v === 'string' ? v : JSON.stringify(v); }
  function itemHash(spec, it) { var h = icache.get(it); if (!h) { h = hash(JSON.stringify(spec.clean(it))); icache.set(it, h); } return h; }
  function propsOf(l) { var spec = COLL[l.kind], o = {}; for (var k in l) if (k !== '_leaflet' && (!spec || k !== spec.f) && k !== BIG[l.kind]) o[k] = l[k]; return o; }
  /** {h, p, spec, keys, ih, packs:[{h,a,b}]} for a layer; cached until the layer is marked dirty. */
  function info(l) {
    var c = linfo.get(l); if (c) return c;
    var spec = COLL[l.kind], pj = JSON.stringify(propsOf(l));
    c = { p: hash(pj), spec: spec || null };
    if (spec) {
      var arr = l[spec.f] || [], start = 0;
      c.keys = arr.map(spec.key); c.ih = arr.map(function (it) { return itemHash(spec, it); }); c.packs = [];
      for (var i = 0; i < arr.length; i++) {
        if (i === arr.length - 1 || i - start >= 63 || cyrb(c.keys[i], 7) % 12 === 0) { c.packs.push({ h: hash(c.ih.slice(start, i + 1).join(',')), a: start, b: i + 1 }); start = i + 1; }
      }
      c.h = hash(c.p + '|' + spec.f + '|' + c.packs.map(function (x) { return x.h; }).join(','));
    } else if (BIG[l.kind] && l[BIG[l.kind]] != null) { c.gh = bigHash(l); c.h = hash(c.p + '|geo|' + c.gh); }
    else c.h = c.p;
    linfo.set(l, c);
    return c;
  }
  function baseEntry(l) {
    var c = info(l), e = { h: c.h, p: c.p };
    if (c.spec) { e.k = {}; c.keys.forEach(function (k, i) { e.k[k] = c.ih[i]; }); }
    return e;
  }
  function layerBlob(l) {
    var c = info(l), o = { v: 1, props: propsOf(l) };
    if (c.spec) { o.coll = c.spec.f; o.packs = c.packs.map(function (x) { return x.h; }); }
    if (c.gh) o.geo = c.gh;
    return JSON.stringify(o);
  }
  function packBlob(l, pk) { var c = info(l); return JSON.stringify(l[c.spec.f].slice(pk.a, pk.b).map(c.spec.clean)); }

  // Keep caches honest: anything that changes a layer goes through GC.markDirty (that is also what saves it locally).
  var origMarkDirty = GC.markDirty, origMarkAll = GC.markAllDirty;
  GC.markDirty = function (lid, soon) {
    if (lid) {
      var l = GC.layerById(lid);
      if (l) { linfo.delete(l); if (l.kind !== 'drawing' && COLL[l.kind]) (l[COLL[l.kind].f] || []).forEach(function (it) { icache.delete(it); }); }
    }
    origMarkDirty(lid, soon);
    dirtyGen++;
    if (GC.project && on()) { pending(GC.project.id, true); if (lid && !running) setStatus('syncing'); schedule(2000); }
  };
  GC.markAllDirty = function () { linfo = new WeakMap(); icache = new WeakMap(); origMarkAll(); };

  // ---------- settings, status ----------
  function cfg() { return GC.settings.cloud || {}; }
  function on() { return !!cfg().key; }
  var status = { state: 'off', at: 0, msg: '' };
  function hhmm(t) { return new Date(t).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }); }
  function waiting() { return Object.keys(pendingSet()).length; }
  /** What the cloud button, the title line and the Team screen say right now. */
  function describe() {
    if (!on()) return { cls: 'off', short: 'Not in a team', long: 'This iPad is not in a team yet, so projects are only on this iPad. Join your team to save them to the cloud.' };
    var n = waiting();
    switch (status.state) {
      case 'syncing': return { cls: 'busy', short: 'Saving…', long: 'Saving to the cloud…' };
      case 'offline': return { cls: 'warn', short: 'Offline', long: n ? 'Offline. Changes to ' + n + ' project' + (n > 1 ? 's are' : ' are') + ' kept on this iPad and upload by themselves when the internet is back.' : 'Offline. Everything was saved before the connection dropped.' };
      case 'error': return { cls: 'err', short: 'Not saved', long: 'Not saved to the cloud: ' + status.msg };
      case 'skip': return { cls: 'warn', short: 'Not in cloud', long: 'This project was removed from the team cloud on another device. Projects › Upload again to share it again.' };
      case 'ok': return { cls: 'ok', short: 'Saved ' + hhmm(status.at), long: 'All changes saved to the cloud at ' + hhmm(status.at) + '.' };
      default: return { cls: 'idle', short: 'Ready', long: 'Connected to the team cloud. Changes save by themselves.' };
    }
  }
  function setStatus(state, msg) {
    status.state = state; status.msg = msg || ''; if (state === 'ok') status.at = Date.now();
    var d = describe();
    var el = $('cloud-status'); if (el) { el.textContent = on() ? ' · ☁ ' + (d.cls === 'ok' ? 'In cloud' : d.short) : ''; el.className = d.cls === 'err' ? 'err' : ''; el.title = d.long; }
    var b = $('btn-cloud'); if (b) { b.className = 'ib cloud-btn ' + d.cls; b.title = d.long; b.setAttribute('aria-label', 'Team and cloud: ' + d.short); }
    var pt = $('proj-cloud-status'); if (pt) pt.textContent = d.long;
    var tm = $('tm-status'); if (tm) { tm.textContent = d.long; tm.className = 'tm-status ' + d.cls; }
  }
  function pendingSet() { try { return JSON.parse(localStorage.getItem('gc.cloudPending') || '{}'); } catch (e) { return {}; } }
  function pending(id, v) {
    var s = pendingSet(); if (!!s[id] === v) return;
    if (v) s[id] = 1; else delete s[id];
    try { localStorage.setItem('gc.cloudPending', JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  // ---------- API ----------
  function api(method, path, body, opts) {
    opts = opts || {};
    var o = { method: method, headers: { 'X-GC-Key': opts.key || cfg().key || '' } };
    if (!opts.cacheable) o.cache = 'no-store';
    if (body != null) {
      if (typeof body === 'string') { o.body = body; o.headers['Content-Type'] = 'text/plain;charset=utf-8'; } else { o.body = JSON.stringify(body); o.headers['Content-Type'] = 'application/json'; }
    }
    var ctl = global.AbortController ? new AbortController() : null, timer = null;
    if (ctl) { o.signal = ctl.signal; timer = setTimeout(function () { ctl.abort(); }, opts.timeout || 60000); }
    return fetch('api/' + path, o).then(function (r) {
      clearTimeout(timer);
      if (opts.text && r.ok) return r.text();
      var ct = r.headers.get('Content-Type') || '';
      if (ct.indexOf('application/json') < 0) { var e0 = new Error(r.status === 404 ? 'Cloud sync is not available at this address (it needs the GeoCanvas Cloudflare Worker).' : 'Cloud error ' + r.status + '.'); e0.status = r.status; throw e0; }
      return r.json().then(function (j) {
        if (r.ok) return j;
        if (r.status === 409 && opts.conflict) return { conflict: j };
        var e = new Error(j.error || ('Cloud error ' + r.status)); e.status = r.status; e.retry = !!j.retry; throw e;
      });
    }, function (e) { clearTimeout(timer); var n = new Error('No connection to the cloud.'); n.offline = true; n.cause = e; throw n; });
  }
  function getRemote(id) { return api('GET', 'projects/' + id).catch(function (e) { if (e.status === 404 && !/not available/.test(e.message)) return null; throw e; }); }
  function getBlob(pid, h) { return api('GET', 'projects/' + pid + '/blobs/' + h, null, { text: true, cacheable: true }); }

  function abToB64(buf) { var u8 = new Uint8Array(buf), s = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  function b64ToAb(b) { var s = atob(b), u8 = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8.buffer; }
  function fileB64(d) { return abToB64(d instanceof ArrayBuffer ? d : new ArrayBuffer(0)); }

  var EMPTY = { layers: {}, order: [], meta: {}, files: {} };
  var META = ['name', 'notes', 'basemap'];
  var fileCache = {}; // "pid:lid" → [{n, h}] (imported source files never change for a layer)
  var photoHash = {}; // "pid:photoId" → blob hash (a photo never changes once taken)
  function photoRefs(layers) { return GC.photos ? GC.photos.refsIn(layers.filter(Boolean)) : {}; }

  /** Downloads remote layers the merge may need, and hashes local source files not yet known. */
  function prefetch(p, base, man) {
    var pre = { remote: {} }, B = base || EMPTY, local = {}, packIndex = {}, geoIndex = {};
    p.layers.forEach(function (l) {
      local[l.id] = l; var c = info(l);
      if (c.spec) c.packs.forEach(function (pk) { packIndex[pk.h] = { l: l, pk: pk }; });
      if (c.gh) geoIndex[c.gh] = l[BIG[l.kind]];
    });
    var jobs = [];
    // source-file hashes
    p.layers.forEach(function (l) {
      var k = p.id + ':' + l.id;
      if (!l.hasSources || fileCache[k]) return;
      if (B.files[l.id] && B.files[l.id].length) { fileCache[k] = B.files[l.id]; return; }
      jobs.push(Store.getFiles(p.id, l.id).then(function (fs) {
        if (fs.length) fileCache[k] = fs.map(function (f) { return { n: f.name, h: hash(fileB64(f.data)) }; });
      }));
    });
    if (man) Object.keys(man.layers).forEach(function (lid) {
      var rh = man.layers[lid], bh = B.layers[lid] && B.layers[lid].h, lh = local[lid] && info(local[lid]).h;
      if (rh === bh || rh === lh) return;
      jobs.push(getBlob(p.id, rh).then(function (txt) {
        var o = JSON.parse(txt), l = o.props;
        if (o.geo) {
          var field = BIG[l.kind] || 'geojson';
          return (geoIndex[o.geo] != null ? Promise.resolve(geoIndex[o.geo]) : getBlob(p.id, o.geo).then(function (t) { return field === 'geojson' ? JSON.parse(t) : t; })).then(function (g) { l[field] = g; pre.remote[lid] = l; });
        }
        if (!o.coll) { pre.remote[lid] = l; return; }
        var parts = o.packs.map(function (ph) {
          var hit = packIndex[ph];
          if (hit) {
            var arr = hit.l[COLL[hit.l.kind].f].slice(hit.pk.a, hit.pk.b);
            return Promise.resolve(hit.l.kind === 'drawing' ? arr : JSON.parse(JSON.stringify(arr.map(COLL[hit.l.kind].clean))));
          }
          return getBlob(p.id, ph).then(JSON.parse);
        });
        return Promise.all(parts).then(function (ps) { l[o.coll] = [].concat.apply([], ps); pre.remote[lid] = l; });
      }));
    });
    // photo hashes (read once per photo)
    Object.keys(photoRefs(p.layers)).forEach(function (id) {
      var k = p.id + ':' + id; if (photoHash[k]) return;
      if (B.photos && B.photos[id]) { photoHash[k] = B.photos[id]; return; }
      jobs.push(Store.getFile(p.id, '_photos', id + '.jpg').then(function (d) { if (d) photoHash[k] = hash(fileB64(d)); }));
    });
    return Promise.all(jobs).then(function () { return pre; });
  }

  /** Item-by-item three-way merge of a drawing/track/waypoint layer changed on both sides. */
  function mergeLayer(lo, ro, be) {
    var li = info(lo), ri = info(ro), spec = li.spec, bk = (be && be.k) || {};
    var out = li.p === (be && be.p) ? propsOf(ro) : propsOf(lo);
    var lmap = {}, larr = lo[spec.f] || [], rarr = ro[spec.f] || [];
    li.keys.forEach(function (k, i) { lmap[k] = i; });
    var items = [], seen = {};
    ri.keys.forEach(function (k, i) {
      seen[k] = true;
      var r = ri.ih[i], j = lmap[k], l = j == null ? undefined : li.ih[j], b = bk[k];
      if (l === r || r === b) { if (j != null) items.push(larr[j]); }
      else if (l === b || j == null) items.push(rarr[i]);
      else items.push(larr[j]); // edited on both: this device wins
    });
    li.keys.forEach(function (k, j) { if (!seen[k] && li.ih[j] !== bk[k]) items.push(larr[j]); }); // new here, or edited here and deleted there
    out[spec.f] = items;
    return out;
  }

  function sameOrder(a, b) { return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }

  /** Pure merge of local project, base and remote manifest (+ prefetched remote layers). */
  function merge(p, base, man, pre) {
    var B = base || EMPTY, R = man || EMPTY, local = {}, out = {}, src = {}, abort = false;
    p.layers.forEach(function (l) { local[l.id] = l; });
    var lids = {}; [local, R.layers, B.layers].forEach(function (o) { Object.keys(o).forEach(function (k) { lids[k] = true; }); });
    Object.keys(lids).forEach(function (lid) {
      var lo = local[lid], lh = lo ? info(lo).h : undefined, rh = R.layers[lid], be = B.layers[lid], bh = be ? be.h : undefined;
      var remote = function () { var o = pre.remote[lid]; if (!o) abort = true; return o; };
      var keep = function () { if (lo) { out[lid] = lo; src[lid] = 'local'; } };
      var take = function () { if (rh) { out[lid] = remote(); src[lid] = 'remote'; } };
      if (lh === rh || rh === bh) keep();
      else if (lh === bh || !lo) take();
      else if (!rh || !COLL[lo.kind]) keep();
      else {
        var ro = remote(); if (!ro) return;
        var m = mergeLayer(lo, ro, be), mh = info(m).h;
        if (mh === lh) keep(); else if (mh === rh) { out[lid] = ro; src[lid] = 'remote'; } else { out[lid] = m; src[lid] = 'merged'; }
      }
    });
    if (abort) return { abort: true };
    var meta = {};
    META.forEach(function (f) { var lv = p[f] == null ? '' : p[f]; meta[f] = (man && B.meta[f] === lv && R.meta[f] != null) ? R.meta[f] : lv; });
    var lorder = p.layers.map(function (l) { return l.id; }), rorder = R.order || [];
    var order = (man && sameOrder(lorder, B.order || []) ? rorder : lorder).filter(function (id) { return out[id]; });
    rorder.forEach(function (id, i) { // layers that only exist in the cloud: next to their cloud neighbour
      if (!out[id] || order.indexOf(id) >= 0) return;
      var at = 0; for (var k = i - 1; k >= 0; k--) { var x = order.indexOf(rorder[k]); if (x >= 0) { at = x + 1; break; } }
      order.splice(at, 0, id);
    });
    Object.keys(out).forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    var files = {};
    order.forEach(function (id) {
      var f = src[id] === 'remote' ? R.files[id] : (fileCache[p.id + ':' + id] || R.files[id] || B.files[id]);
      if (f && f.length) files[id] = f;
    });
    var photos = {};
    Object.keys(photoRefs(order.map(function (id) { return out[id]; }))).forEach(function (id) {
      var h = photoHash[p.id + ':' + id] || (R.photos || {})[id] || (B.photos || {})[id]; if (h) photos[id] = h;
    });
    return { out: out, src: src, order: order, meta: meta, files: files, photos: photos };
  }

  /** Puts the merged result into the project (and onto the map when it is the open one). */
  function apply(p, res, isOpen) {
    var changed = {}, any = false, removed = [];
    p.layers.forEach(function (l) { if (!res.out[l.id]) { removed.push(l.id); any = true; } });
    var byId = {}; p.layers.forEach(function (l) { byId[l.id] = l; });
    var layers = res.order.map(function (id) {
      var o = res.out[id];
      if (res.src[id] === 'local') return o;
      changed[id] = true; any = true;
      var cur = byId[id];
      if (!cur) return o;
      // Update in place: other code (GPS recording, open sheets) may hold this layer object.
      Object.keys(cur).forEach(function (k) { if (k !== '_leaflet' && !(k in o)) delete cur[k]; });
      Object.keys(o).forEach(function (k) { cur[k] = o[k]; });
      linfo.delete(cur);
      return cur;
    });
    if (!sameOrder(layers.map(function (l) { return l.id; }), p.layers.map(function (l) { return l.id; }))) any = true;
    var metaChanged = META.filter(function (f) { return (p[f] == null ? '' : p[f]) !== res.meta[f]; });
    metaChanged.forEach(function (f) { p[f] = res.meta[f]; });
    if (!any && !metaChanged.length) return false;
    p.layers.splice.apply(p.layers, [0, p.layers.length].concat(layers));
    if (!res.out[p.activeLayer]) { var d = layers.filter(function (l) { return l.kind === 'drawing'; }).pop(); p.activeLayer = d ? d.id : null; }
    removed.forEach(function (id) { Store.deleteLayer(p.id, id).catch(function () {}); });
    if (isOpen) {
      removed.forEach(GC.destroyView);
      Object.keys(changed).forEach(function (id) { GC.renderLayer(GC.layerById(id)); });
      var touched = function (ch) { return ch.some(function (c) { return changed[c.lid] || removed.indexOf(c.lid) >= 0; }); };
      GC.history.undo = GC.history.undo.filter(function (ch) { return !touched(ch); });
      GC.history.redo = GC.history.redo.filter(function (ch) { return !touched(ch); });
      GC.updateUndo();
      if (Object.keys(changed).length || removed.length) { if (GC.clearSelection) GC.clearSelection(); if (GC.closeInspector) GC.closeInspector(); }
      if (metaChanged.indexOf('name') >= 0) { $('project-name').textContent = p.name; if (document.activeElement !== $('proj-name')) $('proj-name').value = p.name; document.title = p.name + ' — GeoCanvas'; }
      if (metaChanged.indexOf('notes') >= 0 && document.activeElement !== $('proj-notes')) $('proj-notes').value = p.notes || '';
      if (metaChanged.indexOf('basemap') >= 0) GC.setBasemap(p.basemap, { fallback: true });
      GC.applyLayerState(); GC.refreshLayers();
    }
    return Store.saveProject(p, changed);
  }

  function manifestOf(p, res) {
    var layers = {}, blobs = [];
    res.order.forEach(function (id) {
      var l = res.out[id], c = info(l); layers[id] = c.h; blobs.push(c.h);
      if (c.spec) c.packs.forEach(function (pk) { blobs.push(pk.h); });
      if (c.gh) blobs.push(c.gh);
    });
    Object.keys(res.files).forEach(function (id) { res.files[id].forEach(function (f) { blobs.push(f.h); }); });
    Object.keys(res.photos).forEach(function (id) { blobs.push(res.photos[id]); });
    var seen = {}; blobs = blobs.filter(function (h) { if (seen[h]) return false; seen[h] = true; return true; });
    return { v: 1, device: cfg().device || '', meta: { name: res.meta.name, notes: res.meta.notes, basemap: res.meta.basemap, view: p.view, created: p.created },
      order: res.order, layers: layers, files: res.files, photos: res.photos, blobs: blobs };
  }
  function differs(a, b) {
    if (!b) return true;
    return JSON.stringify([a.order, a.layers, a.files, META.map(function (f) { return a.meta[f]; })]) !== JSON.stringify([b.order, b.layers, b.files || {}, META.map(function (f) { return b.meta[f]; })]);
  }
  function baseOf(p, layersById, order, meta, files, rev, prev) {
    var b = { rev: rev, order: order.slice(), meta: {}, files: files || {}, layers: {} };
    META.forEach(function (f) { b.meta[f] = meta[f]; });
    order.forEach(function (id) {
      var l = layersById[id];
      if (l) b.layers[id] = baseEntry(l);
      else if (prev && prev[id]) b.layers[id] = prev[id];
    });
    return b;
  }

  function downloadFiles(p, res) {
    var photoJob = Store.fileNames(p.id, '_photos').then(function (names) {
      var have = {}; names.forEach(function (n) { have[n] = true; });
      return Object.keys(res.photos).filter(function (id) { return !have[id + '.jpg']; }).reduce(function (chain, id) {
        return chain.then(function () { return getBlob(p.id, res.photos[id]).then(function (b64) { photoHash[p.id + ':' + id] = res.photos[id]; return Store.putFile(p.id, '_photos', id + '.jpg', b64ToAb(b64)); }); });
      }, Promise.resolve());
    });
    var jobs = [photoJob].concat(Object.keys(res.files).filter(function (id) { return res.src[id] !== 'local'; }).map(function (id) {
      return Store.getFiles(p.id, id).then(function (have) {
        var names = {}; have.forEach(function (f) { names[f.name] = true; });
        return Promise.all(res.files[id].filter(function (f) { return !names[f.n]; }).map(function (f) {
          return getBlob(p.id, f.h).then(function (b64) { return Store.putFile(p.id, id, f.n, b64ToAb(b64)); });
        })).then(function () { fileCache[p.id + ':' + id] = res.files[id]; });
      });
    }));
    return Promise.all(jobs);
  }

  function upload(p, res, man) {
    var producers = {};
    res.order.forEach(function (id) {
      var l = res.out[id], c = info(l);
      producers[c.h] = function () { return Promise.resolve(layerBlob(l)); };
      if (c.spec) c.packs.forEach(function (pk) { producers[pk.h] = function () { return Promise.resolve(packBlob(l, pk)); }; });
      if (c.gh) producers[c.gh] = function () { return Promise.resolve(bigText(l)); };
    });
    Object.keys(res.files).forEach(function (id) {
      res.files[id].forEach(function (f) {
        producers[f.h] = producers[f.h] || function () {
          return Store.getFiles(p.id, id).then(function (fs) { var hit = fs.filter(function (x) { return x.name === f.n; })[0]; if (!hit) throw new Error('An imported file of “' + res.out[id].name + '” is missing on this iPad.'); return fileB64(hit.data); });
        };
      });
    });
    Object.keys(res.photos).forEach(function (id) {
      producers[res.photos[id]] = producers[res.photos[id]] || function () {
        return Store.getFile(p.id, '_photos', id + '.jpg').then(function (d) { if (!d) throw new Error('A photo is missing on this iPad.'); return fileB64(d); });
      };
    });
    return api('POST', 'projects/' + p.id + '/missing', { hashes: man.blobs }).then(function (r) {
      var list = r.missing.slice(), next = function () {
        var h = list.shift(); if (!h) return Promise.resolve();
        if (!producers[h]) return Promise.reject(new Error('Sync data is out of step; it will retry.'));
        return producers[h]().then(function (txt) { return api('PUT', 'projects/' + p.id + '/blobs/' + h, txt, { timeout: 180000 }); }).then(next);
      };
      return Promise.all([next(), next(), next()]);
    });
  }

  /** One full sync of a project: fetch, merge, apply, push. Returns 'ok' | 'skip' | 'busy' | 'unlinked'. */
  function syncProject(p, isOpen) {
    var attempts = 0;
    var stillOurs = function () { return isOpen ? GC.project === p : !(GC.project && GC.project.id === p.id); };
    function round(rem) {
      return (rem !== undefined ? Promise.resolve(rem) : getRemote(p.id)).then(function (rem) {
        if (p.cloudOff || !stillOurs()) return 'skip';
        var base = p.cloud || null;
        if (rem && rem.deleted) {
          if (base) { // deleted from the cloud on another device: keep this copy, stop sharing it
            delete p.cloud; p.cloudOff = true;
            return Store.saveProject(p, {}).then(function () {
              if (isOpen) GC.toast('“' + p.name + '” was removed from the cloud on another device. It is still on this iPad, no longer shared.', 'warn', 9000);
              return 'unlinked';
            });
          }
          rem = { rev: rem.rev, manifest: null };
        }
        var man = rem && rem.manifest;
        if (!man && !base && p.layers.every(function (l) { return l.kind === 'drawing' && !l.items.length; }) && !p.notes) return 'skip'; // nothing worth sharing yet
        return prefetch(p, base, man).then(function (pre) {
          if (!stillOurs()) return 'skip';
          if (isOpen && GC.gestureActive && GC.gestureActive()) return 'busy';
          var res = merge(p, base, man, pre);
          if (res.abort) return 'busy';
          var rev = rem ? rem.rev : 0;
          return Promise.resolve(apply(p, res, isOpen)).then(function () {
            var mf = manifestOf(p, res);
            if (man) { // the cloud version is now merged in: remember it as the base
              var rl = {}; Object.keys(man.layers).forEach(function (id) { var o = pre.remote[id] || res.out[id]; if (o && info(o).h === man.layers[id]) rl[id] = o; });
              var prev = {}; Object.keys(man.layers).forEach(function (id) { if (base && base.layers[id] && base.layers[id].h === man.layers[id]) prev[id] = base.layers[id]; });
              p.cloud = baseOf(p, rl, man.order, man.meta, man.files, rev, prev);
              p.cloud.photos = man.photos || {};
            }
            var resBase = baseOf(p, res.out, res.order, res.meta, res.files, rev);
            resBase.photos = res.photos;
            return downloadFiles(p, res).then(function () {
              if (!differs(mf, man)) { p.cloud = resBase; return Store.saveProject(p, {}).then(function () { return 'ok'; }); }
              return upload(p, res, mf).then(function () {
                return api('PUT', 'projects/' + p.id, { baseRev: rev, manifest: mf }, { conflict: true });
              }).then(function (r) {
                if (r.conflict) {
                  if (++attempts > 4) throw new Error('The project keeps changing on another device; will retry.');
                  return Store.saveProject(p, {}).then(function () { return round(r.conflict.missing ? null : r.conflict); });
                }
                resBase.rev = r.rev; p.cloud = resBase;
                return Store.saveProject(p, {}).then(function () { return 'ok'; });
              }, function (e) {
                if (e.retry && ++attempts <= 4) return round(undefined);
                throw e;
              });
            });
          });
        });
      });
    }
    return round(undefined).then(function (r) {
      if (!isOpen && (r === 'ok' || r === 'skip' || r === 'unlinked')) pending(p.id, false);
      return r;
    });
  }

  // ---------- scheduling ----------
  var queue = Promise.resolve(), timer = null, running = false, again = false, lastCheck = 0, warned401 = false;
  function enqueue(fn) { var r = queue.then(fn, fn); queue = r.catch(function () {}); return r; }
  function schedule(ms) { if (!on()) return; clearTimeout(timer); timer = setTimeout(function () { run(false); }, ms); }
  /** Syncs the open project. Quiet unless something is wrong. */
  function run(force) {
    if (!on() || !GC.project) return Promise.resolve();
    if (running) { again = true; return Promise.resolve(); }
    var p = GC.project;
    if (p.cloudOff) { setStatus('skip'); return Promise.resolve(); }
    if (!force && Date.now() - lastCheck < 12000 && !pendingSet()[p.id]) return Promise.resolve();
    if (navigator.onLine === false) { setStatus('offline'); return Promise.resolve(); }
    running = true; lastCheck = Date.now();
    var gen = dirtyGen;
    var slow = setTimeout(function () { setStatus('syncing'); }, 600);
    return enqueue(function () { return syncProject(p, true); }).then(function (r) {
      clearTimeout(slow); running = false; warned401 = false;
      // Edits made while this round ran are not in it: go again soon.
      if (r !== 'busy') { if (dirtyGen === gen) pending(p.id, false); else again = true; }
      if (r === 'busy') { schedule(2500); }
      else setStatus(r === 'skip' && (p.cloudOff || !p.cloud) ? (p.cloudOff ? 'skip' : 'idle') : (r === 'unlinked' ? 'skip' : 'ok'));
      if (again) { again = false; clearTimeout(timer); timer = setTimeout(function () { run(true); }, 1000); }
    }, function (e) {
      clearTimeout(slow); running = false;
      if (e.offline) setStatus('offline'); else { setStatus('error', e.status === 401 ? 'the team join code was changed. Tap ☁ and join again with the new code.' : e.message); if (e.status === 401 && !warned401) GC.toast('The team join code was changed. Tap ☁ (top bar) and join again with the new code.', 'err', 9000); }
      if (e.status === 401) warned401 = true;
      if (again) { again = false; schedule(5000); }
    });
  }
  /** Syncs the projects that are not open: new ones, ones with unsent changes, and ones changed elsewhere. */
  function syncOthers() {
    if (!on() || navigator.onLine === false) return Promise.resolve();
    return Promise.all([Store.listProjects(), api('GET', 'projects')]).then(function (r) {
      var remote = {}; r[1].projects.forEach(function (x) { remote[x.id] = x; });
      var pend = pendingSet();
      var todo = r[0].filter(function (m) {
        if (m.cloudOff || (GC.project && m.id === GC.project.id)) return false;
        var x = remote[m.id];
        return !m.cloud || pend[m.id] || !x || x.rev !== m.cloud.rev;
      });
      return todo.reduce(function (chain, m) {
        return chain.then(function () {
          if (GC.project && m.id === GC.project.id) return;
          return enqueue(function () { return Store.loadProject(m.id).then(function (p) { return syncProject(p, false); }); }).catch(function () { /* next time */ });
        });
      }, Promise.resolve());
    }).catch(function () { /* offline or not set up: next time */ });
  }

  setInterval(function () { if (document.visibilityState !== 'hidden') run(false); }, 15000);
  setInterval(function () { if (document.visibilityState !== 'hidden') syncOthers(); }, 5 * 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') run(true);
    else if (GC.project && pendingSet()[GC.project.id]) run(true); // push before Safari suspends the page
  });
  window.addEventListener('online', function () { run(true); syncOthers(); });
  window.addEventListener('offline', function () { if (on()) setStatus('offline'); });
  var origOpen = GC.openProject;
  GC.openProject = function (p) {
    origOpen(p);
    refreshProjectTab();
    if (on()) { lastCheck = 0; setTimeout(function () { run(true); }, 300); }
  };

  // ---------- UI ----------
  function refreshProjectTab() {
    var box = $('proj-cloud'); if (!box) return;
    box.hidden = false;
    if (GC.project && GC.project.cloudOff) status.state = 'skip';
    setStatus(status.state);
  }
  if ($('proj-cloud-sync')) $('proj-cloud-sync').onclick = function () { if (!on()) { openTeam(); return; } run(true); syncOthers(); };

  // ---------- team: join code ----------
  var ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
  /** Join codes are typed however people like: case, spaces and dashes don't matter. */
  function normCode(t) { var c = String(t || '').toLowerCase().replace(/[^a-z0-9]/g, ''), g = c.match(/.{1,4}/g); return g ? g.join('-') : ''; }
  function newCode() { var r = new Uint32Array(12), s = ''; crypto.getRandomValues(r); for (var i = 0; i < 12; i++) s += ALPHA[r[i] % ALPHA.length]; return normCode(s); }
  function showCode(k) { return String(k || '').toUpperCase(); }
  function teamExists() { // 503 "unset" = no team yet; anything else (401) = a team exists
    return api('GET', 'ping', null, { key: '', timeout: 10000 }).then(function () { return true; }, function (e) { return e.status === 503 ? false : e.offline ? null : true; });
  }
  function connect(key, device, create) {
    key = normCode(key);
    var ping = function () { return api('GET', 'ping', null, { key: key, timeout: 15000 }); };
    return (create ? api('POST', 'passcode', { key: key }, { key: key }).then(ping) : ping()).catch(function (e) {
      if (e.offline) throw new Error('No internet connection. Joining needs to be online once.');
      if (e.status === 503) throw new Error('This GeoCanvas has no team yet. Tap “Start a team” instead.');
      throw e;
    }).then(function () {
      GC.settings.cloud = { key: key, device: device }; GC.saveSettings();
      try { localStorage.removeItem('gc.cloudPending'); } catch (e) { /* ignore */ }
      refreshProjectTab();
      return openLatestIfEmpty().then(function () { run(true).then(syncOthers); });
    });
  }
  /** A new iPad that joins with only its empty starter project opens the team's latest project instead. */
  function isEmpty(p) { return !p.cloud && !p.notes && p.layers.every(function (l) { return l.kind === 'drawing' && !l.items.length; }); }
  function openLatestIfEmpty() {
    var p = GC.project;
    return Store.listProjects().then(function (list) {
      if (!p || list.length !== 1 || list[0].id !== p.id || !isEmpty(p)) return;
      return remoteList().then(function (rem) {
        if (!rem || !rem.length) return;
        var latest = rem.slice().sort(function (a, b) { return b.modified - a.modified; })[0];
        GC.busy('Opening “' + latest.name + '” from the team…');
        return download(latest.id).then(function (q) { GC.openProject(q); return Store.deleteProject(p.id); }).then(function () { GC.busy(null); }, function () { GC.busy(null); });
      });
    });
  }
  /** Settings section (panels.js puts an empty #st-cloud in the Settings sheet). */
  function renderSettings(box) {
    if (!box) return;
    box.innerHTML = '<p class="hint" style="margin:0 0 6px">' + esc(describe().long) + '</p><div class="row-btns" style="margin:0"><button class="btn' + (on() ? '' : ' primary') + '" id="cl-team">' + (on() ? 'Team & cloud…' : 'Join your team…') + '</button></div>';
    box.querySelector('#cl-team').onclick = function () { GC.closeModal(); openTeam(); };
  }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) { /* ignore */ } document.body.removeChild(ta); return Promise.resolve();
  }
  /** The Team & cloud screen (top-bar cloud button). */
  function openTeam() {
    var c = cfg();
    if (!on()) {
      GC.modal('<h2>Join your team</h2><p class="sub">Projects are then saved to the team cloud automatically and can be opened on any iPad or computer in the team. This iPad keeps a copy and works offline.</p>' +
        '<label class="field">Your name<input type="text" id="tm-name" placeholder="e.g. Sam" value="' + esc(c.device || '') + '" autocomplete="name"></label>' +
        '<label class="field">Team join code<input type="text" id="tm-code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" style="font-family:ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase"></label>' +
        '<p class="hint">Ask anyone already in the team: it is under ☁ › Team join code.</p><p class="fail" id="tm-msg" hidden></p>' +
        '<div class="actions"><button class="btn" data-a="no">Not now</button><button class="btn primary" data-a="join">Join team</button></div>' +
        '<div id="tm-start" hidden><div class="pop-title small">No team yet?</div><p class="hint" style="margin:0 0 8px">Start one: GeoCanvas makes a join code for you to share with the others.</p><button class="btn" data-a="start">Start a team</button></div>',
        function (el, close) {
          var msg = function (t) { var m = el.querySelector('#tm-msg'); m.hidden = !t; m.textContent = t || ''; };
          var name = function () { return el.querySelector('#tm-name').value.trim(); };
          el.querySelector('[data-a=no]').onclick = close;
          el.querySelector('[data-a=join]').onclick = function () {
            var code = normCode(el.querySelector('#tm-code').value);
            if (!name()) { msg('Type your name, so others can see who changed what.'); return; }
            if (code.replace(/-/g, '').length < 8) { msg('Type the team join code (12 letters and numbers).'); return; }
            var who = name(); msg(''); el.querySelector('[data-a=join]').textContent = 'Joining…';
            connect(code, who).then(function () { close(); GC.toast('Welcome to the team, ' + who + '. Your projects now save to the cloud by themselves.'); }, function (e) { el.querySelector('[data-a=join]').textContent = 'Join team'; msg(e.message); });
          };
          teamExists().then(function (x) { if (x === false) el.querySelector('#tm-start').hidden = false; });
          el.querySelector('[data-a=start]').onclick = function () {
            if (!name()) { msg('Type your name first.'); return; }
            var code = newCode();
            connect(code, name(), true).then(function () { close(); openTeam(); GC.toast('Your team is ready. Share the join code with the others.'); }, function (e) { msg(e.message); });
          };
        });
      return;
    }
    var code = showCode(c.key);
    GC.modal('<h2>Team & cloud</h2><p class="tm-status" id="tm-status"></p>' +
      '<div class="pop-title small">Team join code</div><div class="tm-code"><code>' + esc(code) + '</code><button class="btn" data-a="copy">Copy</button>' + (navigator.share ? '<button class="btn" data-a="share">Share…</button>' : '') + '</div>' +
      '<p class="hint" style="margin:4px 0 0">Anyone who types this code in GeoCanvas (☁ in the top bar) joins the team and sees every project.</p>' +
      '<div class="pop-title small">You</div><p style="margin:0">' + esc(c.device || 'This iPad') + ' <button class="link" data-a="rename">Change name</button></p>' +
      '<div class="actions"><button class="btn" data-a="leave">Leave team on this iPad</button><button class="btn" data-a="recode">New join code…</button><span class="spacer"></span><button class="btn" data-a="now">Save now</button><button class="btn primary" data-a="ok">Done</button></div>',
      function (el, close) {
        setStatus(status.state);
        el.querySelector('[data-a=ok]').onclick = close;
        el.querySelector('[data-a=copy]').onclick = function () { copyText(code).then(function () { GC.toast('Join code copied.'); }); };
        if (el.querySelector('[data-a=share]')) el.querySelector('[data-a=share]').onclick = function () { navigator.share({ text: 'Join our GeoCanvas team: open ' + location.origin + ' , tap ☁ and enter the code ' + code }).catch(function () {}); };
        el.querySelector('[data-a=now]').onclick = function () { setStatus('syncing'); run(true).then(syncOthers); };
        el.querySelector('[data-a=rename]').onclick = function () { close(); GC.prompt('Your name', c.device || '', 'e.g. Sam', 'Save').then(function (n) { if (n) { GC.settings.cloud.device = n; GC.saveSettings(); } openTeam(); }); };
        el.querySelector('[data-a=leave]').onclick = function () {
          close();
          GC.confirm('Leave the team on this iPad?', 'Projects stay on this iPad and in the team cloud, but this iPad stops saving to the cloud until it joins again.', 'Leave', true).then(function (ok) {
            if (!ok) return; delete GC.settings.cloud; GC.saveSettings(); setStatus('off'); refreshProjectTab(); GC.toast('This iPad has left the team.');
          });
        };
        el.querySelector('[data-a=recode]').onclick = function () {
          close();
          GC.confirm('Make a new join code?', 'The old code stops working: everyone else in the team has to join again with the new code (their projects stay safe). Use this if the code got to someone it shouldn’t.', 'New code', true).then(function (ok) {
            if (!ok) return;
            var k = newCode();
            api('POST', 'passcode', { key: k }).then(function () { GC.settings.cloud.key = k; GC.saveSettings(); openTeam(); GC.toast('New join code made. Share it with the team.'); }, function (e) { GC.toast(e.message, 'err'); });
          });
        };
      });
  }

  /** Projects in the cloud (for the Projects sheet); [] when off or unreachable. */
  function remoteList() {
    if (!on() || navigator.onLine === false) return Promise.resolve(null);
    return api('GET', 'projects', null, { timeout: 8000 }).then(function (r) { return r.projects.filter(function (x) { return !x.deleted; }); }, function () { return null; });
  }
  /** Copies a cloud project onto this device. */
  function download(id) {
    return getRemote(id).then(function (rem) {
      if (!rem || rem.deleted || !rem.manifest) throw new Error('That project is no longer in the cloud.');
      var m = rem.manifest.meta || {};
      var p = { id: id, name: m.name || 'Untitled', created: m.created || Date.now(), modified: Date.now(), notes: m.notes || '', view: m.view || { lat: GC.TOOWOOMBA[0], lon: GC.TOOWOOMBA[1], zoom: 14 },
        basemap: m.basemap || 'qld', activeLayer: null, layers: [], cloud: { rev: 0, order: [], layers: {}, files: {}, meta: { name: m.name || 'Untitled', notes: m.notes || '', basemap: m.basemap || 'qld' } } };
      return Store.saveProject(p, {}).then(function () { return enqueue(function () { return syncProject(p, false); }); }).then(function () { return Store.loadProject(id); });
    });
  }
  function deleteEverywhere(id) { return api('DELETE', 'projects/' + id); }
  function linked(meta) { return on() && meta && !!meta.cloud && !meta.cloudOff; }

  GC.cloud = { on: on, run: run, renderSettings: renderSettings, openTeam: openTeam, normCode: normCode, describe: describe, remoteList: remoteList, download: download, deleteEverywhere: deleteEverywhere, linked: linked, touch: function (id) { pending(id, true); },
    _test: { hash: hash, info: info, merge: merge, mergeLayer: mergeLayer } };

  // start
  if ($('btn-cloud')) $('btn-cloud').onclick = openTeam;
  refreshProjectTab();
  setStatus(on() ? 'idle' : 'off');
  if (on()) setTimeout(function () { run(true).then(syncOthers); }, 1500);
})(window);

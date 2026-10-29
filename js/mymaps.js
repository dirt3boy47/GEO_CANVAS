/* GeoCanvas web — My maps: the team's library of maps (GeoPDF sheets, plans, GeoTIFFs, CAD drawings, online maps from
   Geoscience Australia / Queensland), organised in folders and shown in any project.
   The library is stored like a project (id "mylib<team>", hidden from the Projects list), so it syncs with the team cloud
   and works offline with the same machinery. Projects hold small references to library maps (kind "libmap"), so a big
   topo sheet is stored once; online maps are tiny and copied into the project. Folders are paths ("Vicmap 25K/Grampians")
   on each map; empty folders are listed in the library's notes. */
(function (global) {
  'use strict';
  var GC = global.GC, Store = global.Store, map = GC.map, $ = GC.$, esc = GC.esc;
  var REF_KINDS = { geopdf: 1, raster: 1, cad: 1 }, ALL_KINDS = { geopdf: 1, raster: 1, cad: 1, service: 1 };
  var lib = null, byId = {}, loading = null;

  // ---------- the library record ----------
  function libId() { var t = GC.cloud && GC.cloud.on() && GC.cloud.team(); return t && t.id ? 'mylib' + String(t.id).replace(/[^0-9a-z]/gi, '') : 'myliblocal'; } // project ids: letters and digits only
  function blank(id) {
    return { id: id, name: 'My maps', library: true, cloudOff: id === 'myliblocal' ? true : undefined, // the device-only library never syncs created: Date.now(), modified: Date.now(), notes: JSON.stringify({ folders: [] }),
      view: { lat: GC.TOOWOOMBA[0], lon: GC.TOOWOOMBA[1], zoom: 7 }, basemap: 'qld', activeLayer: null, layers: [] };
  }
  function setLib(p) { lib = p; byId = {}; p.layers.forEach(function (l) { byId[l.id] = l; }); return p; }
  /** With the cloud on, the team is known a moment after start-up: wait for it (up to ~10 s) so maps go into the team's library. */
  function teamKnown() {
    return new Promise(function (res) {
      var n = 0; (function wait() { if (!(GC.cloud && GC.cloud.on() && !GC.cloud.team()) || n++ > 20) res(); else setTimeout(wait, 500); })();
    });
  }
  /** Loads the library (from this device, else the team cloud, else a new one). */
  function load(force) {
    if (loading) return loading.then(function () { return force ? load(true) : lib; }, function () { return load(force); }); // a download may be half saved
    var job = teamKnown().then(function () {
      var id = libId();
      if (lib && lib.id === id && !force) return lib;
      return Store.loadProject(id).catch(function () {
        if (id !== 'myliblocal' && GC.cloud && GC.cloud.on() && navigator.onLine !== false) return GC.cloud.download(id).catch(function () { return null; });
      return null;
      }).then(function (p) {
        if (p) return adoptLocal(p);
        p = blank(id);
        return Store.saveProject(p, null).then(function () { return adoptLocal(p); });
      });
    });
    loading = job.then(function (p) { loading = null; if (p !== lib) { setLib(p); refreshRefs(); } migrate(); return p; }, function (e) { loading = null; throw e; });
    return loading;
  }
  /** After joining a team, maps saved before (on this device only) move into the team's library. */
  function adoptLocal(p) {
    if (p.id === 'myliblocal') return p;
    return Store.loadProject('myliblocal').then(function (old) {
      if (!old.layers.length) return Store.deleteProject('myliblocal').then(function () { return p; });
      return editId(p.id, function (q) { old.layers.forEach(function (l) { if (!q.layers.some(function (x) { return x.id === l.id; })) q.layers.push(l); }); setFolders(q, folders(q).concat(folders(old))); })
        .then(function (q) { return Store.deleteProject('myliblocal').then(function () { return q; }); });
    }, function () { return p; });
  }
  /** Changes the library safely: in the cloud's queue on a fresh copy, then saved and synced. fn returns the changed map ids. */
  function edit(fn) { return load().then(function (p) { return editId(p.id, fn); }); }
  function editId(id, fn) {
    var job = GC.cloud && GC.cloud.edit ? GC.cloud.edit(id, fn) : Store.loadProject(id).then(function (p) { var d = fn(p); return Store.saveProject(p, d || null).then(function () { return p; }); });
    return job.then(function (p) { setLib(p); refreshRefs(); return p; });
  }
  function meta(p) { try { return JSON.parse(p.notes) || {}; } catch (e) { return {}; } }
  function setFolders(p, list) { var m = meta(p); m.folders = uniq(list); p.notes = JSON.stringify(m); }
  function uniq(a) { var s = {}; return a.filter(function (x) { if (!x || s[x]) return false; s[x] = 1; return true; }).sort(function (a, b) { return a.localeCompare(b); }); }
  /** Every folder path, including parents of the folders maps are in. */
  function folders(p) {
    var all = (meta(p).folders || []).slice();
    p.layers.forEach(function (l) { if (l.folder) all.push(l.folder); });
    var out = []; all.forEach(function (f) { var parts = f.split('/'); for (var i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/')); });
    return uniq(out);
  }

  // ---------- map pieces: in the cloud, downloaded on request ----------
  // A sheet's pieces (and a plan's image) are kept in the cloud by hash; the library itself only holds their hashes and
  // corners, so every device sees every map at once. Pieces a device has downloaded live in the "gc-maps" cache (kept);
  // pieces shown straight from the cloud are kept for a while in "gc-maps-view" (trimmed).
  var KEEP = 'gc-maps', VIEW = 'gc-maps-view', HERE = 'gc.mapsHere', VIEW_MAX = 1500, viewPuts = 0;
  function key(h) { return location.origin + '/_maps/' + h; }
  function hereSet() { try { return JSON.parse(localStorage.getItem(HERE)) || {}; } catch (e) { return {}; } }
  function setHere(id, on) { var h = hereSet(); if (on) h[id] = Date.now(); else delete h[id]; try { localStorage.setItem(HERE, JSON.stringify(h)); } catch (e) { /* full */ } }
  function hashesOf(m) { var out = []; (m.pieces || []).forEach(function (p) { if (p.h) out.push(p.h); }); if (m.img && m.img.h) out.push(m.img.h); return out; }
  function hosted(m) { return hashesOf(m).length > 0; }
  function isHere(m) { return !hosted(m) || !!hereSet()[m.id]; }
  function cloudOn() { return !!(GC.cloud && GC.cloud.on()); }
  var mapStore = {
    put: function (h, text, keep) {
      if (!global.caches) return Promise.resolve();
      return caches.open(keep ? KEEP : VIEW).then(function (c) { return c.put(key(h), new Response(text, { headers: { 'Content-Type': 'text/plain' } })); })
        .then(function () { if (!keep && ++viewPuts % 100 === 0) trimView(); });
    },
    text: function (h) { return global.caches ? caches.match(key(h)).then(function (r) { return r ? r.text() : null; }) : Promise.resolve(null); },
    /** The piece's image (data URL): from this device, else from the cloud (kept for a while). null when neither is possible. */
    url: function (h) {
      return mapStore.text(h).then(function (t) {
        if (t || !cloudOn() || navigator.onLine === false || !lib) return t;
        return GC.cloud.blob(lib.id, h).then(function (r) { mapStore.put(h, r, false); return r; }, function () { return null; });
      });
    }
  };
  function trimView() { caches.open(VIEW).then(function (c) { return c.keys().then(function (ks) { if (ks.length > VIEW_MAX) return Promise.all(ks.slice(0, ks.length - VIEW_MAX).map(function (k) { return c.delete(k); })); }); }); }
  GC.mapStore = mapStore;
  /** Moves a map's pictures out of the map record into this device's store (kept), leaving hashes the cloud uploads once. */
  function hostify(m) {
    var jobs = [];
    if (m.pieces && m.pieces.some(function (p) { return p.url; })) {
      m.pieces = m.pieces.map(function (p) {
        if (!p.url) return p;
        var h = GC.cloud.hash(p.url), q = { h: h, c: p.c }; if (p.clip) q.clip = p.clip;
        jobs.push(mapStore.put(h, p.url, true)); return q;
      });
    }
    if (m.kind === 'raster' && m.dataURL) {
      var h = GC.cloud.hash(m.dataURL), b = m.bounds;
      jobs.push(mapStore.put(h, m.dataURL, true));
      m.img = { h: h, c: m.corners || [[b[1][0], b[0][1]], [b[1][0], b[1][1]], [b[0][0], b[0][1]]] }; delete m.dataURL;
    }
    return Promise.all(jobs).then(function () { if (hosted(m)) setHere(m.id, true); return m; });
  }
  /** Maps from before hosting (pictures inside the record) are converted once, on the device that has them. */
  var migrating = false;
  function migrate() {
    if (migrating || !lib || !GC.cloud || !global.caches) return;
    var old = lib.layers.filter(function (m) { return (m.pieces && m.pieces.some(function (p) { return p.url; })) || (m.kind === 'raster' && m.dataURL); });
    if (!old.length) return;
    migrating = true;
    var done = {};
    Promise.all(old.map(function (m) { var c = Object.assign({}, m); return hostify(c).then(function () { done[m.id] = c; }); })).then(function () {
      return edit(function (p) { var d = {}; p.layers = p.layers.map(function (x) { if (!done[x.id] || !((x.pieces && x.pieces.some(function (q) { return q.url; })) || x.dataURL)) return x; d[x.id] = 1; return Object.assign({}, done[x.id], { name: x.name, folder: x.folder }); }); return d; });
    }).then(function () { migrating = false; }, function () { migrating = false; });
  }
  /** Copies all of a map's pieces onto this device so it works offline. */
  function downloadMap(m, progress) {
    var hs = hashesOf(m), i = 0, n = 0;
    if (!global.caches) return Promise.reject(new Error('This browser cannot store maps.'));
    return caches.open(KEEP).then(function (keep) {
      var next = function () {
        if (i >= hs.length) return Promise.resolve();
        var h = hs[i++];
        return keep.match(key(h)).then(function (hit) {
          if (hit) return;
          return mapStore.text(h).then(function (t) {
            if (t) return t;
            if (!cloudOn() || navigator.onLine === false) throw new Error('No connection to the cloud.');
            return GC.cloud.blob(lib.id, h);
          }).then(function (t) { return keep.put(key(h), new Response(t, { headers: { 'Content-Type': 'text/plain' } })); });
        }).then(function () { n++; if (progress) progress(n, hs.length); return next(); });
      };
      return Promise.all([next(), next(), next(), next()]);
    }).then(function () { setHere(m.id, true); });
  }
  /** Frees this device's copy (the cloud keeps the map). Refused while the cloud does not have it all yet. */
  function removeLocal(m, force) {
    var hs = hashesOf(m);
    var check = force ? Promise.resolve([]) : !cloudOn() ? Promise.reject(new Error('This device has the only copy: join a team (☁) to keep maps in the cloud.')) :
      GC.cloud.missing(lib.id, hs).catch(function () { throw new Error('No connection to the cloud, so it can’t be checked that the cloud has this map.'); });
    return check.then(function (missing) {
      if (missing.length) throw new Error('This map is still uploading to the cloud. Try again when the upload has finished.');
      var keepH = {}, here = hereSet();
      lib.layers.forEach(function (x) { if (x.id !== m.id && here[x.id]) hashesOf(x).forEach(function (h) { keepH[h] = 1; }); });
      return Promise.all([KEEP, VIEW].map(function (name) { return caches.open(name).then(function (c) { return Promise.all(hs.filter(function (h) { return !keepH[h]; }).map(function (h) { return c.delete(key(h)); })); }); }));
    }).then(function () { setHere(m.id, false); });
  }
  function fourth(c) { return [c[1][0] + c[2][0] - c[0][0], c[1][1] + c[2][1] - c[0][1]]; }
  var told = {};
  function notHere(m) {
    if (told[m.id]) return; told[m.id] = 1;
    GC.toast('Parts of “' + m.name + '” can’t be shown: it is kept in the cloud and there is no connection (or it is still uploading from the device that added it). Download it in My maps to use it offline.', 'warn', 9000);
  }
  /** Draws a library sheet or image: its overview when the whole sheet is small on screen, otherwise only the pieces in
      view (from this device, or streamed from the cloud). */
  GC.MapPieces = L.Layer.extend({
    initialize: function (src, options) {
      L.setOptions(this, options); this._src = src;
      var list = src.pieces ? src.pieces : src.img ? [src.img] : src.dataURL ? [{ url: src.dataURL, c: src.corners || [[src.bounds[1][0], src.bounds[0][1]], [src.bounds[1][0], src.bounds[1][1]], [src.bounds[0][0], src.bounds[0][1]]] }] : [];
      this._items = list.map(function (p) { return { p: p, b: L.latLngBounds([p.c[0], p.c[1], p.c[2], fourth(p.c)]) }; });
      var ov = src.overview; this._ovB = ov ? L.latLngBounds([ov.c[0], ov.c[1], ov.c[2], fourth(ov.c)]) : null;
    },
    onAdd: function (m) { this._group = L.layerGroup().addTo(m); this._active = 0; m.on('moveend', this._update, this); this._update(); },
    onRemove: function (m) { m.off('moveend', this._update, this); m.removeLayer(this._group); this._items.forEach(function (it) { it.layer = null; }); this._ov = null; this._map = null; },
    _update: function () {
      var m = this._map; if (!m) return;
      var self = this, sz = m.getSize(), useOv = false;
      if (this._ovB) { var a = m.latLngToContainerPoint(this._ovB.getNorthWest()), b = m.latLngToContainerPoint(this._ovB.getSouthEast()); useOv = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) <= 1400; }
      if (useOv) {
        if (!this._ov) { var o = this._src.overview; this._ov = new GC.AffineImage(o.url, o.c, { pane: this.options.pane, clip: o.clip }); }
        if (!this._group.hasLayer(this._ov)) this._group.addLayer(this._ov);
        this._items.forEach(function (it) { if (it.layer) { self._group.removeLayer(it.layer); it.layer = null; } });
        return;
      }
      if (this._ov && this._group.hasLayer(this._ov)) this._group.removeLayer(this._ov);
      var near = m.getBounds().pad(0.4), far = m.getBounds().pad(1.5);
      this._items.forEach(function (it) {
        if (it.layer && !far.intersects(it.b)) { self._group.removeLayer(it.layer); it.layer = null; } // free memory far away
        if (!it.layer && !it.loading && near.intersects(it.b) && self._active < 6 && !(it.failed && Date.now() - it.failed < 30000)) self._load(it);
      });
    },
    _load: function (it) {
      var self = this; it.loading = true; this._active++;
      (it.p.url ? Promise.resolve(it.p.url) : mapStore.url(it.p.h)).then(function (u) {
        self._active--; it.loading = false;
        if (!u) { it.failed = Date.now(); notHere(self._src); return; }
        it.failed = 0;
        if (!self._map) return;
        it.layer = new GC.AffineImage(u, it.p.c, { pane: self.options.pane, clip: it.p.clip });
        self._group.addLayer(it.layer);
        self._update();
      });
    }
  });

  // ---------- maps in projects ----------
  function get(id) { return byId[id] || null; }
  function inProject(id) { return (GC.project ? GC.project.layers : []).filter(function (l) { return l.ref === id || l.libRef === id; })[0] || null; }
  /** Re-draws project layers that show library maps (after the library loads or changes). */
  function refreshRefs() {
    if (!GC.project) return;
    var any = false;
    GC.project.layers.forEach(function (l) { if (l.kind === 'libmap') { GC.renderLayer(l); any = true; } });
    if (any) { GC.applyLayerState(); GC.refreshLayers(); }
  }
  /** Shows a library map in the open project. */
  function addToProject(m) {
    var have = inProject(m.id); if (have) { GC.zoomToLayer(have); return have; }
    var l;
    if (m.kind === 'service') { l = JSON.parse(JSON.stringify(GC.stripLayer(m))); l.id = global.Ink.uid(); l.libRef = m.id; delete l.folder; delete l.thumb; delete l.size; }
    else l = { id: global.Ink.uid(), name: m.name, kind: 'libmap', ref: m.id, visible: true, opacity: m.kind === 'raster' ? 0.75 : 1, locked: true, blend: !!m.blend, created: Date.now() };
    GC.insertLayer(l, true);
    var b = GC.layerBounds(l); if (b && !map.getBounds().intersects(b)) GC.zoomToLayer(l);
    return l;
  }
  function sizeOf(l) {
    var n = 0;
    if (l.pieces) l.pieces.forEach(function (p) { n += p.url ? p.url.length : 0; }); else if (l.dataURL) n = l.dataURL.length; else if (l.cad) n = JSON.stringify(l.cad).length; else n = 2000;
    return Math.round(n * 0.75);
  }
  function thumbOf(l) {
    if (l.thumb || !(l.dataURL || (l.pieces && l.pieces.length))) return Promise.resolve(l.thumb || null);
    return new Promise(function (res) {
      var img = new Image(); img.onload = function () {
        var k = 160 / Math.max(img.naturalWidth, img.naturalHeight), cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); res(cv.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = function () { res(null); }; img.src = l.dataURL || l.pieces[Math.floor(l.pieces.length / 2)].url;
    });
  }
  /** Puts a map into the library (and, unless told not to, into the open project). */
  function addMap(l, opts) {
    opts = opts || {};
    var m = JSON.parse(JSON.stringify(GC.stripLayer(l)));
    m.id = global.Ink.uid(); m.folder = opts.folder != null ? opts.folder : importFolder(); m.visible = true; delete m.libRef;
    m.size = sizeOf(m); m.added = Date.now(); m.addedBy = (GC.settings.cloud && GC.settings.cloud.device) || '';
    return load().then(function () { return thumbOf(m); }).then(function (t) {
      if (t) m.thumb = t;
      return GC.cloud && global.caches ? hostify(m) : m; // pictures to this device's store; the cloud gets them with the library
    }).then(function () {
      return edit(function (p) { p.layers.push(m); var d = {}; d[m.id] = 1; return d; });
    }).then(function () { return opts.project === false ? null : addToProject(byId[m.id]); }).then(function (pl) { return { map: byId[m.id], layer: pl }; });
  }
  /** Moves a project layer into the library and shows it from there (same place in the layer list). */
  function saveLayer(l) {
    if (!ALL_KINDS[l.kind]) return Promise.resolve(null);
    var folder = importFolder();
    return addMap(l, { folder: folder, project: false }).then(function (r) {
      if (l.kind === 'service') { l.libRef = r.map.id; GC.markDirty(l.id); GC.refreshLayers(); return r.map; }
      var p = GC.project, i = p.layers.indexOf(l);
      var ref = { id: global.Ink.uid(), name: l.name, kind: 'libmap', ref: r.map.id, visible: l.visible, opacity: l.opacity, locked: true, blend: !!l.blend, created: Date.now() };
      if (l.kind === 'cad') { ref.showText = l.showText; ref.mono = l.mono; }
      GC.removeLayer(l.id);
      p.layers.splice(Math.min(i, p.layers.length), 0, ref);
      GC.renderLayer(ref); GC.applyLayerState(); GC.markDirty(ref.id); GC.refreshLayers();
      return r.map;
    });
  }

  // ---------- importing straight into a folder ----------
  // While the My maps "Import" is active, maps imported (GeoPDF, GeoTIFF, DXF, placed plans) go into that folder.
  // It ends when that import is done (or, for a plan being placed, when it is saved or cancelled).
  var pendingImport = null;
  function importFolder() { return pendingImport && Date.now() < pendingImport.until ? pendingImport.folder : ''; }
  setInterval(function () {
    if (!pendingImport) return;
    if (GC.georef && GC.georef.isOn()) pendingImport.placing = true;
    else if (pendingImport.placing || pendingImport.done || Date.now() > pendingImport.until) pendingImport = null;
  }, 1500);
  var origChange = $('file-input').onchange;
  $('file-input').onchange = function () {
    var job = pendingImport, r = origChange.apply(this, arguments);
    if (!job) return r;
    if (!r) { pendingImport = null; return r; } // nothing picked
    return Promise.resolve(r).then(function () { setTimeout(function () { if (pendingImport === job) job.done = true; }, 3000); }); // a plan may still open
  };
  $('btn-import').addEventListener('click', function () { pendingImport = null; }); // the normal Import button imports into the project
  var origInsert = GC.insertLayer;
  GC.insertLayer = function (l, onTop) {
    origInsert(l, onTop);
    if (pendingImport && Date.now() < pendingImport.until && REF_KINDS[l.kind]) {
      saveLayer(l).then(function (m) { if (m) GC.toast('“' + m.name + '” saved in My maps' + (m.folder ? ' › ' + m.folder.replace(/\//g, ' › ') : '') + '.'); });
    }
  };

  // ---------- the My maps sheet ----------
  var state = { folder: '', q: '', here: false, open: null };
  var KLABEL = { geopdf: 'GeoPDF', raster: 'Image', cad: 'CAD drawing', service: 'Online map' };
  function crumbs(f) {
    var parts = f ? f.split('/') : [], out = '<a data-go="">My maps</a>';
    parts.forEach(function (p, i) { out += ' › <a data-go="' + esc(parts.slice(0, i + 1).join('/')) + '">' + esc(p) + '</a>'; });
    return out;
  }
  function mb(n) { return !n ? '0 MB' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB'; }
  function icon(m) { return m.thumb ? '<img class="mm-thumb" alt="" src="' + m.thumb + '">' : '<span class="mm-thumb mm-ico">' + (m.kind === 'service' ? '🌐' : m.kind === 'cad' ? '📐' : '🗺') + '</span>'; }
  function open(opts) {
    if (opts && opts.folder != null) state.folder = opts.folder;
    GC.busy('Opening My maps…');
    load().then(function () { GC.busy(null); render(); }, function (e) { GC.busy(null); GC.toast('Could not open My maps: ' + e.message, 'err'); });
  }
  function render() {
    var p = lib, all = folders(p), f = state.folder, q = state.q.trim().toLowerCase();
    if (f && all.indexOf(f) < 0) f = state.folder = '';
    var view = map.getBounds(), list, subs = [];
    var mapsIn = function (dir) { return p.layers.filter(function (m) { return (m.folder || '') === dir; }); };
    var countIn = function (dir) { return p.layers.filter(function (m) { return m.folder === dir || (m.folder || '').indexOf(dir + '/') === 0; }).length; };
    if (q || state.here) {
      list = p.layers.filter(function (m) {
        if (q && (m.name + ' ' + (m.folder || '') + ' ' + (KLABEL[m.kind] || '')).toLowerCase().indexOf(q) < 0) return false;
        if (state.here) { var b = m.bounds || (m.kind === 'service' ? null : null); if (!b || !view.intersects(L.latLngBounds(b))) return false; }
        return true;
      });
    } else {
      list = mapsIn(f);
      subs = all.filter(function (x) { return x.indexOf(f ? f + '/' : '') === 0 && x !== f && x.slice(f ? f.length + 1 : 0).indexOf('/') < 0; });
    }
    list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    var rows = subs.map(function (s) {
      var n = countIn(s);
      return '<div class="lib-row mm-folder" data-folder="' + esc(s) + '"><span class="mm-thumb mm-ico">📁</span><div class="lib-txt"><b>' + esc(s.split('/').pop()) + '</b><small>' + (n ? n + (n === 1 ? ' map' : ' maps') : 'empty') + '</small></div>' +
        '<button class="ib" data-a="fmore" title="Folder options" aria-label="Folder options"><svg><use xlink:href="#i-more"/></svg></button><span class="lib-go">›</span></div>' +
        (state.open === 'f:' + s ? '<div class="mm-acts"><button class="btn" data-a="frename">Rename</button>' + (n ? '<button class="btn" data-a="fdown">Download all to this device</button>' : '<button class="btn" data-a="fdel">Delete folder</button>') + '</div>' : '');
    }).concat(list.map(function (m) {
      var here = inProject(m.id), local = isHere(m), cloud = hosted(m);
      var where = !cloud ? '' : local ? ' · <span class="mm-local">📱 On this device</span>' : ' · <span class="mm-cloud">☁ In the cloud</span>';
      return '<div class="lib-row mm-map" data-id="' + esc(m.id) + '">' + icon(m) + '<div class="lib-txt"><b>' + esc(m.name) + '</b><small>' + (KLABEL[m.kind] || m.kind) + ' · ' + mb(m.size || 0) + where +
        ((q || state.here) && m.folder ? ' · 📁 ' + esc(m.folder.replace(/\//g, ' › ')) : '') + (m.addedBy ? ' · ' + esc(m.addedBy) : '') + '</small></div>' +
        (cloud && !local ? '<button class="ib" data-a="dl" title="Download to this device" aria-label="Download to this device"><svg><use xlink:href="#i-import"/></svg></button>' : '') +
        '<button class="ib" data-a="more" title="Map options" aria-label="Map options"><svg><use xlink:href="#i-more"/></svg></button>' +
        (here ? '<button class="btn" data-a="show">✓ Shown</button>' : '<button class="btn primary" data-a="add">Add</button>') + '</div>' +
        (state.open === m.id ? '<div class="mm-acts"><button class="btn" data-a="zoom">Zoom to</button><button class="btn" data-a="rename">Rename</button>' +
          '<label class="mm-move">Move to <select data-a="move"><option value="">My maps (top)</option>' + all.map(function (x) { return '<option value="' + esc(x) + '"' + (x === (m.folder || '') ? ' selected' : '') + '>' + esc(x.replace(/\//g, ' › ')) + '</option>'; }).join('') + '</select></label>' +
          (cloud ? (local ? '<button class="btn" data-a="unload">Remove from this device</button>' : '<button class="btn" data-a="dl2">Download to this device</button>') : '') +
          (here ? '<button class="btn" data-a="remove">Remove from project</button>' : '') + '<button class="btn" data-a="del">Delete</button></div>' : '');
    }));
    var empty = !rows.length ? '<p class="hint">' + (q || state.here ? 'No maps match.' : f ? 'This folder is empty. Import maps into it, or move maps here (⋯ › Move to).' : 'No maps yet. Import GeoPDF topo sheets, GeoTIFFs or plans, or add online maps from Geoscience Australia and Queensland.') + '</p>' : '';
    GC.modal('<h2>My maps</h2><p class="sub">The team’s maps, in folders. <b>Add</b> shows a map in this project; it stays in My maps for every project and every device.</p>' +
      '<div class="mm-bar"><input type="search" id="mm-q" placeholder="Search my maps" autocomplete="off" value="' + esc(state.q) + '"><label class="mm-here"><input type="checkbox" id="mm-here"' + (state.here ? ' checked' : '') + '> Here</label></div>' +
      (q || state.here ? '<div class="lib-crumbs">' + (state.here ? 'Maps covering this part of the map' : 'Search results') + '</div>' : '<div class="lib-crumbs">' + crumbs(f) + '</div>') +
      '<div class="row-btns mm-tools"><button class="btn" data-a="newf"><svg><use xlink:href="#i-folder"/></svg> New folder</button><button class="btn" data-a="import"><svg><use xlink:href="#i-import"/></svg> Import maps</button><button class="btn" data-a="online">🌐 Online maps</button></div>' +
      '<div class="lib-body mm-body"><div class="list">' + rows.join('') + '</div>' + empty + '</div>' +
      '<p class="hint" id="mm-store"></p><div class="actions"><button class="btn primary" data-a="done">Done</button></div>',
      function (el, close) {
        var q1 = function (s) { return el.querySelector(s); }, rerender = function () { close(); render(); };
        var qbox = q1('#mm-q'), t = null;
        qbox.oninput = function () { clearTimeout(t); t = setTimeout(function () { state.q = qbox.value; rerender(); setTimeout(function () { var b = $('mm-q'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }, 30); }, 350); };
        q1('#mm-here').onchange = function () { state.here = q1('#mm-here').checked; rerender(); };
        [].forEach.call(el.querySelectorAll('[data-go]'), function (a) { a.onclick = function () { state.folder = a.getAttribute('data-go'); state.open = null; rerender(); }; });
        q1('[data-a=done]').onclick = close;
        q1('[data-a=newf]').onclick = function () {
          close();
          GC.prompt('New folder' + (f ? ' in “' + f.split('/').pop() + '”' : ''), '', 'e.g. Vicmap 25K', 'Create').then(function (name) {
            name = (name || '').replace(/\//g, '-').trim();
            if (!name) { render(); return; }
            var path = (f ? f + '/' : '') + name;
            edit(function (p) { setFolders(p, folders(p).concat([path])); return {}; }).then(function () { state.folder = path; render(); });
          });
        };
        q1('[data-a=import]').onclick = function () {
          close(); pendingImport = { folder: f, until: Date.now() + 15 * 60000 };
          GC.toast('Pick GeoPDFs, GeoTIFFs or DXFs: they go into ' + (f ? '“' + f.replace(/\//g, ' › ') + '”' : 'My maps') + '. PDF plans without coordinates are placed first, then saved here.', null, 7000);
          var inp = $('file-input'); inp.value = ''; inp.click();
        };
        q1('[data-a=online]').onclick = function () { close(); if (GC.library) GC.library.open({ folder: f }); };
        [].forEach.call(el.querySelectorAll('.mm-folder'), function (row) {
          var path = row.getAttribute('data-folder');
          row.onclick = function (e) { if (e.target.closest('[data-a]')) return; state.folder = path; state.open = null; rerender(); };
          row.querySelector('[data-a=fmore]').onclick = function () { state.open = state.open === 'f:' + path ? null : 'f:' + path; rerender(); };
        });
        if (q1('[data-a=frename]')) q1('[data-a=frename]').onclick = function () {
          var path = state.open.slice(2); close();
          GC.prompt('Rename folder', path.split('/').pop(), 'Folder name', 'Rename').then(function (name) {
            name = (name || '').replace(/\//g, '-').trim(); if (!name) { render(); return; }
            var to = path.split('/').slice(0, -1).concat([name]).join('/'), mv = function (x) { return x === path ? to : x.indexOf(path + '/') === 0 ? to + x.slice(path.length) : x; };
            edit(function (p) {
              var d = {}; setFolders(p, folders(p).map(mv));
              p.layers = p.layers.map(function (m) { if (!m.folder || mv(m.folder) === m.folder) return m; d[m.id] = 1; return Object.assign({}, m, { folder: mv(m.folder) }); });
              return d;
            }).then(function () { state.open = null; render(); });
          });
        };
        if (q1('[data-a=fdel]')) q1('[data-a=fdel]').onclick = function () {
          var path = state.open.slice(2);
          edit(function (p) { setFolders(p, (meta(p).folders || []).filter(function (x) { return x !== path && x.indexOf(path + '/') !== 0; })); return {}; }).then(function () { state.open = null; rerender(); });
        };
        [].forEach.call(el.querySelectorAll('.mm-map'), function (row) {
          var id = row.getAttribute('data-id'), m = byId[id];
          row.querySelector('[data-a=more]').onclick = function () { state.open = state.open === id ? null : id; rerender(); };
          if (row.querySelector('[data-a=add]')) row.querySelector('[data-a=add]').onclick = function () { addToProject(m); GC.toast('“' + m.name + '” is shown in this project.'); rerender(); };
          if (row.querySelector('[data-a=show]')) row.querySelector('[data-a=show]').onclick = function () { close(); GC.zoomToLayer(inProject(id)); };
        });
        var get1 = function (id) { return byId[id]; };
        var down = function (list) {
          close(); var i = 0;
          var one = function () {
            if (i >= list.length) { GC.busy(null); GC.toast(list.length === 1 ? '“' + list[0].name + '” is on this device: it works offline.' : list.length + ' maps are on this device: they work offline.'); render(); return; }
            var m = list[i++];
            return downloadMap(m, function (n, t) { GC.busy('Downloading “' + m.name + '”… ' + Math.round(100 * n / t) + '%' + (list.length > 1 ? ' (' + i + ' of ' + list.length + ')' : '')); }).then(one);
          };
          GC.busy('Downloading…');
          Promise.resolve(one()).catch(function (e) { GC.busy(null); GC.toast('Download stopped: ' + e.message + ' What was downloaded is kept; try again to finish.', 'err', 9000); render(); });
        };
        [].forEach.call(el.querySelectorAll('.mm-map [data-a=dl]'), function (b) { b.onclick = function () { down([get1(b.closest('.mm-map').getAttribute('data-id'))]); }; });
        if (q1('[data-a=fdown]')) q1('[data-a=fdown]').onclick = function () {
          var path = state.open.slice(2);
          down(lib.layers.filter(function (m) { return (m.folder === path || (m.folder || '').indexOf(path + '/') === 0) && hosted(m) && !isHere(m); }));
        };
        var cur = state.open && byId[state.open], acts = el.querySelector('.mm-acts');
        if (cur && acts && acts.querySelector('[data-a=dl2]')) acts.querySelector('[data-a=dl2]').onclick = function () { down([cur]); };
        if (cur && acts && acts.querySelector('[data-a=unload]')) acts.querySelector('[data-a=unload]').onclick = function () {
          close(); GC.busy('Checking the cloud has it…');
          removeLocal(cur).then(function () { GC.busy(null); GC.toast('“' + cur.name + '” removed from this device. It stays in the cloud and shows when online.'); state.open = null; render(); },
            function (e) { GC.busy(null); GC.toast(e.message, 'warn', 8000); render(); });
        };
        if (cur && acts) {
          acts.querySelector('[data-a=zoom]').onclick = function () { close(); var l = inProject(cur.id); if (l) GC.zoomToLayer(l); else if (cur.bounds) map.fitBounds(cur.bounds, { padding: [40, 40] }); };
          acts.querySelector('[data-a=rename]').onclick = function () {
            close();
            GC.prompt('Rename map', cur.name, 'Map name', 'Rename').then(function (name) {
              name = (name || '').trim(); if (!name || name === cur.name) { render(); return; }
              edit(function (p) { var d = {}; p.layers = p.layers.map(function (x) { if (x.id !== cur.id) return x; d[x.id] = 1; return Object.assign({}, x, { name: name }); }); return d; }).then(render);
            });
          };
          acts.querySelector('[data-a=move]').onchange = function () {
            var to = this.value;
            edit(function (p) { var d = {}; p.layers = p.layers.map(function (x) { if (x.id !== cur.id) return x; d[x.id] = 1; return Object.assign({}, x, { folder: to }); }); return d; })
              .then(function () { state.open = null; rerender(); GC.toast('Moved to ' + (to ? '“' + to.replace(/\//g, ' › ') + '”' : 'My maps') + '.'); });
          };
          if (acts.querySelector('[data-a=remove]')) acts.querySelector('[data-a=remove]').onclick = function () { var l = inProject(cur.id); if (l) { GC.removeLayer(l.id); GC.markDirty(); GC.refreshLayers(); } state.open = null; rerender(); };
          acts.querySelector('[data-a=del]').onclick = function () {
            close();
            GC.confirm('Delete “' + cur.name + '”?', 'It is removed from My maps for the whole team. Projects that show it will show it as missing.', 'Delete', true).then(function (ok) {
              if (!ok) { render(); return; }
              var l = inProject(cur.id); if (l) { GC.removeLayer(l.id); GC.markDirty(); GC.refreshLayers(); }
              if (hosted(cur)) removeLocal(cur, true).catch(function () {});
              edit(function (p) { p.layers = p.layers.filter(function (x) { return x.id !== cur.id; }); Store.deleteLayer(p.id, cur.id).catch(function () {}); return {}; })
                .then(function () { state.open = null; render(); GC.toast('“' + cur.name + '” deleted from My maps.'); });
            });
          };
        }
        var st = q1('#mm-store'), total = 0, local = 0; lib.layers.forEach(function (x) { total += x.size || 0; if (hosted(x) && isHere(x)) local += x.size || 0; });
        st.textContent = lib.layers.length + (lib.layers.length === 1 ? ' map' : ' maps') + ', about ' + mb(total) + (cloudOn() ? ' in the cloud, ' + mb(local) + ' downloaded on this device. Maps in the cloud show when online; download them to use offline.' : '. On this device only: join a team (☁) to keep them in the cloud for everyone.');
      });
  }

  // keep up with changes from other devices (the cloud syncs the library in the background)
  var seen = 0;
  setInterval(function () {
    if (!lib || document.visibilityState === 'hidden') return;
    if (lib.id !== libId()) { load(true).catch(function () {}); return; } // joined or switched team
    Store.listProjects(true).then(function (ps) { var m = ps.filter(function (x) { return x.id === lib.id; })[0]; if (m && m.modified !== seen) { var first = !seen; seen = m.modified; if (!first) load(true); } }, function () {});
  }, 20000);

  $('btn-mymaps').onclick = function () { open(); };
  setTimeout(function () { load().catch(function () {}); }, 800); // so library maps in the project can draw
  GC.mymaps = { open: open, load: load, get: get, addMap: addMap, addToProject: addToProject, saveLayer: saveLayer, inProject: inProject, folders: function () { return lib ? folders(lib) : []; },
    importFolder: importFolder, libId: libId, isHere: isHere, hosted: hosted, download: downloadMap, removeLocal: removeLocal, edit: edit, all: function () { return lib ? lib.layers : []; } };
})(window);

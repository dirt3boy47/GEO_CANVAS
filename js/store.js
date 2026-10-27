/* GeoCanvas web — project storage in IndexedDB.
   projects: {id, name, created, modified, notes, view, basemap, layerOrder, activeLayer}
   layers:   one record per layer (key "projectId:layerId"), so a save rewrites only changed layers.
   files:    original imported files (key "projectId:layerId:name"); photos under the layer id "_photos". */
(function (global) {
  'use strict';
  var db = null, memory = null;

  function open() {
    return new Promise(function (res) {
      if (!global.indexedDB) { memory = { projects: {}, layers: {}, files: {} }; return res(false); }
      var req;
      try { req = indexedDB.open('geocanvas', 1); } catch (e) { memory = { projects: {}, layers: {}, files: {} }; return res(false); }
      req.onupgradeneeded = function () { var d = req.result; ['projects', 'layers', 'files'].forEach(function (s) { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); }); };
      req.onsuccess = function () { db = req.result; res(true); };
      req.onerror = function () { memory = { projects: {}, layers: {}, files: {} }; res(false); };
    });
  }
  function tx(store, mode, fn) {
    if (memory) return Promise.resolve(fn(null, memory[store]));
    return new Promise(function (res, rej) {
      var t = db.transaction(store, mode), s = t.objectStore(store), out;
      out = fn(s, null);
      t.oncomplete = function () { res(out && typeof out === 'object' && 'readyState' in out ? out.result : out); };
      t.onerror = function () { rej(t.error || new Error('Storage error')); };
      t.onabort = function () { rej(t.error || new Error('Storage was full or blocked')); };
    });
  }
  function put(store, key, val) { return tx(store, 'readwrite', function (s, m) { if (m) { m[key] = val; return; } s.put(val, key); }); }
  function get(store, key) { return tx(store, 'readonly', function (s, m) { return m ? m[key] : s.get(key); }); }
  function del(store, key) { return tx(store, 'readwrite', function (s, m) { if (m) { delete m[key]; return; } s.delete(key); }); }
  function keys(store) { return tx(store, 'readonly', function (s, m) { return m ? Object.keys(m) : s.getAllKeys(); }); }
  function delPrefix(store, prefix) {
    return keys(store).then(function (ks) { return Promise.all(ks.filter(function (k) { return String(k).indexOf(prefix) === 0; }).map(function (k) { return del(store, k); })); });
  }

  function clean(layer) { // strip render caches
    var c = {}; for (var k in layer) if (k !== '_leaflet') c[k] = layer[k];
    if (c.items) c.items = c.items.map(function (el) { var o = {}; for (var k in el) if (k !== '_g') o[k] = el[k]; return o; });
    return c;
  }

  var Store = {
    persistent: false,
    open: function () {
      return open().then(function (ok) {
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(function (p) { Store.persistent = p; }, function () {});
        return ok;
      });
    },
    isMemoryOnly: function () { return !!memory; },
    listProjects: function () {
      return keys('projects').then(function (ks) { return Promise.all(ks.map(function (k) { return get('projects', k); })); })
        .then(function (ps) { return ps.filter(Boolean).sort(function (a, b) { return b.modified - a.modified; }); });
    },
    loadProject: function (id) {
      return get('projects', id).then(function (meta) {
        if (!meta) throw new Error('Project not found.');
        return Promise.all(meta.layerOrder.map(function (lid) { return get('layers', id + ':' + lid); })).then(function (ls) {
          var p = JSON.parse(JSON.stringify(meta)); p.layers = ls.filter(Boolean); return p;
        });
      });
    },
    /** Saves metadata and the given layers (all when dirty is null). */
    saveProject: function (p, dirty) {
      var meta = {}; for (var k in p) if (k !== 'layers') meta[k] = p[k];
      meta.layerOrder = p.layers.map(function (l) { return l.id; });
      meta.modified = Date.now();
      p.modified = meta.modified;
      var jobs = p.layers.filter(function (l) { return !dirty || dirty[l.id]; }).map(function (l) { return put('layers', p.id + ':' + l.id, clean(l)); });
      return Promise.all(jobs).then(function () { return put('projects', p.id, meta); });
    },
    deleteLayer: function (pid, lid) { return Promise.all([del('layers', pid + ':' + lid), delPrefix('files', pid + ':' + lid + ':')]); },
    deleteProject: function (id) { return Promise.all([del('projects', id), delPrefix('layers', id + ':'), delPrefix('files', id + ':')]); },
    putFile: function (pid, lid, name, data) { return put('files', pid + ':' + lid + ':' + name, data); },
    getFile: function (pid, lid, name) { return get('files', pid + ':' + lid + ':' + name); },
    /** Names of a layer's stored files, without reading them. */
    fileNames: function (pid, lid) { var pre = pid + ':' + lid + ':'; return keys('files').then(function (ks) { return ks.filter(function (k) { return String(k).indexOf(pre) === 0; }).map(function (k) { return String(k).slice(pre.length); }); }); },
    getFiles: function (pid, lid) {
      var pre = pid + ':' + lid + ':';
      return keys('files').then(function (ks) { ks = ks.filter(function (k) { return String(k).indexOf(pre) === 0; }); return Promise.all(ks.map(function (k) { return get('files', k).then(function (d) { return { name: String(k).slice(pre.length), data: d }; }); })); });
    }
  };
  global.Store = Store;
})(typeof window !== 'undefined' ? window : global);

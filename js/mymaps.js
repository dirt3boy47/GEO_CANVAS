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
    loading = job.then(function (p) { loading = null; if (p !== lib) { setLib(p); refreshRefs(); } return p; }, function (e) { loading = null; throw e; });
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
    if (l.pieces) l.pieces.forEach(function (p) { n += p.url.length; }); else if (l.dataURL) n = l.dataURL.length; else if (l.cad) n = JSON.stringify(l.cad).length; else n = 2000;
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
  function mb(n) { return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB'; }
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
        (state.open === 'f:' + s ? '<div class="mm-acts"><button class="btn" data-a="frename">Rename</button>' + (n ? '' : '<button class="btn" data-a="fdel">Delete folder</button>') + '</div>' : '');
    }).concat(list.map(function (m) {
      var here = inProject(m.id);
      return '<div class="lib-row mm-map" data-id="' + esc(m.id) + '">' + icon(m) + '<div class="lib-txt"><b>' + esc(m.name) + '</b><small>' + (KLABEL[m.kind] || m.kind) + ' · ' + mb(m.size || 0) +
        ((q || state.here) && m.folder ? ' · 📁 ' + esc(m.folder.replace(/\//g, ' › ')) : '') + (m.addedBy ? ' · ' + esc(m.addedBy) : '') + '</small></div>' +
        '<button class="ib" data-a="more" title="Map options" aria-label="Map options"><svg><use xlink:href="#i-more"/></svg></button>' +
        (here ? '<button class="btn" data-a="show">✓ Shown</button>' : '<button class="btn primary" data-a="add">Add</button>') + '</div>' +
        (state.open === m.id ? '<div class="mm-acts"><button class="btn" data-a="zoom">Zoom to</button><button class="btn" data-a="rename">Rename</button>' +
          '<label class="mm-move">Move to <select data-a="move"><option value="">My maps (top)</option>' + all.map(function (x) { return '<option value="' + esc(x) + '"' + (x === (m.folder || '') ? ' selected' : '') + '>' + esc(x.replace(/\//g, ' › ')) + '</option>'; }).join('') + '</select></label>' +
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
        var cur = state.open && byId[state.open], acts = el.querySelector('.mm-acts');
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
              edit(function (p) { p.layers = p.layers.filter(function (x) { return x.id !== cur.id; }); Store.deleteLayer(p.id, cur.id).catch(function () {}); return {}; })
                .then(function () { state.open = null; render(); GC.toast('“' + cur.name + '” deleted from My maps.'); });
            });
          };
        }
        var st = q1('#mm-store'), total = 0; lib.layers.forEach(function (x) { total += x.size || 0; });
        st.textContent = lib.layers.length + (lib.layers.length === 1 ? ' map' : ' maps') + ', about ' + mb(total) + '. ' + (GC.cloud && GC.cloud.on() ? 'Shared with the team; works offline on this device.' : 'On this device only: join a team (☁) to share them.');
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
    importFolder: importFolder, libId: libId, edit: edit, all: function () { return lib ? lib.layers : []; } };
})(window);

/* GeoCanvas web — application core: state, map, basemaps, layers, persistence, undo, sidebar.
   Every layer gets its own Leaflet pane, so the layer list order is exactly the drawing order.
   Drawing layers render through a per-layer canvas (Ink.InkPath); GIS layers through L.geoJSON. */
(function (global) {
  'use strict';
  var Geo = global.Geo, Ink = global.Ink, Store = global.Store;
  var $ = function (id) { return document.getElementById(id); };
  var GC = global.GC = { $: $, VERSION: '2026-10-29.14' };
  var TOOWOOMBA = [-27.5598, 151.9507];
  GC.TOOWOOMBA = TOOWOOMBA;

  // ---------- settings (per device) ----------
  var DEFAULTS = { coordFmt: 'dd', fingerDraw: false, crosshair: true, basemap: 'qld', tools: {}, tool: 'ballpoint', color: '#1e63d6', recent: [],
    eraserMode: 'object', eraserSize: 24, shapeKind: 'line', fill: false, dashed: false, textSize: 22 };
  GC.settings = (function () { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('gc.settings') || '{}')); } catch (e) { return Object.assign({}, DEFAULTS); } })();
  GC.saveSettings = function () { try { localStorage.setItem('gc.settings', JSON.stringify(GC.settings)); } catch (e) { /* private mode */ } };

  // ---------- small UI helpers ----------
  GC.esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  GC.toast = function (msg, kind, ms) {
    var t = document.createElement('div'); t.className = 'toast' + (kind ? ' ' + kind : ''); t.textContent = msg;
    $('toasts').appendChild(t);
    while ($('toasts').children.length > 3) $('toasts').removeChild($('toasts').firstChild);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, ms || (kind === 'err' ? 7000 : 3800));
    t.onclick = function () { if (t.parentNode) t.parentNode.removeChild(t); };
  };
  GC.busy = function (text) { $('busy').hidden = !text; $('busy-text').textContent = text || ''; };
  GC.fmtDist = function (m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2) + ' km' : (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' m'; };
  GC.fmtArea = function (a) { return a >= 1e6 ? (a / 1e6).toFixed(2) + ' km²' : (a >= 1e4 ? (a / 1e4).toFixed(2) + ' ha' : Math.round(a) + ' m²'); };
  GC.fmtTime = function (t) { var d = new Date(t); return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }); };

  var modalClose = null;
  /** Opens the modal; `build(el, close)` fills it. Returns close(). */
  GC.modal = function (html, build, onClose) {
    if (modalClose) modalClose();
    var wrap = $('modal-wrap'), old = $('modal'), el = old.cloneNode(false); // a fresh box each time: listeners added to the last dialog must not fire in this one
    old.parentNode.replaceChild(el, old);
    el.innerHTML = html; wrap.hidden = false;
    var closed = false;
    var close = function () { if (closed) return; closed = true; wrap.hidden = true; el.innerHTML = ''; modalClose = null; if (onClose) onClose(); };
    modalClose = close;
    wrap.onclick = function (e) { if (e.target === wrap && Date.now() > (GC.suppressClickUntil || 0)) close(); }; // not the lift that ends a press-and-hold
    if (build) build(el, close);
    var first = el.querySelector('input[type=text]:not([readonly]), textarea');
    if (first && !('ontouchstart' in window)) first.focus();
    return close;
  };
  GC.closeModal = function () { if (modalClose) modalClose(); };
  GC.confirm = function (title, msg, ok, danger) {
    return new Promise(function (res) {
      var answered = false;
      GC.modal('<h2>' + GC.esc(title) + '</h2><p class="sub">' + GC.esc(msg) + '</p><div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" data-a="yes">' + GC.esc(ok || 'OK') + '</button></div>',
        function (el, close) { el.querySelector('[data-a=no]').onclick = close; el.querySelector('[data-a=yes]').onclick = function () { answered = true; close(); res(true); }; },
        function () { if (!answered) res(false); });
    });
  };
  GC.prompt = function (title, value, placeholder, okLabel) {
    return new Promise(function (res) {
      var done = false;
      GC.modal('<h2>' + GC.esc(title) + '</h2><input type="text" id="pr-in" value="' + GC.esc(value || '') + '" placeholder="' + GC.esc(placeholder || '') + '"><div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="yes">' + GC.esc(okLabel || 'OK') + '</button></div>',
        function (el, close) {
          var inp = el.querySelector('#pr-in'), ok = function () { done = true; var v = inp.value.trim(); close(); res(v || null); };
          el.querySelector('[data-a=no]').onclick = close; el.querySelector('[data-a=yes]').onclick = ok;
          inp.onkeydown = function (e) { if (e.key === 'Enter') ok(); };
          setTimeout(function () { inp.focus(); inp.select(); }, 50);
        }, function () { if (!done) res(null); });
    });
  };

  /** Saves or shares a generated file. Must run inside a tap handler (iPad Safari requires a user gesture). */
  GC.saveBlob = function (blob, name) {
    var file = null;
    try { file = new File([blob], name, { type: blob.type || 'application/octet-stream' }); } catch (e) { file = null; }
    var isiPad = /iPad|iPhone/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isiPad && file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: name }).catch(function (e) { if (e && e.name !== 'AbortError') download(); });
    }
    download();
    function download() {
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 30000);
    }
    return Promise.resolve();
  };

  // ---------- map ----------
  var map = GC.map = L.map('map', { zoomControl: false, maxZoom: 22, minZoom: 3, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90,
    boxZoom: false, bounceAtZoomLimits: false, attributionControl: false });
  L.control.attribution({ position: 'bottomleft', prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 140 }).addTo(map);
  // panels drop their blur while the map moves (see body.moving in app.css): smoother panning on iPad
  var stillT = null;
  map.on('movestart zoomstart', function () { clearTimeout(stillT); document.body.classList.add('moving'); });
  map.on('moveend zoomend', function () { clearTimeout(stillT); stillT = setTimeout(function () { document.body.classList.remove('moving'); }, 150); });
  map.setView(TOOWOOMBA, 14);

  // ---------- basemaps ----------
  var QLD = 'https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/tile/{z}/{y}/{x}';
  var QLD_ATTR = 'Imagery © State of Queensland (Dept of Resources), <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>';
  var ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  var ESRI_ATTR = 'Imagery © Esri, Maxar, Earthstar Geographics';
  var LABELS = [{ url: ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', o: { maxNativeZoom: 19, attribution: 'Roads © Esri' } },
    { url: ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', o: { maxNativeZoom: 19 } }];
  GC.QLD_TILES = QLD;
  GC.BASEMAPS = {
    qld: { label: 'QLD aerial imagery', layers: [{ url: QLD, o: { maxNativeZoom: 20, attribution: QLD_ATTR, crossOrigin: true }, qld: true }] },
    qldroads: { label: 'QLD imagery + roads', layers: [{ url: QLD, o: { maxNativeZoom: 20, attribution: QLD_ATTR, crossOrigin: true }, qld: true }].concat(LABELS) },
    esri: { label: 'World imagery (Esri)', layers: [{ url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', o: { maxNativeZoom: 19, attribution: ESRI_ATTR } }] },
    esriroads: { label: 'World imagery + roads', layers: [{ url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', o: { maxNativeZoom: 19, attribution: ESRI_ATTR } }].concat(LABELS) },
    osm: { label: 'Street map (OSM)', layers: [{ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', o: { maxNativeZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' } }] },
    topo: { label: 'Topographic (OpenTopoMap)', layers: [{ url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', o: { maxNativeZoom: 17, subdomains: 'abc', attribution: 'Map © OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors, SRTM' } }] },
    none: { label: 'No basemap', layers: [] }
  };
  var baseLayers = [], baseKey = null;
  GC.setBasemap = function (key, opts) {
    opts = opts || {};
    if (!GC.BASEMAPS[key]) key = 'qld';
    baseLayers.forEach(function (l) { map.removeLayer(l); });
    baseLayers = []; baseKey = key;
    var def = GC.BASEMAPS[key];
    def.layers.forEach(function (d, i) {
      var o = Object.assign({ maxZoom: 22, keepBuffer: 4, updateWhenIdle: false, updateWhenZooming: false }, d.o); // tablets otherwise wait for the pan to end
      if (d.qld && opts.noCors) delete o.crossOrigin;
      var tl = L.tileLayer(d.url, o).addTo(map);
      tl.setZIndex(i);
      if (d.qld) watchQld(tl, key, opts);
      baseLayers.push(tl);
    });
    $('basemap').value = key;
    if (!opts.fallback) { GC.settings.basemap = key; GC.saveSettings(); if (GC.project) { GC.project.basemap = key; GC.markDirty(); } }
  };
  // The Queensland service is the best imagery for Toowoomba; if it cannot be reached, fall back automatically.
  function watchQld(tl, key, opts) {
    var ok = 0, bad = 0, done = false;
    tl.on('tileload', function () { ok++; });
    tl.on('tileerror', function () {
      bad++;
      if (done || ok || bad < 6 || navigator.onLine === false) return;
      done = true;
      if (!opts.noCors) { GC.setBasemap(key, { noCors: true, fallback: opts.fallback }); return; }
      GC.toast('The Queensland imagery service is not responding, so Esri world imagery is shown instead. You can switch back under the basemap menu.', 'warn', 8000);
      GC.setBasemap(key === 'qldroads' ? 'esriroads' : 'esri', { fallback: true });
    });
  }
  (function () {
    var sel = $('basemap');
    Object.keys(GC.BASEMAPS).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = GC.BASEMAPS[k].label; sel.appendChild(o); });
    sel.onchange = function () { GC.setBasemap(sel.value); };
  })();

  // ---------- project & layers ----------
  GC.project = null;
  GC.views = {};
  GC.layerById = function (id) { var p = GC.project; if (!p) return null; for (var i = 0; i < p.layers.length; i++) if (p.layers[i].id === id) return p.layers[i]; return null; };
  var PALETTE = ['#ff9800', '#00bcd4', '#e91e63', '#8bc34a', '#ffeb3b', '#9c27b0', '#03a9f4', '#ff5722', '#cddc39', '#f44336'];
  GC.nextLayerColor = function () { var n = GC.project ? GC.project.layers.length : 0; return PALETTE[n % PALETTE.length]; };
  GC.newDrawingLayer = function (name) { return { id: Ink.uid(), name: name, kind: 'drawing', visible: true, opacity: 1, locked: false, items: [], color: GC.nextLayerColor(), created: Date.now() }; };
  GC.newProject = function (name) {
    var l = { id: Ink.uid(), name: 'Annotations', kind: 'drawing', visible: true, opacity: 1, locked: false, items: [], color: '#1e63d6', created: Date.now() };
    return { id: Ink.uid(), name: name || 'Toowoomba field map', created: Date.now(), modified: Date.now(), notes: '',
      view: { lat: TOOWOOMBA[0], lon: TOOWOOMBA[1], zoom: 14 }, basemap: GC.settings.basemap || 'qld', activeLayer: l.id, layers: [l] };
  };

  function ensureView(l) {
    var v = GC.views[l.id]; if (v) return v;
    var pn = 'gc' + l.id.replace(/[^a-z0-9]/gi, '');
    var pane = map.getPane(pn) || map.createPane(pn);
    v = GC.views[l.id] = { pn: pn, pane: pane, group: L.layerGroup().addTo(map), paths: {}, objs: {}, markers: {}, trackLines: {}, renderer: L.canvas({ pane: pn, padding: 0.4, tolerance: 6 }) };
    return v;
  }
  function destroyView(id) {
    var v = GC.views[id]; if (!v) return;
    v.group.clearLayers(); map.removeLayer(v.group);
    if (map.hasLayer(v.renderer)) map.removeLayer(v.renderer);
    L.DomUtil.remove(v.pane); delete map._panes[v.pn]; if (map._paneRenderers) delete map._paneRenderers[v.pn];
    delete GC.views[id];
  }
  GC.destroyView = destroyView;

  /** Pane order, visibility and opacity from the layer list. */
  GC.applyLayerState = function () {
    GC.project.layers.forEach(function (l, i) {
      var v = ensureView(l);
      v.pane.style.zIndex = String(210 + Math.min(i, 380));
      v.pane.style.display = l.visible ? '' : 'none';
      v.pane.style.opacity = String(l.opacity == null ? 1 : l.opacity);
      // Over the imagery: "Hide white paper" multiplies (paper disappears, lines print on the photo); "High contrast" shows the
      // map light-for-dark (hue kept) and screens it on, so the paper vanishes and the lines glow over dark bush.
      var look = LOOK_KINDS[l.kind] ? l.blend : false;
      v.pane.style.mixBlendMode = look === 'bright' ? 'screen' : look ? 'multiply' : '';
      v.pane.style.webkitFilter = v.pane.style.filter = look === 'bright' ? 'invert(1) hue-rotate(180deg) contrast(1.35) saturate(1.7) brightness(1.15)' : '';
    });
  };
  var LOOK_KINDS = { raster: 1, geopdf: 1, libmap: 1, service: 1 };
  /** The "Over the imagery" choice in layer options (plans, GeoPDF and online maps). */
  GC.lookHtml = function (l) {
    var cur = l.blend === 'bright' ? 'bright' : l.blend ? 'white' : '';
    return '<div class="field">Over the imagery<div class="seg lo-look">' + [['', 'Normal'], ['white', 'Hide white paper'], ['bright', 'High contrast']].map(function (o) {
      return '<button type="button" data-look="' + o[0] + '"' + (o[0] === cur ? ' class="on"' : '') + '>' + o[1] + '</button>'; }).join('') + '</div></div>' +
      '<p class="hint" id="lo-look-hint"></p>' +
      '<label class="opt"><input type="checkbox" id="lo-dim"' + (GC.settings.dimImagery ? ' checked' : '') + '> Darken the imagery (helps lines stand out; applies to the whole map)</label>';
  };
  var LOOK_HINT = { '': 'The map as printed, covering the imagery (use Opacity to see through it).',
    white: 'The white paper disappears and the map prints onto the imagery. Best on light imagery; dark lines can get lost in dark bush.',
    bright: 'The paper disappears and the lines glow light over the imagery, keeping their colours (shown light-for-dark). Best on dark bush and forest.' };
  GC.bindLook = function (l, el) {
    var hint = el.querySelector('#lo-look-hint'), btns = el.querySelectorAll('.lo-look button');
    var show = function (k) { [].forEach.call(btns, function (b) { b.classList.toggle('on', b.getAttribute('data-look') === k); }); if (hint) hint.textContent = LOOK_HINT[k]; };
    [].forEach.call(btns, function (b) {
      b.onclick = function () { var k = b.getAttribute('data-look'); l.blend = k === 'bright' ? 'bright' : k === 'white'; show(k); GC.applyLayerState(); GC.markDirty(l.id); };
    });
    show(l.blend === 'bright' ? 'bright' : l.blend ? 'white' : '');
    var dim = el.querySelector('#lo-dim'); if (dim) dim.onchange = function () { GC.settings.dimImagery = dim.checked; GC.saveSettings(); GC.applyDim(); };
  };
  /** "Darken the imagery": dims the basemap (only the basemap: maps and drawings keep full strength). */
  GC.applyDim = function () { var t = map.getPane('tilePane'); t.style.webkitFilter = t.style.filter = GC.settings.dimImagery ? 'brightness(0.55) saturate(0.85)' : ''; };
  GC.applyDim();

  // Symbols for map markers (drawn inside a white disc).
  GC.SYMBOLS = {
    pin: { label: 'Pin', svg: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" fill="C"/><circle cx="12" cy="10" r="2.4" fill="#fff"/>' },
    flag: { label: 'Flag', svg: '<path d="M6 21V3" stroke="C" stroke-width="2.2" stroke-linecap="round"/><path d="M6 4h11l-2.5 4L17 12H6z" fill="C"/>' },
    star: { label: 'Star', svg: '<path d="m12 2.8 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill="C"/>' },
    warning: { label: 'Hazard', svg: '<path d="M12 3 22 20H2z" fill="C"/><path d="M12 9v5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.3" fill="#fff"/>' },
    camera: { label: 'Photo point', svg: '<rect x="3" y="7" width="18" height="13" rx="2.5" fill="C"/><path d="M8 7l1.5-3h5L16 7z" fill="C"/><circle cx="12" cy="13.5" r="3.6" fill="#fff"/><circle cx="12" cy="13.5" r="2" fill="C"/>' },
    sample: { label: 'Sample', svg: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" fill="none" stroke="C" stroke-width="2" stroke-linejoin="round"/><path d="M7 15h10l2 4H5z" fill="C"/>' },
    drill: { label: 'Bore / drillhole', svg: '<circle cx="12" cy="12" r="8" fill="none" stroke="C" stroke-width="2.4"/><circle cx="12" cy="12" r="3.2" fill="C"/>' },
    water: { label: 'Water', svg: '<path d="M12 3s6.5 7.2 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10.2 12 3 12 3z" fill="C"/>' },
    gate: { label: 'Gate', svg: '<path d="M4 4v16M20 4v16M4 8h16M4 16h16M4 16 20 8" stroke="C" stroke-width="2.2" fill="none" stroke-linecap="round"/>' },
    tree: { label: 'Tree', svg: '<circle cx="12" cy="9" r="6.5" fill="C"/><path d="M12 14v7" stroke="C" stroke-width="2.6" stroke-linecap="round"/>' },
    info: { label: 'Info', svg: '<circle cx="12" cy="12" r="9" fill="C"/><path d="M12 11v6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.4" fill="#fff"/>' }
  };
  GC.symbolSVG = function (sym, color) { var s = GC.SYMBOLS[sym] || GC.SYMBOLS.pin; return '<svg viewBox="0 0 24 24">' + s.svg.replace(/"C"/g, '"' + color + '"') + '</svg>'; };
  function markerIcon(el) {
    var label = el.title ? '<span class="ll-symbol-label">' + GC.esc(el.title) + '</span>' : '';
    var badge = el.photos && el.photos.length ? '<span class="ph-badge">' + el.photos.length + '</span>' : '';
    return L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: '<div class="ll-symbol" style="width:30px;height:30px;position:relative">' + GC.symbolSVG(el.symbol, el.color) + label + badge + '</div>' });
  }

  function addItemView(v, l, el) {
    if (el.type === 'marker') {
      var mk = L.marker([el.at[1], el.at[0]], { icon: markerIcon(el), pane: v.pn, keyboard: false, bubblingMouseEvents: false });
      mk.on('click', function () { if (GC.mode !== 'draw' || GC.tool === 'lasso') GC.inspectItem(GC.layerById(l.id), el); });
      v.group.addLayer(mk); v.markers[el.id] = mk;
    } else {
      var p = new Ink.InkPath(el, 1);
      p.options.renderer = v.renderer; p.options.pane = v.pn;
      v.group.addLayer(p); v.paths[el.id] = p;
    }
    v.objs[el.id] = el;
  }
  function removeItemView(v, id) {
    if (v.paths[id]) { v.group.removeLayer(v.paths[id]); delete v.paths[id]; }
    if (v.markers[id]) { v.group.removeLayer(v.markers[id]); delete v.markers[id]; }
    delete v.objs[id];
  }
  /** Brings a drawing layer's rendered items in line with layer.items (items are immutable; edits replace objects). */
  GC.syncDrawing = function (l) {
    var v = ensureView(l), seen = {};
    l.items.forEach(function (el) {
      seen[el.id] = true;
      if (v.objs[el.id] === el) return;
      removeItemView(v, el.id); addItemView(v, l, el);
    });
    Object.keys(v.objs).forEach(function (id) { if (!seen[id]) removeItemView(v, id); });
  };

  function featStyle(l, f, point) {
    var p = (f && f.properties) || {}, s = l.style || {}, file = s.useFileStyle !== false;
    var color = (file && (p.stroke || p['marker-color'] || p.fill)) || s.color || '#ff9800';
    var o = { color: color, weight: (file && +p['stroke-width']) || s.width || 2, opacity: (file && p['stroke-opacity'] != null) ? +p['stroke-opacity'] : 1,
      fillColor: (file && p.fill) || color, fillOpacity: (file && p['fill-opacity'] != null) ? Math.min(+p['fill-opacity'], 0.85) : (s.fillOpacity == null ? 0.2 : s.fillOpacity) };
    if (point) { o.fillColor = (file && p['marker-color']) || color; o.fillOpacity = 0.9; o.color = '#fff'; o.weight = 1.5; }
    return o;
  }
  GC.featStyle = featStyle;

  // ---------- Google Earth style places: folder tree, per-placemark visibility, icons ----------
  /** Which features of a vector layer are shown (own eye and every enclosing folder's eye). */
  GC.featVisibility = function (l) {
    var n = (l.geojson.features || []).length, hf = l.hiddenFeats || {}, vis = new Array(n), i;
    if (!l.tree) { for (i = 0; i < n; i++) vis[i] = !hf[i]; return vis; }
    for (i = 0; i < n; i++) vis[i] = false;
    (function walk(nodes, off) { nodes.forEach(function (nd) { if (typeof nd === 'number') vis[nd] = !off && !hf[nd]; else walk(nd.c, off || nd.h); }); })(l.tree, false);
    return vis;
  };
  /** Tree of a vector layer: its KML folders, or a flat list of its features. */
  GC.layerTree = function (l) {
    if (l.tree) return l.tree;
    var a = [], n = (l.geojson.features || []).length; for (var i = 0; i < n; i++) a.push(i); return a;
  };
  GC.featName = function (l, i) {
    var f = l.geojson.features[i], p = (f && f.properties) || {}, t = p.name;
    if (t == null || t === '') t = l.labelField ? p[l.labelField] : null;
    if (t == null || t === '') t = (f && f.geometry ? ({ Point: 'Point', MultiPoint: 'Points', LineString: 'Line', MultiLineString: 'Lines', Polygon: 'Polygon', MultiPolygon: 'Polygons' }[f.geometry.type] || 'Feature') : 'Feature') + ' ' + (i + 1);
    return String(t);
  };
  var openState = (function () { try { return JSON.parse(localStorage.getItem('gc.open') || '{}'); } catch (e) { return {}; } })();
  /** Expanded folders are remembered per device (like the Places panel), not synced. */
  GC.isOpen = function (key, dflt) { return key in openState ? !!openState[key] : !!dflt; };
  GC.setOpen = function (key, v) { openState[key] = v ? 1 : 0; try { localStorage.setItem('gc.open', JSON.stringify(openState)); } catch (e) { /* ignore */ } };

  var PADDLE = { red: '#e53935', blu: '#3b6ee8', grn: '#2e9e44', ylw: '#f4d03f', wht: '#ffffff', purple: '#8e44ad', orange: '#f39c12', pink: '#ec7fb6', ltblu: '#5dade2', blue: '#3b6ee8', green: '#2e9e44', yellow: '#f4d03f', white: '#ffffff' };
  function shapeSvg(shape, c, s) {
    var o = 'stroke="#222" stroke-opacity=".75" stroke-width="1.4"';
    var body = {
      pin: '<path d="M12 22.5s-7-6.8-7-11.9a7 7 0 0 1 14 0c0 5.1-7 11.9-7 11.9z" fill="' + c + '" ' + o + '/><circle cx="12" cy="10.4" r="2.6" fill="#fff" fill-opacity=".85"/>',
      dot: '<circle cx="12" cy="12" r="8.5" fill="' + c + '" ' + o + '/><circle cx="9.5" cy="9.3" r="3" fill="#fff" fill-opacity=".45"/>',
      square: '<rect x="4" y="4" width="16" height="16" rx="1.5" fill="' + c + '" ' + o + '/>',
      star: '<path d="m12 2.6 2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5-4.9-4.6 6.6-.8z" fill="' + c + '" ' + o + '/>',
      triangle: '<path d="M12 3.5 21 20H3z" fill="' + c + '" ' + o + '/>',
      diamond: '<path d="M12 2.5 21.5 12 12 21.5 2.5 12z" fill="' + c + '" ' + o + '/>',
      donut: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="' + c + '" stroke-width="4.5"/><circle cx="12" cy="12" r="9.7" fill="none" stroke="#222" stroke-opacity=".5" stroke-width=".8"/>',
      target: '<circle cx="12" cy="12" r="8" fill="none" stroke="' + c + '" stroke-width="2.6"/><circle cx="12" cy="12" r="3.2" fill="' + c + '"/>'
    }[shape];
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" style="display:block;overflow:visible;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))">' + body + '</svg>';
  }
  /** Leaflet icon for a KML placemark: Google's standard icons drawn as tinted shapes; other images as they are. */
  GC.placemarkIcon = function (l, f) {
    var p = f.properties || {}, href = String(p.icon || ''), sc = p['icon-scale'] == null || !isFinite(+p['icon-scale']) ? 1 : +p['icon-scale'];
    if (sc <= 0) return L.divIcon({ className: '', iconSize: [0, 0], iconAnchor: [0, 0], html: '' });
    var size = Math.max(12, Math.min(64, Math.round(26 * sc))), file = href.split(/[\/?#]/).filter(Boolean).pop() || '', lc = file.toLowerCase();
    var tint = p['icon-color'] && !/^#?f{6}$/i.test(p['icon-color']) ? p['icon-color'] : null, named = null;
    Object.keys(PADDLE).some(function (k) { if (lc.indexOf(k + '-') === 0 || lc.indexOf(k + '.') === 0 || lc.indexOf(k + '_') === 0) { named = PADDLE[k]; return true; } return false; });
    var shape = !href ? 'pin' : /pushpin|paddle|pin\b|placemark\.png/.test(lc) ? 'pin' : /shaded_dot|placemark_circle|dot|circle|road_shield/.test(lc) ? 'dot' : /square/.test(lc) ? 'square' : /star/.test(lc) ? 'star' :
      /triangle/.test(lc) ? 'triangle' : /diamond/.test(lc) ? 'diamond' : /donut/.test(lc) ? 'donut' : /target|cross-?hairs/.test(lc) ? 'target' : null;
    var google = !href || /google\.com|gstatic|mapfiles|\/kml\/(shapes|paddle|pushpin|pal\d)/i.test(href);
    if (shape && (google || !(l.icons && l.icons[href]))) {
      var c = tint || named || (shape === 'pin' ? '#f4d03f' : (shape === 'dot' ? '#ffffff' : '#f4d03f'));
      return L.divIcon({ className: 'gc-pm', iconSize: [size, size], iconAnchor: shape === 'pin' ? [size / 2, size * 0.94] : [size / 2, size / 2], html: shapeSvg(shape, c, size) });
    }
    var url = (l.icons && l.icons[href]) || (/^(https?:)?\/\//i.test(href) ? href.replace(/^(http:)?\/\//i, 'https://') : null);
    if (!url) return L.divIcon({ className: 'gc-pm', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: shapeSvg('dot', tint || '#ffffff', size) });
    return L.divIcon({ className: 'gc-pm', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: '<img src="' + GC.esc(url) + '" alt="" style="width:' + size + 'px;height:' + size + 'px;display:block;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))">' });
  };

  /** An image placed by three corners (top-left, top-right, bottom-left), so it can be rotated, scaled and skewed:
      georeferenced plans. Drawn as one <img> with a CSS matrix, which follows the map's zoom animation. */
  GC.AffineImage = L.Layer.extend({
    initialize: function (url, corners, options) { this._url = url; this._corners = corners; L.setOptions(this, options); },
    onAdd: function () {
      var img = this._img = L.DomUtil.create('img', 'leaflet-image-layer gc-affine leaflet-zoom-animated'), self = this;
      img.style.position = 'absolute'; img.style.left = '0'; img.style.top = '0';
      img.style.webkitTransformOrigin = img.style.transformOrigin = '0 0'; img.style.maxWidth = 'none'; img.style.maxHeight = 'none';
      img.onload = function () { self._w = img.naturalWidth; self._h = img.naturalHeight; img.style.width = self._w + 'px'; img.style.height = self._h + 'px'; self._reset(); };
      if (this.options.clip) img.style.webkitClipPath = img.style.clipPath = 'polygon(' + this.options.clip.map(function (p) { return p[0] + '% ' + p[1] + '%'; }).join(',') + ')'; // GeoPDF: only the map frame
      img.alt = ''; img.src = this._url;
      this.getPane().appendChild(img);
    },
    onRemove: function () { L.DomUtil.remove(this._img); },
    getEvents: function () { return { zoom: this._reset, viewreset: this._reset, zoomanim: this._animateZoom }; },
    setCorners: function (c) { this._corners = c; this._reset(); return this; },
    _apply: function (p) {
      if (!this._w) return;
      var w = this._w, h = this._h, a = p[0], b = p[1], c = p[2];
      var m = 'matrix(' + [(b.x - a.x) / w, (b.y - a.y) / w, (c.x - a.x) / h, (c.y - a.y) / h, a.x, a.y].join(',') + ')';
      this._img.style.webkitTransform = this._img.style.transform = m;
    },
    _reset: function () { var m = this._map; if (m) { var o = m.getPixelOrigin(); this._apply(this._corners.map(function (ll) { return m.project(L.latLng(ll))._subtract(o); })); } }, // unrounded: small pieces stay exact
    _animateZoom: function (e) { var m = this._map; this._apply(this._corners.map(function (ll) { return m._latLngToNewLayerPoint(L.latLng(ll), e.zoom, e.center); })); }
  });

  /** A CAD reference drawing (kind "cad"), drawn on its own canvas: lines in CAD colours, text scaled with the map
      (hidden when too small to read). Only what is on screen is drawn; redrawn when the map stops moving. */
  GC.CadLayer = L.Layer.extend({
    initialize: function (l, options) { this._l = l; L.setOptions(this, options); },
    onAdd: function (map) {
      this._cv = L.DomUtil.create('canvas', 'gc-cad');
      this._cv.style.position = 'absolute'; this._cv.style.pointerEvents = 'none';
      this.getPane().appendChild(this._cv);
      this._prep(); this._draw();
    },
    onRemove: function () { L.DomUtil.remove(this._cv); },
    getEvents: function () { return { moveend: this._draw, zoomstart: this._hide, resize: this._draw, viewreset: this._draw }; },
    _hide: function () { this._cv.style.visibility = 'hidden'; },
    _prep: function () { // mercator coordinates and bounding boxes, once
      var c = this._l.cad;
      this._lines = c.lines.map(function (a) {
        var n = (a.length - 1) / 2, m = new Float64Array(n * 2), b = [Infinity, Infinity, -Infinity, -Infinity];
        for (var k = 0; k < n; k++) { var q = Geo.merc(a[1 + 2 * k], a[2 + 2 * k]); m[2 * k] = q[0]; m[2 * k + 1] = q[1]; if (q[0] < b[0]) b[0] = q[0]; if (q[0] > b[2]) b[2] = q[0]; if (q[1] < b[1]) b[1] = q[1]; if (q[1] > b[3]) b[3] = q[1]; }
        return { c: a[0], m: m, b: b };
      });
      this._texts = (c.texts || []).map(function (t) { return { c: t[0], m: Geo.merc(t[1], t[2]), lat: t[2], h: t[3], r: t[4], ax: t[5], ay: t[6], s: t[7] }; });
    },
    _draw: function () {
      var map = this._map; if (!map) return;
      var l = this._l, size = map.getSize(), pad = 0.3, w = Math.round(size.x * (1 + 2 * pad)), h = Math.round(size.y * (1 + 2 * pad)), dpr = Math.min(2, global.devicePixelRatio || 1);
      var tl = map.containerPointToLayerPoint([-size.x * pad, -size.y * pad]).round(), cv = this._cv;
      L.DomUtil.setPosition(cv, tl);
      cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px'; cv.style.visibility = '';
      var x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
      var ws = 256 * Math.pow(2, map.getZoom()), o = map.getPixelOrigin(), ox = o.x + tl.x, oy = o.y + tl.y;
      var vb = [ox / ws, oy / ws, (ox + w) / ws, (oy + h) / ws], colors = l.cad.colors, mono = l.mono;
      x.lineWidth = 1.4; x.lineJoin = 'round'; x.lineCap = 'round';
      var byColor = {};
      this._lines.forEach(function (ln) { if (ln.b[2] < vb[0] || ln.b[0] > vb[2] || ln.b[3] < vb[1] || ln.b[1] > vb[3]) return; (byColor[ln.c] = byColor[ln.c] || []).push(ln); });
      Object.keys(byColor).forEach(function (ci) {
        x.strokeStyle = mono || colors[ci]; x.beginPath();
        byColor[ci].forEach(function (ln) { var m = ln.m; x.moveTo(m[0] * ws - ox, m[1] * ws - oy); for (var k = 2; k < m.length; k += 2) x.lineTo(m[k] * ws - ox, m[k + 1] * ws - oy); });
        x.stroke();
      });
      if (l.showText === false || !this._texts.length) return;
      var mpp = Geo.metersPerPixel(map.getZoom(), map.getCenter().lat);
      this._texts.forEach(function (t) {
        var px = t.h / mpp; if (px < 5 || px > 600) return;
        var sx = t.m[0] * ws - ox, sy = t.m[1] * ws - oy; if (sx < -500 || sy < -500 || sx > w + 500 || sy > h + 500) return;
        var rows = t.s.split('\n'); x.save(); x.translate(sx, sy); x.rotate(-t.r * Math.PI / 180);
        x.font = px.toFixed(1) + 'px -apple-system, Helvetica, Arial, sans-serif'; x.fillStyle = mono || colors[t.c];
        x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = 2;
        var lh = px * 1.35, top = -(1 - t.ay) * (rows.length - 1) * lh; // top-attached text flows down from its anchor
        rows.forEach(function (row, i) { var tw = x.measureText(row).width; x.fillText(row, -t.ax * tw, top + i * lh + (t.ay === 1 ? px * 0.8 : t.ay === 0.5 ? px * 0.35 : 0)); });
        x.restore();
      });
    }
  });

  /** (Re)creates the Leaflet layers of any layer. */
  GC.renderLayer = function (l) {
    var v = ensureView(l);
    v.group.clearLayers(); v.paths = {}; v.objs = {}; v.markers = {}; v.trackLines = {};
    if (l.kind === 'drawing') { GC.syncDrawing(l); return; }
    if (l.kind === 'libmap') { // a map from My maps: drawn from the library's copy
      var src = GC.mymaps && GC.mymaps.get(l.ref);
      if (!src) return;
      if (src.kind === 'geopdf' || src.kind === 'raster') v.group.addLayer(new GC.MapPieces(src, { pane: v.pn })); // from this device or streamed from the cloud
      else if (src.kind === 'cad') v.group.addLayer(new GC.CadLayer(Object.assign({}, src, { showText: l.showText != null ? l.showText : src.showText, mono: l.mono }), { pane: v.pn }));
      return;
    }
    if (l.kind === 'vector') {
      var vis = GC.featVisibility(l), shown = (l.geojson.features || []).filter(function (f, i) { return vis[i]; });
      var n = shown.length, kml = !!l.tree, labels = l.labelField && n <= 600, npts = 0;
      shown.forEach(function (f) { if (f.geometry && /Point/.test(f.geometry.type)) npts++; });
      var icons = npts <= 1500;
      var gj = L.geoJSON({ type: 'FeatureCollection', features: shown }, {
        pane: v.pn, renderer: v.renderer,
        interactive: false,
        style: function (f) { return featStyle(l, f, /Point/.test(f.geometry && f.geometry.type)); },
        pointToLayer: function (f, ll) {
          if (icons && (kml || (f.properties && f.properties.icon))) return L.marker(ll, { icon: GC.placemarkIcon(l, f), pane: v.pn, interactive: false, keyboard: false });
          return L.circleMarker(ll, Object.assign({ radius: 6, pane: v.pn, renderer: v.renderer, interactive: false }, featStyle(l, f, true)));
        },
        onEachFeature: function (f, lay) {
          var p = f.properties || {}, pt = /Point/.test(f.geometry && f.geometry.type);
          if (kml) { // Google Earth: placemark names next to point icons
            var t = p.name != null && p.name !== '' ? p.name : (l.labelField ? p[l.labelField] : null), ls = p['label-scale'] == null ? 1 : +p['label-scale'];
            if (pt && icons && t != null && t !== '' && ls > 0 && lay.options.icon) {
              var sz = lay.options.icon.options.iconSize || [0, 0], an = lay.options.icon.options.iconAnchor || [0, 0];
              lay.bindTooltip('<span style="' + (p['label-color'] ? 'color:' + p['label-color'] + ';' : '') + 'font-size:' + Math.round(12.5 * Math.min(2, ls)) + 'px">' + GC.esc(t) + '</span>',
                { permanent: true, direction: 'right', offset: [sz[0] - an[0] - 4, sz[1] / 2 - an[1]], className: 'gc-plabel', pane: 'tooltipPane' });
            }
          } else if (labels && p[l.labelField] != null && p[l.labelField] !== '') lay.bindTooltip(GC.esc(p[l.labelField]), { permanent: true, direction: 'center', className: 'gc-label', pane: 'tooltipPane' });
        }
      });
      v.group.addLayer(gj);
    } else if (l.kind === 'raster') {
      v.group.addLayer(l.corners ? new GC.AffineImage(l.dataURL, l.corners, { pane: v.pn }) : L.imageOverlay(l.dataURL, l.bounds, { pane: v.pn, interactive: false }));
    } else if (l.kind === 'cad') {
      v.group.addLayer(new GC.CadLayer(l, { pane: v.pn }));
    } else if (l.kind === 'geopdf') {
      (l.pieces || []).forEach(function (p) { v.group.addLayer(new GC.AffineImage(p.url, p.c, { pane: v.pn, clip: p.clip })); });
    } else if (l.kind === 'service') {
      if (GC.library) v.group.addLayer(GC.library.tileLayer(l, v.pn));
    } else if (l.kind === 'track') {
      (l.tracks || []).forEach(function (t) {
        if (!t.points.length) return;
        var lls = t.points.map(function (p) { return [p[1], p[0]]; });
        v.group.addLayer(L.polyline(lls, { pane: v.pn, renderer: v.renderer, color: '#ffffff', weight: 7, opacity: 0.8, interactive: false }));
        var pl = L.polyline(lls, { pane: v.pn, renderer: v.renderer, color: l.color || '#ff3d00', weight: 4, interactive: false });
        pl._gcTrack = t;
        v.group.addLayer(pl);
        v.group.addLayer(L.circleMarker(lls[0], { pane: v.pn, renderer: v.renderer, radius: 5, color: '#fff', weight: 2, fillColor: '#2e9e44', fillOpacity: 1, interactive: false }));
        v.trackLines[t.started || 0] = pl;
      });
    } else if (l.kind === 'waypoints') {
      var cam = GC.camera;
      (l.waypoints || []).forEach(function (w) {
        var pin = cam && cam.isPhotoPt(l, w); if (pin && !cam.shown(l, w)) return;
        if (w.geom && cam) { // a drawn action: its area or line in the importance colour, under its pin
          var col = cam.impOf(w).c, flip = function (q) { return [q[1], q[0]]; };
          var shp = w.geom.type === 'Polygon' ? L.polygon(w.geom.coordinates[0].map(flip), { pane: v.pn, renderer: v.renderer, color: col, weight: 3, fillColor: col, fillOpacity: w.chk ? 0.08 : 0.2, dashArray: w.chk ? '6 5' : null, interactive: false })
            : L.polyline(w.geom.coordinates.map(flip), { pane: v.pn, renderer: v.renderer, color: col, weight: 4, dashArray: w.chk ? '6 5' : null, interactive: false });
          shp._gcWp = w; v.group.addLayer(shp);
        }
        // photo points: a pin coloured by importance with the category's symbol; other waypoints: a dot
        var m = pin ? L.marker([w.lat, w.lon], { pane: v.pn, icon: cam.icon(l, w), interactive: false, keyboard: false })
          : L.circleMarker([w.lat, w.lon], { pane: v.pn, renderer: v.renderer, radius: 7, color: '#fff', weight: 2, fillColor: l.color || '#e8590c', fillOpacity: 1, interactive: false });
        m._gcWp = w;
        if (w.name) m.bindTooltip(GC.esc(w.name) + (!pin && w.photos && w.photos.length ? ' 📷' : ''), { permanent: (l.waypoints.length < 150), direction: 'right', offset: pin ? [12, -20] : [8, 0], className: 'gc-label' });
        v.group.addLayer(m);
      });
    }
  };

  GC.layerBounds = function (l) {
    var b = null, add = function (lat, lon) { if (!isFinite(lat) || !isFinite(lon)) return; if (!b) b = L.latLngBounds([lat, lon], [lat, lon]); else b.extend([lat, lon]); };
    if (l.kind === 'drawing') l.items.forEach(function (el) { var m = Ink.mercBounds(el), a = Geo.unmerc(m[0], m[1]), c = Geo.unmerc(m[2], m[3]); add(a[1], a[0]); add(c[1], c[0]); });
    else if (l.kind === 'vector') { var bb = global.Importers.bounds(l.geojson); if (isFinite(bb[0])) { add(bb[1], bb[0]); add(bb[3], bb[2]); } }
    else if (l.kind === 'raster' || l.kind === 'cad' || l.kind === 'geopdf' || (l.kind === 'service' && l.bounds)) { add(l.bounds[0][0], l.bounds[0][1]); add(l.bounds[1][0], l.bounds[1][1]); }
    else if (l.kind === 'libmap') { var s0 = GC.mymaps && GC.mymaps.get(l.ref); if (s0 && s0.bounds) { add(s0.bounds[0][0], s0.bounds[0][1]); add(s0.bounds[1][0], s0.bounds[1][1]); } }
    else if (l.kind === 'track') (l.tracks || []).forEach(function (t) { t.points.forEach(function (p) { add(p[1], p[0]); }); });
    else if (l.kind === 'waypoints') (l.waypoints || []).forEach(function (w) { add(w.lat, w.lon); if (w.geom) (w.geom.type === 'Polygon' ? w.geom.coordinates[0] : w.geom.coordinates).forEach(function (q) { add(q[1], q[0]); }); });
    return b;
  };
  GC.zoomToLayer = function (l) {
    var b = GC.layerBounds(l);
    if (!b) { GC.toast('“' + l.name + '” is empty.'); return; }
    if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), Math.max(map.getZoom(), 17)); else map.fitBounds(b, { padding: [60, 60], maxZoom: 19 });
  };

  GC.layerCount = function (l) {
    if (l.kind === 'drawing') return l.items.length + (l.items.length === 1 ? ' item' : ' items');
    if (l.kind === 'vector') { var n = (l.geojson.features || []).length; return n + (n === 1 ? ' feature' : ' features'); }
    if (l.kind === 'raster') return 'Image';
    if (l.kind === 'track') { var d = 0, pts = 0; (l.tracks || []).forEach(function (t) { d += t.distance || 0; pts += t.points.length; }); return (l.tracks || []).length + ' track' + ((l.tracks || []).length === 1 ? '' : 's') + ' · ' + GC.fmtDist(d); }
    if (l.kind === 'waypoints' && l.photoPts && GC.camera) { var wn = (l.waypoints || []).length, ws = l.waypoints.filter(function (w) { return GC.camera.shown(l, w); }).length; return wn + (wn === 1 ? ' photo point' : ' photo points') + (ws < wn ? ' · ' + ws + ' shown' : ''); }
    if (l.kind === 'waypoints') return (l.waypoints || []).length + ' waypoints';
    if (l.kind === 'cad') return 'reference drawing · ' + l.cad.lines.length.toLocaleString() + ' lines';
    if (l.kind === 'service') return 'online map · ' + l.service.source;
    if (l.kind === 'geopdf') return 'map sheet · ' + l.crs;
    if (l.kind === 'libmap') { var s1 = GC.mymaps && GC.mymaps.get(l.ref); return s1 ? 'My maps' + (s1.folder ? ' › ' + s1.folder.replace(/\//g, ' › ') : '') : (GC.mymaps && GC.mymaps.all().length ? 'missing from My maps' : 'loading from My maps…'); }
    return '';
  };
  var KIND = { drawing: 'Annotation', vector: 'GIS', raster: 'Raster', track: 'GPS track', waypoints: 'Waypoints', cad: 'CAD', service: 'Map', geopdf: 'GeoPDF' };
  GC.kindLabel = function (l) { if (l.kind === 'libmap') { var s2 = GC.mymaps && GC.mymaps.get(l.ref); return s2 ? GC.kindLabel(s2) : 'Map'; } return (l.kind === 'vector' || l.format === 'Plan') && l.format ? l.format : KIND[l.kind]; };

  /** Inserts imported layers below the annotation layers by default. */
  GC.insertLayer = function (l, onTop) {
    var ls = GC.project.layers, i = ls.length;
    if (!onTop) { for (var k = 0; k < ls.length; k++) if (ls[k].kind === 'drawing') { i = k; break; } }
    ls.splice(i, 0, l);
    GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id); GC.refreshLayers();
  };
  GC.removeLayer = function (id) {
    var p = GC.project, i = p.layers.findIndex(function (l) { return l.id === id; });
    if (i < 0) return;
    p.layers.splice(i, 1); destroyView(id);
    GC.history.undo = GC.history.undo.filter(function (ch) { return !ch.some(function (c) { return c.lid === id; }); });
    GC.history.redo = GC.history.redo.filter(function (ch) { return !ch.some(function (c) { return c.lid === id; }); });
    GC.updateUndo();
    if (GC.clearSelection) GC.clearSelection();
    if (p.activeLayer === id) { var d = p.layers.filter(function (l) { return l.kind === 'drawing'; }).pop(); p.activeLayer = d ? d.id : null; }
    Store.deleteLayer(p.id, id).catch(function () {});
    GC.applyLayerState(); GC.markDirty(); GC.refreshLayers();
  };

  // ---------- persistence ----------
  var dirty = {}, saveTimer = null, saving = false, again = false, allDirty = false;
  function setStatus(text, err) { var s = $('save-status'); s.textContent = text; s.className = err ? 'err' : ''; }
  GC.markDirty = function (lid, soon) {
    if (!GC.project) return;
    if (lid) dirty[lid] = true;
    setStatus('Editing…');
    clearTimeout(saveTimer); saveTimer = setTimeout(GC.saveNow, soon ? 150 : 700);
  };
  GC.markAllDirty = function () { allDirty = true; GC.markDirty(); };
  GC.saveNow = function () {
    if (!GC.project) return Promise.resolve();
    clearTimeout(saveTimer);
    if (saving) { again = true; return Promise.resolve(); }
    var d = allDirty ? null : dirty, p = GC.project;
    dirty = {}; allDirty = false; saving = true; setStatus('Saving…');
    return Store.saveProject(p, d).then(function () {
      saving = false;
      setStatus(Store.isMemoryOnly() ? 'Not stored — private browsing' : 'Saved ' + new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }), Store.isMemoryOnly());
      if (again) { again = false; return GC.saveNow(); }
    }, function (e) {
      saving = false;
      if (d) Object.keys(d).forEach(function (k) { dirty[k] = true; }); else allDirty = true;
      setStatus('NOT SAVED', true);
      GC.toast('Could not save: ' + (e && e.message ? e.message : e) + '. Free up storage on the iPad, then make any change to retry. Back up the project (Project tab) to be safe.', 'err', 10000);
    });
  };
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') GC.saveNow(); });
  window.addEventListener('pagehide', function () { GC.saveNow(); });

  var viewTimer = null;
  map.on('moveend', function () {
    if (!GC.project) return;
    var c = map.getCenter(); GC.project.view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
    clearTimeout(viewTimer); viewTimer = setTimeout(function () { GC.markDirty(); }, 1500);
  });

  /** Opens a project object (already loaded) into the map. */
  GC.openProject = function (p) {
    Object.keys(GC.views).forEach(destroyView);
    GC.project = p;
    p.layers.forEach(function (l) { if (l.kind === 'drawing' && !l.items) l.items = []; });
    GC.history.undo = []; GC.history.redo = []; GC.updateUndo();
    if (GC.clearSelection) GC.clearSelection();
    p.layers.forEach(GC.renderLayer); GC.applyLayerState();
    if (!GC.layerById(p.activeLayer) || GC.layerById(p.activeLayer).kind !== 'drawing') { var d = p.layers.filter(function (l) { return l.kind === 'drawing'; })[0]; p.activeLayer = d ? d.id : null; }
    if (p.view) map.setView([p.view.lat, p.view.lon], p.view.zoom, { animate: false });
    GC.setBasemap(p.basemap || GC.settings.basemap, { fallback: true });
    $('project-name').textContent = p.name; $('proj-name').value = p.name; $('proj-notes').value = p.notes || '';
    document.title = p.name + ' — GeoCanvas';
    try { localStorage.setItem('gc.lastProject', p.id); } catch (e) { /* ignore */ }
    GC.refreshLayers();
    if (GC.closeInspector) GC.closeInspector();
    setStatus(Store.isMemoryOnly() ? 'Not stored — private browsing' : 'Saved', Store.isMemoryOnly());
  };

  // ---------- undo / redo (layer item snapshots; items are immutable) ----------
  GC.history = { undo: [], redo: [] };
  GC.updateUndo = function () { $('btn-undo').disabled = !GC.history.undo.length; $('btn-redo').disabled = !GC.history.redo.length; };
  function applySide(changes, side) {
    changes.forEach(function (c) { var l = GC.layerById(c.lid); if (!l) return; l.items = c[side]; GC.syncDrawing(l); GC.markDirty(l.id); });
  }
  /** changes: [{lid, before, after}] — applies `after` and records the step. */
  GC.commit = function (changes) {
    changes = changes.filter(function (c) { return c.before !== c.after; });
    if (!changes.length) return;
    applySide(changes, 'after');
    GC.history.undo.push(changes); if (GC.history.undo.length > 300) GC.history.undo.shift();
    GC.history.redo = []; GC.updateUndo(); GC.refreshLayers(true);
  };
  GC.editLayer = function (lid, fn) { var l = GC.layerById(lid); var before = l.items, after = fn(before.slice()); GC.commit([{ lid: lid, before: before, after: after }]); };
  GC.undo = function () { var ch = GC.history.undo.pop(); if (!ch) return; if (GC.clearSelection) GC.clearSelection(); applySide(ch, 'before'); GC.history.redo.push(ch); GC.updateUndo(); GC.refreshLayers(true); };
  GC.redo = function () { var ch = GC.history.redo.pop(); if (!ch) return; if (GC.clearSelection) GC.clearSelection(); applySide(ch, 'after'); GC.history.undo.push(ch); GC.updateUndo(); GC.refreshLayers(true); };
  $('btn-undo').onclick = GC.undo; $('btn-redo').onclick = GC.redo;

  // ---------- sidebar ----------
  var ICON = function (id) { return '<svg><use xlink:href="#i-' + id + '"/></svg>'; };
  GC.icon = ICON;
  GC.drawingLayers = function () { return GC.project.layers.filter(function (l) { return l.kind === 'drawing'; }); };
  GC.refreshLayers = function (countsOnly) {
    var p = GC.project; if (!p) return;
    var list = $('layer-list');
    if (countsOnly) {
      p.layers.forEach(function (l) { var el = list.querySelector('.layer[data-id="' + l.id + '"] > .lrow .lsub'); if (el) el.textContent = layerSub(l); });
      return;
    }
    list.innerHTML = p.layers.slice().reverse().map(function (l) {
      var cls = 'layer' + (l.id === p.activeLayer ? ' active' : '') + (l.visible ? '' : ' hidden-layer');
      var sw = l.kind === 'vector' ? ((l.style && l.style.color) || '#ff9800') : (l.color || '#888');
      var tree = l.kind === 'vector', open = tree && GC.isOpen(l.id, false);
      var h = '<li class="' + cls + '" data-id="' + l.id + '"><div class="lrow"><span class="grip" title="Drag to reorder">' + ICON('grip') + '</span>' +
        (tree ? '<button class="tw' + (open ? ' open' : '') + '" data-act="tw" title="' + (open ? 'Collapse' : 'Expand') + '">' + ICON('caret') + '</button>' : '<span class="tw-sp"></span>') +
        '<span class="sw" style="background:' + sw + '"></span>' +
        '<div class="ltext"><div class="lname">' + GC.esc(l.name) + '</div><div class="lsub">' + GC.esc(layerSub(l)) + '</div></div>' +
        (l.kind === 'drawing' ? '<button class="ib' + (l.locked ? ' locked' : '') + '" data-act="lock" title="' + (l.locked ? 'Unlock' : 'Lock') + '">' + ICON(l.locked ? 'lock' : 'unlock') + '</button>' : '') +
        '<button class="ib" data-act="more" title="Layer options">' + ICON('more') + '</button>' +
        '<button class="ib eye" data-act="vis" title="' + (l.visible ? 'Hide' : 'Show') + '">' + ICON(l.visible ? 'eye' : 'eyeoff') + '</button></div>';
      if (open) { var rows = []; treeRows(l, GC.layerTree(l), 0, !l.visible, rows, ''); h += '<ul class="tree">' + rows.join('') + '</ul>'; }
      return h + '</li>';
    }).join('');
    $('layer-count').textContent = p.layers.length + (p.layers.length === 1 ? ' layer' : ' layers');
    var dl = GC.drawingLayers(), opts = dl.slice().reverse().map(function (l) { return '<option value="' + l.id + '">' + GC.esc(l.name) + (l.locked ? ' (locked)' : '') + '</option>'; }).join('');
    $('active-layer').innerHTML = opts + '<option value="__new">+ New layer…</option>';
    $('active-layer').value = p.activeLayer || '__new';
    $('sel-layer').innerHTML = '<option value="">Move to layer…</option>' + opts;
  };
  function layerSub(l) { return GC.kindLabel(l) + ' · ' + GC.layerCount(l) + (l.opacity < 1 ? ' · ' + Math.round(l.opacity * 100) + '%' : ''); }
  var shownLimit = {}; // "layer:folder" → rows shown in very large folders
  var GEOM_ICON = { Point: 'gpt', MultiPoint: 'gpt', LineString: 'gline', MultiLineString: 'gline', Polygon: 'gpoly', MultiPolygon: 'gpoly' };
  function treeRows(l, nodes, depth, off, out, key) {
    var hf = l.hiddenFeats || {}, lim = shownLimit[l.id + ':' + key] || 250, sel = GC.selFeat && GC.selFeat.lid === l.id ? GC.selFeat.idx : -1;
    nodes.slice(0, lim).forEach(function (nd) {
      if (typeof nd === 'number') {
        var f = l.geojson.features[nd], g = f && f.geometry, gt = g && (g.type === 'GeometryCollection' ? (g.geometries[0] || {}).type : g.type), st = f ? featStyle(l, f, gt === 'Point' || gt === 'MultiPoint') : {};
        var col = gt === 'Point' || gt === 'MultiPoint' ? (f.properties && f.properties['icon-color']) || st.fillColor : st.color;
        out.push('<li class="tn' + (off || hf[nd] ? ' off' : '') + (nd === sel ? ' sel' : '') + '" data-n="p' + nd + '" style="--d:' + depth + '"><span class="tw-sp"></span>' +
          '<svg class="ti" style="color:' + GC.esc(col || '#888') + '"><use xlink:href="#i-' + (GEOM_ICON[gt] || 'gpt') + '"/></svg>' +
          '<span class="tname" data-act="go">' + GC.esc(GC.featName(l, nd)) + (l.featPhotos && l.featPhotos[nd] ? ' <span class="ph-count">📷 ' + l.featPhotos[nd].length + '</span>' : '') + '</span>' +
          '<button class="ib" data-act="tvis" title="' + (hf[nd] ? 'Show' : 'Hide') + '">' + ICON(hf[nd] ? 'eyeoff' : 'eye') + '</button></li>');
      } else {
        var k = 'f' + nd.id, open = GC.isOpen(l.id + ':' + nd.id, nd.o);
        out.push('<li class="tn folder' + (off || nd.h ? ' off' : '') + '" data-n="' + k + '" style="--d:' + depth + '">' +
          '<button class="tw' + (open ? ' open' : '') + '" data-act="tw">' + ICON('caret') + '</button>' +
          '<svg class="ti"><use xlink:href="#i-' + (open ? 'folder-open' : 'folder') + '"/></svg>' +
          '<span class="tname" data-act="fold">' + GC.esc(nd.n) + '</span>' +
          '<button class="ib" data-act="tvis" title="' + (nd.h ? 'Show' : 'Hide') + '">' + ICON(nd.h ? 'eyeoff' : 'eye') + '</button></li>');
        if (open) treeRows(l, nd.c, depth + 1, off || nd.h, out, nd.id);
      }
    });
    if (nodes.length > lim) out.push('<li class="tn more" data-n="m' + key + '" style="--d:' + depth + '"><span class="tw-sp"></span><span class="tname" data-act="more">Show ' + Math.min(500, nodes.length - lim) + ' more of ' + (nodes.length - lim) + '…</span></li>');
  }
  /** Path of folders from the top of the tree down to a node (folder id or feature index). */
  function findPath(nodes, match, path) {
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      if (match(nd)) return path;
      if (typeof nd === 'object') { var r = findPath(nd.c, match, path.concat([nd])); if (r) return r; }
    }
    return null;
  }
  function eachFeat(nd, fn) { if (typeof nd === 'number') fn(nd); else nd.c.forEach(function (x) { eachFeat(x, fn); }); }
  GC.folderBounds = function (l, nd) {
    var b = null;
    eachFeat(nd, function (i) { var f = l.geojson.features[i]; if (!f || !f.geometry) return; var bb = global.Importers.bounds({ type: 'FeatureCollection', features: [f] }); if (!isFinite(bb[0])) return; if (!b) b = L.latLngBounds([bb[1], bb[0]], [bb[3], bb[2]]); else b.extend([[bb[1], bb[0]], [bb[3], bb[2]]]); });
    return b;
  };
  function zoomBounds(b) { if (!b) return; if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), Math.max(map.getZoom(), 17)); else map.fitBounds(b, { padding: [60, 60], maxZoom: 19 }); }
  /** Show/hide like Google Earth: a folder takes all its contents with it; showing an item also shows the folders around it. */
  function setNodeVisible(l, n, show) {
    l.hiddenFeats = l.hiddenFeats || {};
    var tree = GC.layerTree(l), path, nd;
    if (n.charAt(0) === 'p') { var i = +n.slice(1); if (show) delete l.hiddenFeats[i]; else l.hiddenFeats[i] = 1; path = l.tree ? findPath(tree, function (x) { return x === i; }, []) : []; }
    else {
      var id = n.slice(1); path = findPath(tree, function (x) { return typeof x === 'object' && x.id === id; }, []);
      nd = path && (path.length ? path[path.length - 1].c : tree).filter(function (x) { return typeof x === 'object' && x.id === id; })[0];
      if (!nd) return;
      (function all(x) { if (typeof x === 'number') { if (show) delete l.hiddenFeats[x]; else l.hiddenFeats[x] = 1; } else { if (show) delete x.h; else x.h = 1; x.c.forEach(all); } })(nd);
    }
    if (show) { (path || []).forEach(function (x) { delete x.h; }); if (!l.visible) { l.visible = true; GC.applyLayerState(); } }
    GC.renderLayer(l); GC.markDirty(l.id); GC.refreshLayers();
  }
  var lastTap = { id: null, t: 0 };
  function doubleTap(id) { var now = Date.now(), d = lastTap.id === id && now - lastTap.t < 400; lastTap = d ? { id: null, t: 0 } : { id: id, t: now }; return d; }
  $('layer-list').addEventListener('click', function (e) {
    var li = e.target.closest('.layer'); if (!li) return;
    var l = GC.layerById(li.getAttribute('data-id')); if (!l) return;
    var btn = e.target.closest('[data-act]'), act = btn && btn.getAttribute('data-act'), tn = e.target.closest('.tn');
    if (tn) {
      var n = tn.getAttribute('data-n');
      if (n.charAt(0) === 'm') { var key = l.id + ':' + n.slice(1); shownLimit[key] = (shownLimit[key] || 250) + 500; GC.refreshLayers(); return; }
      if (n.charAt(0) === 'p') {
        if (act === 'tvis') setNodeVisible(l, n, !!(l.hiddenFeats || {})[+n.slice(1)]);
        else if (GC.showFeature) GC.showFeature(l, +n.slice(1));
        return;
      }
      var fid = n.slice(1), fnd = findPath(GC.layerTree(l), function (x) { return typeof x === 'object' && x.id === fid; }, []);
      var folder = fnd && (fnd.length ? fnd[fnd.length - 1].c : GC.layerTree(l)).filter(function (x) { return typeof x === 'object' && x.id === fid; })[0];
      if (!folder) return;
      if (act === 'tvis') { setNodeVisible(l, n, !!folder.h); return; }
      if (act === 'fold' && doubleTap(l.id + ':' + fid)) { zoomBounds(GC.folderBounds(l, folder)); return; }
      GC.setOpen(l.id + ':' + fid, !GC.isOpen(l.id + ':' + fid, folder.o)); GC.refreshLayers();
      return;
    }
    if (act === 'tw') { GC.setOpen(l.id, !GC.isOpen(l.id, false)); GC.refreshLayers(); return; }
    if (act === 'vis') { l.visible = !l.visible; GC.applyLayerState(); GC.markDirty(l.id); GC.refreshLayers(); return; }
    if (act === 'lock') { l.locked = !l.locked; GC.markDirty(l.id); GC.refreshLayers(); if (l.locked && GC.clearSelection) GC.clearSelection(); return; }
    if (act === 'more') { GC.layerOptions(l); return; }
    if (e.target.closest('.grip')) return;
    if (doubleTap(l.id)) { GC.zoomToLayer(l); return; }
    if (l.kind === 'drawing') { GC.project.activeLayer = l.id; GC.markDirty(); GC.refreshLayers(); }
    else if (l.kind === 'vector' && e.target.closest('.ltext')) { GC.setOpen(l.id, !GC.isOpen(l.id, false)); GC.refreshLayers(); }
  });
  // Drag the ⠿ handle to reorder layers (the list shows the top layer first).
  $('layer-list').addEventListener('pointerdown', function (e) {
    var grip = e.target.closest('.grip'); if (!grip) return;
    e.preventDefault();
    var li = grip.closest('.layer'), list = $('layer-list'), items = Array.prototype.slice.call(list.children), from = items.indexOf(li);
    var tops = items.map(function (x) { var r = x.getBoundingClientRect(); return r.top + r.height / 2; }), y0 = e.clientY, to = from;
    li.classList.add('dragging');
    try { grip.setPointerCapture(e.pointerId); } catch (er) { /* old Safari */ }
    var move = function (ev) {
      var dy = ev.clientY - y0, c = tops[from] + dy;
      li.style.transform = 'translateY(' + dy + 'px)';
      to = 0; for (var i = 0; i < tops.length; i++) if (i !== from && tops[i] < c) to++; // final position = rows that end up above it
      items.forEach(function (x, i) { x.classList.toggle('drop-above', i === to && to < from); x.classList.toggle('drop-below', i === to && to > from); });
    };
    var up = function () {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      li.classList.remove('dragging'); li.style.transform = '';
      items.forEach(function (x) { x.classList.remove('drop-above', 'drop-below'); });
      if (to === from) return;
      var ls = GC.project.layers, n = ls.length, l = ls.splice(n - 1 - from, 1)[0];
      ls.splice(n - 1 - to, 0, l);
      GC.applyLayerState(); GC.markDirty(); GC.refreshLayers();
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  $('btn-add-layer').onclick = function () {
    GC.prompt('New drawing layer', 'Layer ' + (GC.drawingLayers().length + 1), 'Name', 'Create').then(function (name) {
      if (!name) return;
      var l = GC.newDrawingLayer(name); GC.insertLayer(l, true); GC.project.activeLayer = l.id; GC.refreshLayers(); GC.markDirty(l.id);
    });
  };
  $('active-layer').onchange = function () {
    var v = $('active-layer').value;
    if (v === '__new') { $('active-layer').value = GC.project.activeLayer || ''; $('btn-add-layer').onclick(); return; }
    GC.project.activeLayer = v; GC.markDirty(); GC.refreshLayers();
  };
  $('btn-sidebar').onclick = function () { document.body.classList.toggle('no-sidebar'); };
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (x) { x.classList.toggle('on', x === b); });
      $('tab-layers').hidden = b.getAttribute('data-tab') !== 'layers'; $('tab-project').hidden = b.getAttribute('data-tab') !== 'project';
    };
  });
  $('proj-name').onchange = function () { var v = $('proj-name').value.trim(); if (!v) return; GC.project.name = v; $('project-name').textContent = v; document.title = v + ' — GeoCanvas'; GC.markDirty(); };
  $('proj-notes').oninput = function () { GC.project.notes = $('proj-notes').value; GC.markDirty(); };

  /** Layer options sheet: rename, opacity, style, order, duplicate, export, CRS, delete. */
  GC.layerOptions = function (l) {
    var p = GC.project, idx = p.layers.indexOf(l), isVec = l.kind === 'vector';
    var fields = [];
    if (isVec && l.geojson.features.length) { var seen = {}; l.geojson.features.slice(0, 200).forEach(function (f) { Object.keys(f.properties || {}).forEach(function (k) { seen[k] = true; }); }); fields = Object.keys(seen); }
    var info = [GC.kindLabel(l), GC.layerCount(l)];
    if (l.crs) info.push('Source CRS: ' + Geo.crsLabel(l.crs) + (l.assumed ? ' (assumed)' : ''));
    var html = '<h2>Layer options</h2><p class="sub">' + GC.esc(info.join(' · ')) + '</p>' +
      '<label class="field">Name<input type="text" id="lo-name" value="' + GC.esc(l.name) + '"></label>' +
      '<label class="slider" style="margin:8px 6px">Opacity <output id="lo-opv">' + Math.round(l.opacity * 100) + '%</output><input type="range" id="lo-op" min="5" max="100" value="' + Math.round(l.opacity * 100) + '"></label>';
    if (isVec) {
      var st = l.style || {};
      html += '<div style="display:flex;gap:14px;flex-wrap:wrap;margin:8px 6px;align-items:center">' +
        '<label class="custom" style="margin:0">Colour <input type="color" id="lo-color" value="' + (st.color || '#ff9800') + '"></label>' +
        '<label class="slider" style="flex:1;min-width:160px;margin:0">Line width <output id="lo-wv">' + (st.width || 2) + '</output><input type="range" id="lo-w" min="0.5" max="10" step="0.5" value="' + (st.width || 2) + '"></label></div>' +
        '<label class="slider" style="margin:8px 6px">Fill opacity <output id="lo-fv">' + Math.round((st.fillOpacity == null ? 0.2 : st.fillOpacity) * 100) + '%</output><input type="range" id="lo-f" min="0" max="80" value="' + Math.round((st.fillOpacity == null ? 0.2 : st.fillOpacity) * 100) + '"></label>' +
        '<label class="opt"><input type="checkbox" id="lo-file"' + (st.useFileStyle !== false ? ' checked' : '') + '> Use colours stored in the file (KML/GeoJSON styles)</label>' +
        '<label class="field">Label features by<select id="lo-label"><option value="">No labels</option>' + fields.map(function (f) { return '<option' + (f === l.labelField ? ' selected' : '') + '>' + GC.esc(f) + '</option>'; }).join('') + '</select></label>';
    } else if (l.kind === 'raster') {
      html += GC.lookHtml(l) + (l.rms != null ? '<p class="hint">Georeferenced on ' + (l.gcps || []).length + ' points, overall error ' + (l.rms < 1 ? (l.rms * 100).toFixed(0) + ' cm' : l.rms.toFixed(2) + ' m') + '.</p>' : '');
    } else if (l.kind === 'cad') {
      html += '<label class="opt"><input type="checkbox" id="lo-text"' + (l.showText !== false ? ' checked' : '') + '> Show the drawing’s text</label>' +
        '<label class="opt"><input type="checkbox" id="lo-mono"' + (l.mono ? ' checked' : '') + '> Draw everything in one colour <input type="color" id="lo-monoc" value="' + (l.mono || '#ffeb3b') + '" style="vertical-align:middle;margin-left:6px"></label>' +
        (l.crs ? '<p class="hint">Placed from ' + GC.esc(Geo.crsLabel(l.crs)) + ' coordinates.</p>' : '');
    } else if (l.kind === 'geopdf') {
      html += GC.lookHtml(l) +
        '<p class="hint">Placed from the GeoPDF’s own coordinates (' + GC.esc(l.encoding) + ') · ' + GC.esc(l.crs) + ' · drawn at ' + l.dpi + ' dpi' + (l.datum === 'gda94' ? ' · GDA94 converted to GDA2020' : '') + (l.rms != null ? ' · control points agree within ' + (l.rms < 1 ? (l.rms * 100).toFixed(0) + ' cm' : l.rms.toFixed(1) + ' m') : '') + '. Margins and legend are left off the map.</p>';
    } else if (l.kind === 'service' && GC.library) {
      html += GC.lookHtml(l) + GC.library.optionsHtml(l);
    } else if (l.kind === 'libmap') {
      var src = GC.mymaps && GC.mymaps.get(l.ref);
      if (!src) html += '<p class="hint">This map is not in My maps (it was deleted, or My maps has not loaded yet).</p>';
      else {
        if (src.kind !== 'cad') html += GC.lookHtml(l);
        else html += '<label class="opt"><input type="checkbox" id="lo-text"' + (l.showText !== false ? ' checked' : '') + '> Show the drawing’s text</label>' +
          '<label class="opt"><input type="checkbox" id="lo-mono"' + (l.mono ? ' checked' : '') + '> Draw everything in one colour <input type="color" id="lo-monoc" value="' + (l.mono || '#ffeb3b') + '" style="vertical-align:middle;margin-left:6px"></label>';
        if (GC.mymaps.hosted(src)) html += '<p class="hint">' + (GC.mymaps.isHere(src) ? '📱 Downloaded on this device: works offline.' : '☁ Shown from the cloud (needs internet). Download it in My maps to use it offline.') + '</p>';
        html += '<p class="hint">From My maps' + (src.folder ? ' › ' + GC.esc(src.folder.replace(/\//g, ' › ')) : '') + (src.crs ? ' · ' + GC.esc(String(src.crs)) : '') + '. The map is kept once in My maps and shown here; removing this layer does not delete it.</p>';
      }
    } else if (l.kind === 'waypoints' && l.photoPts && GC.camera) {
      html += GC.camera.optionsHtml(l);
    } else if (l.kind === 'drawing' || l.kind === 'track' || l.kind === 'waypoints') {
      html += '<label class="custom" style="margin:8px 6px">Layer colour <input type="color" id="lo-color" value="' + (l.color || '#1e63d6') + '"></label>';
    }
    if (l.warnings && l.warnings.length) html += '<div class="warn" style="margin:8px 6px">' + l.warnings.map(GC.esc).join('<br>') + '</div>';
    html += '<div class="row-btns">' +
      '<button class="btn" data-a="zoom">Zoom to layer</button>' +
      '<button class="btn" data-a="up"' + (idx === p.layers.length - 1 ? ' disabled' : '') + '>Move up</button>' +
      '<button class="btn" data-a="down"' + (idx === 0 ? ' disabled' : '') + '>Move down</button>' +
      '<button class="btn" data-a="dup">Duplicate</button>' +
      '<button class="btn" data-a="export">Export…</button>' +
      (isVec && l.hasSources ? '<button class="btn" data-a="crs">Change coordinate system…</button>' : '') +
      (l.kind === 'raster' && l.gcps && GC.georef ? '<button class="btn" data-a="georef">Adjust georeferencing…</button>' : '') +
      (GC.mymaps && /^(raster|geopdf|cad|service)$/.test(l.kind) && !l.libRef ? '<button class="btn" data-a="tolib">Save to My maps</button>' : '') +
      (GC.mymaps && (l.kind === 'libmap' || l.libRef) ? '<button class="btn" data-a="inlib">Show in My maps</button>' : '') +
      '</div><div class="actions"><button class="btn danger" data-a="del">Delete layer</button><span class="spacer"></span><button class="btn primary" data-a="done">Done</button></div>';
    GC.modal(html, function (el, close) {
      var q = function (s) { return el.querySelector(s); };
      q('#lo-name').onchange = function () { var v = q('#lo-name').value.trim(); if (v) { l.name = v; GC.markDirty(l.id); GC.refreshLayers(); } };
      q('#lo-op').oninput = function () { l.opacity = q('#lo-op').value / 100; q('#lo-opv').textContent = q('#lo-op').value + '%'; GC.applyLayerState(); GC.markDirty(l.id); GC.refreshLayers(true); };
      if (isVec) {
        l.style = l.style || {};
        var restyle = function () { GC.renderLayer(l); GC.markDirty(l.id); GC.refreshLayers(true); };
        q('#lo-color').oninput = function () { l.style.color = q('#lo-color').value; l.style.useFileStyle = false; q('#lo-file').checked = false; restyle(); };
        q('#lo-w').oninput = function () { l.style.width = +q('#lo-w').value; q('#lo-wv').textContent = q('#lo-w').value; restyle(); };
        q('#lo-f').oninput = function () { l.style.fillOpacity = q('#lo-f').value / 100; q('#lo-fv').textContent = q('#lo-f').value + '%'; restyle(); };
        q('#lo-file').onchange = function () { l.style.useFileStyle = q('#lo-file').checked; restyle(); };
        q('#lo-label').onchange = function () { l.labelField = q('#lo-label').value || null; restyle(); };
      } else if (q('#cam-min')) {
        GC.camera.bindOptions(el, l, function () { GC.layerOptions(l); });
      } else if (q('#lo-color')) {
        q('#lo-color').oninput = function () { l.color = q('#lo-color').value; if (l.kind !== 'drawing') GC.renderLayer(l); GC.markDirty(l.id); GC.refreshLayers(true); };
      }
      el.querySelector('[data-a=done]').onclick = function () { q('#lo-name').onchange(); close(); };
      el.querySelector('[data-a=zoom]').onclick = function () { close(); GC.zoomToLayer(l); };
      var move = function (d) { var i = p.layers.indexOf(l), j = i + d; if (j < 0 || j >= p.layers.length) return; p.layers.splice(i, 1); p.layers.splice(j, 0, l); GC.applyLayerState(); GC.markDirty(); GC.refreshLayers(); close(); GC.layerOptions(l); };
      el.querySelector('[data-a=up]').onclick = function () { move(1); };
      el.querySelector('[data-a=down]').onclick = function () { move(-1); };
      el.querySelector('[data-a=dup]').onclick = function () {
        var c = JSON.parse(JSON.stringify(stripLayer(l)));
        c.id = Ink.uid(); c.name = l.name + ' copy'; c.locked = false;
        if (c.items) c.items = c.items.map(function (it) { it.id = Ink.uid(); return it; });
        p.layers.splice(p.layers.indexOf(l) + 1, 0, c); GC.renderLayer(c); GC.applyLayerState(); GC.markDirty(c.id);
        if (l.hasSources) { c.hasSources = false; }
        GC.refreshLayers(); close(); GC.toast('Duplicated “' + l.name + '”.');
      };
      el.querySelector('[data-a=export]').onclick = function () { close(); GC.openExport([l.id]); };
      if (q('[data-a=crs]')) q('[data-a=crs]').onclick = function () { close(); GC.changeCRS(l); };
      if (q('[data-a=georef]')) q('[data-a=georef]').onclick = function () { close(); GC.georef.edit(l); };
      if (q('[data-a=tolib]')) q('[data-a=tolib]').onclick = function () {
        close(); GC.busy('Saving to My maps…');
        GC.mymaps.saveLayer(l).then(function (m) { GC.busy(null); GC.toast('“' + m.name + '” is in My maps. Open My maps to put it in a folder or show it in other projects.'); }, function (e) { GC.busy(null); GC.toast('Could not save it: ' + e.message, 'err'); });
      };
      if (q('[data-a=inlib]')) q('[data-a=inlib]').onclick = function () { var m = GC.mymaps.get(l.ref || l.libRef); close(); GC.mymaps.open({ folder: m ? m.folder || '' : '' }); };
      if (l.kind === 'service' && GC.library) GC.library.bindOptions(l, el);
      if (q('.lo-look')) GC.bindLook(l, el);
      if (q('#lo-text')) {
        var cadRedraw = function () { GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id); };
        q('#lo-text').onchange = function () { l.showText = q('#lo-text').checked; cadRedraw(); };
        q('#lo-mono').onchange = function () { if (q('#lo-mono').checked) l.mono = q('#lo-monoc').value; else delete l.mono; cadRedraw(); };
        q('#lo-monoc').oninput = function () { if (q('#lo-mono').checked) { l.mono = q('#lo-monoc').value; cadRedraw(); } };
      }
      el.querySelector('[data-a=del]').onclick = function () {
        close();
        var what = l.kind === 'drawing' ? l.items.length + ' drawn items' : GC.layerCount(l);
        GC.confirm('Delete “' + l.name + '”?', 'This removes the layer and its ' + what + ' from the project. It cannot be undone.', 'Delete', true).then(function (ok) { if (ok) { GC.removeLayer(l.id); GC.toast('Layer deleted.'); } });
      };
    });
  };
  function stripLayer(l) { var c = {}; for (var k in l) if (k !== '_leaflet') c[k] = l[k]; if (c.items) c.items = c.items.map(Ink.stripCache); if (c.tracks) c.tracks = c.tracks.map(function (t) { return { name: t.name, points: t.points, distance: t.distance, started: t.started }; }); return c; }
  GC.stripLayer = stripLayer;

  // ---------- HUD ----------
  var hudLL = null, hudRAF = 0;
  GC.setHover = function (ll) { hudLL = ll; queueHud(); };
  function queueHud() { if (!hudRAF) hudRAF = requestAnimationFrame(updateHud); }
  function updateHud() {
    hudRAF = 0;
    var c = hudLL || map.getCenter();
    try { $('hud-coord').textContent = Geo.fmt([c.lng, c.lat], GC.settings.coordFmt); } catch (e) { $('hud-coord').textContent = c.lat.toFixed(6) + ', ' + c.lng.toFixed(6); }
    var mpp = Geo.metersPerPixel(map.getZoom(), map.getCenter().lat);
    $('hud-zoom').textContent = 'z' + (Math.round(map.getZoom() * 4) / 4) + ' · ' + (mpp < 1 ? mpp.toFixed(2) : mpp.toFixed(1)) + ' m/px';
  }
  map.on('move zoom', queueHud);
  $('hud').onclick = function () {
    var order = ['dd', 'dms', 'mga'], i = order.indexOf(GC.settings.coordFmt);
    GC.settings.coordFmt = order[(i + 1) % order.length]; GC.saveSettings(); queueHud();
    GC.toast({ dd: 'Coordinates: decimal degrees (WGS84/GDA2020)', dms: 'Coordinates: degrees, minutes, seconds', mga: 'Coordinates: MGA2020 grid (zone 56 at Toowoomba)' }[GC.settings.coordFmt]);
  };
  GC.updateHud = queueHud;

  // ---------- keyboard ----------
  document.addEventListener('keydown', function (e) {
    var t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    var mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) GC.redo(); else GC.undo(); }
    else if (mod && e.key === 'y') { e.preventDefault(); GC.redo(); }
    else if (e.key === 'Escape') { GC.closeModal(); if (GC.clearSelection) GC.clearSelection(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && GC.deleteSelection) { if (GC.deleteSelection()) e.preventDefault(); }
  });
})(window);

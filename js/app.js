/* GeoCanvas web — application core: state, map, basemaps, layers, persistence, undo, sidebar.
   Every layer gets its own Leaflet pane, so the layer list order is exactly the drawing order.
   Drawing layers render through a per-layer canvas (Ink.InkPath); GIS layers through L.geoJSON. */
(function (global) {
  'use strict';
  var Geo = global.Geo, Ink = global.Ink, Store = global.Store;
  var $ = function (id) { return document.getElementById(id); };
  var GC = global.GC = { $: $ };
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
    var wrap = $('modal-wrap'), el = $('modal');
    el.innerHTML = html; wrap.hidden = false;
    var closed = false;
    var close = function () { if (closed) return; closed = true; wrap.hidden = true; el.innerHTML = ''; modalClose = null; if (onClose) onClose(); };
    modalClose = close;
    wrap.onclick = function (e) { if (e.target === wrap) close(); };
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
      var o = Object.assign({ maxZoom: 22, keepBuffer: 3, updateWhenZooming: false }, d.o);
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
    });
  };

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
    return L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: '<div class="ll-symbol" style="width:30px;height:30px;position:relative">' + GC.symbolSVG(el.symbol, el.color) + label + '</div>' });
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

  /** (Re)creates the Leaflet layers of any layer. */
  GC.renderLayer = function (l) {
    var v = ensureView(l);
    v.group.clearLayers(); v.paths = {}; v.objs = {}; v.markers = {}; v.trackLines = {};
    if (l.kind === 'drawing') { GC.syncDrawing(l); return; }
    if (l.kind === 'vector') {
      var n = (l.geojson.features || []).length, labels = l.labelField && n <= 600;
      var gj = L.geoJSON(l.geojson, {
        pane: v.pn, renderer: v.renderer,
        interactive: false,
        style: function (f) { return featStyle(l, f, /Point/.test(f.geometry && f.geometry.type)); },
        pointToLayer: function (f, ll) { return L.circleMarker(ll, Object.assign({ radius: 6, pane: v.pn, renderer: v.renderer, interactive: false }, featStyle(l, f, true))); },
        onEachFeature: function (f, lay) {
          if (labels && f.properties && f.properties[l.labelField] != null && f.properties[l.labelField] !== '') lay.bindTooltip(GC.esc(f.properties[l.labelField]), { permanent: true, direction: 'center', className: 'gc-label', pane: 'tooltipPane' });
        }
      });
      v.group.addLayer(gj);
    } else if (l.kind === 'raster') {
      v.group.addLayer(L.imageOverlay(l.dataURL, l.bounds, { pane: v.pn, interactive: false }));
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
      (l.waypoints || []).forEach(function (w) {
        var m = L.circleMarker([w.lat, w.lon], { pane: v.pn, renderer: v.renderer, radius: 7, color: '#fff', weight: 2, fillColor: l.color || '#e8590c', fillOpacity: 1, interactive: false });
        m._gcWp = w;
        if (w.name) m.bindTooltip(GC.esc(w.name), { permanent: (l.waypoints.length < 150), direction: 'right', offset: [8, 0], className: 'gc-label' });
        v.group.addLayer(m);
      });
    }
  };

  GC.layerBounds = function (l) {
    var b = null, add = function (lat, lon) { if (!isFinite(lat) || !isFinite(lon)) return; if (!b) b = L.latLngBounds([lat, lon], [lat, lon]); else b.extend([lat, lon]); };
    if (l.kind === 'drawing') l.items.forEach(function (el) { var m = Ink.mercBounds(el), a = Geo.unmerc(m[0], m[1]), c = Geo.unmerc(m[2], m[3]); add(a[1], a[0]); add(c[1], c[0]); });
    else if (l.kind === 'vector') { var bb = global.Importers.bounds(l.geojson); if (isFinite(bb[0])) { add(bb[1], bb[0]); add(bb[3], bb[2]); } }
    else if (l.kind === 'raster') { add(l.bounds[0][0], l.bounds[0][1]); add(l.bounds[1][0], l.bounds[1][1]); }
    else if (l.kind === 'track') (l.tracks || []).forEach(function (t) { t.points.forEach(function (p) { add(p[1], p[0]); }); });
    else if (l.kind === 'waypoints') (l.waypoints || []).forEach(function (w) { add(w.lat, w.lon); });
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
    if (l.kind === 'waypoints') return (l.waypoints || []).length + ' waypoints';
    return '';
  };
  var KIND = { drawing: 'Annotation', vector: 'GIS', raster: 'Raster', track: 'GPS track', waypoints: 'Waypoints' };
  GC.kindLabel = function (l) { return l.kind === 'vector' && l.format ? l.format : KIND[l.kind]; };

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
    list.innerHTML = p.layers.slice().reverse().map(function (l) {
      var cls = 'layer' + (l.id === p.activeLayer ? ' active' : '') + (l.visible ? '' : ' hidden-layer');
      var sw = l.kind === 'vector' ? ((l.style && l.style.color) || '#ff9800') : (l.color || '#888');
      return '<li class="' + cls + '" data-id="' + l.id + '"><span class="sw" style="background:' + sw + '"></span>' +
        '<div class="ltext"><div class="lname">' + GC.esc(l.name) + '</div><div class="lsub">' + GC.esc(GC.kindLabel(l) + ' · ' + GC.layerCount(l)) + (l.opacity < 1 ? ' · ' + Math.round(l.opacity * 100) + '%' : '') + '</div></div>' +
        '<button class="ib" data-act="vis" title="' + (l.visible ? 'Hide' : 'Show') + '">' + ICON(l.visible ? 'eye' : 'eyeoff') + '</button>' +
        '<button class="ib' + (l.locked ? ' locked' : '') + '" data-act="lock" title="' + (l.locked ? 'Unlock' : 'Lock') + '">' + ICON(l.locked ? 'lock' : 'unlock') + '</button>' +
        '<button class="ib" data-act="more" title="Layer options">' + ICON('more') + '</button></li>';
    }).join('');
    $('layer-count').textContent = p.layers.length + (p.layers.length === 1 ? ' layer' : ' layers');
    if (countsOnly) return;
    var dl = GC.drawingLayers(), opts = dl.slice().reverse().map(function (l) { return '<option value="' + l.id + '">' + GC.esc(l.name) + (l.locked ? ' (locked)' : '') + '</option>'; }).join('');
    $('active-layer').innerHTML = opts + '<option value="__new">+ New layer…</option>';
    $('active-layer').value = p.activeLayer || '__new';
    $('sel-layer').innerHTML = '<option value="">Move to layer…</option>' + opts;
  };
  var lastTap = { id: null, t: 0 };
  $('layer-list').addEventListener('click', function (e) {
    var li = e.target.closest('.layer'); if (!li) return;
    var l = GC.layerById(li.getAttribute('data-id')); if (!l) return;
    var btn = e.target.closest('button'), act = btn && btn.getAttribute('data-act');
    if (act === 'vis') { l.visible = !l.visible; GC.applyLayerState(); GC.markDirty(l.id); GC.refreshLayers(); return; }
    if (act === 'lock') { l.locked = !l.locked; GC.markDirty(l.id); GC.refreshLayers(); if (l.locked && GC.clearSelection) GC.clearSelection(); return; }
    if (act === 'more') { GC.layerOptions(l); return; }
    var now = Date.now();
    if (lastTap.id === l.id && now - lastTap.t < 400) { GC.zoomToLayer(l); lastTap.id = null; return; }
    lastTap = { id: l.id, t: now };
    if (l.kind === 'drawing') { GC.project.activeLayer = l.id; GC.markDirty(); GC.refreshLayers(); }
  });
  $('btn-add-layer').onclick = function () {
    GC.prompt('New annotation layer', 'Layer ' + (GC.drawingLayers().length + 1), 'Name', 'Create').then(function (name) {
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

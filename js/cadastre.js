/* GeoCanvas web — Queensland cadastre (lot boundaries) as a reference layer.
   Source: Queensland Government Land Parcel Property Framework, layer 4 "Cadastral parcels" (DCDB, updated nightly),
   © State of Queensland, CC BY 4.0. Boundaries are a guide only, not a survey.
   Zoomed out: the service draws the boundaries (export images). From zoom 16: parcels are fetched as vectors,
   so they get lot/plan labels, can be tapped, and points snap to their corners (measuring, georeferencing plans). */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, map = GC.map, $ = GC.$, esc = GC.esc;
  var BASE = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer';
  var LAYER = 4, VECTOR_ZOOM = 16, LABEL_ZOOM = 17, ATTR = 'Lot boundaries © State of Queensland (DCDB), CC BY 4.0';
  var COLOR = '#ffe14d';

  var pane = map.createPane('cadastre');
  pane.style.zIndex = 595; pane.style.pointerEvents = 'none'; // above project layers, below markers and popups
  var renderer = L.canvas({ pane: 'cadastre', padding: 0.3 });
  var vectors = L.layerGroup(), labels = L.layerGroup(), feats = [], loadedBox = null, loading = null, complete = false, jsonpOnly = false;

  // Boundaries drawn by the service, for every zoom level (Web Mercator tiles from the export endpoint).
  var Tiles = L.TileLayer.extend({
    getTileUrl: function (c) {
      var half = 20037508.342789244, size = 2 * half / Math.pow(2, c.z);
      var bbox = [-half + c.x * size, half - (c.y + 1) * size, -half + (c.x + 1) * size, half - c.y * size].map(function (v) { return v.toFixed(2); }).join(',');
      return BASE + '/export?bbox=' + bbox + '&bboxSR=3857&imageSR=3857&size=512,512&dpi=192&format=png32&transparent=true&layers=show:' + LAYER + '&f=image';
    }
  });
  var tiles = new Tiles('', { pane: 'cadastre', tileSize: 256, maxZoom: 22, maxNativeZoom: 20, minZoom: 10, keepBuffer: 2, updateWhenZooming: false });

  // ---------- service access (fetch; JSONP when the browser blocks it) ----------
  function jsonp(url) {
    return new Promise(function (res, rej) {
      var cb = 'gcCad' + Math.random().toString(36).slice(2), s = document.createElement('script');
      var done = function () { clearTimeout(t); try { delete global[cb]; } catch (e) { global[cb] = undefined; } if (s.parentNode) s.parentNode.removeChild(s); };
      var t = setTimeout(function () { done(); rej(new Error('The cadastre service did not answer.')); }, 25000);
      global[cb] = function (d) { done(); res(d); };
      s.onerror = function () { done(); rej(new Error('The cadastre service could not be reached.')); };
      s.src = url + '&callback=' + cb; document.head.appendChild(s);
    });
  }
  /** Esri JSON polygon rings → GeoJSON (outer rings are clockwise in Esri JSON). */
  function esriToGeoJSON(fs) {
    return { type: 'FeatureCollection', features: (fs || []).map(function (f) {
      var polys = [];
      ((f.geometry && f.geometry.rings) || []).forEach(function (r) {
        var a = 0; for (var i = 0; i < r.length - 1; i++) a += (r[i + 1][0] - r[i][0]) * (r[i + 1][1] + r[i][1]);
        if (a > 0 || !polys.length) polys.push([r]); else polys[polys.length - 1].push(r);
      });
      return { type: 'Feature', properties: f.attributes || {}, geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys } };
    }) };
  }
  function query(params) {
    var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    var url = BASE + '/' + LAYER + '/query?' + qs + '&outFields=*&returnGeometry=true&outSR=4326&geometryPrecision=7';
    var viaJsonp = function () { return jsonp(url + '&f=json').then(function (d) { if (d.error) throw new Error(d.error.message || 'Cadastre query failed.'); var g = esriToGeoJSON(d.features); g.exceeded = !!d.exceededTransferLimit; return g; }); };
    if (jsonpOnly) return viaJsonp();
    return fetch(url + '&f=geojson').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (g) {
      if (g.error) throw new Error(g.error.message || 'Cadastre query failed.');
      g.exceeded = !!(g.exceededTransferLimit || (g.properties && g.properties.exceededTransferLimit));
      return g;
    }, function () { jsonpOnly = true; return viaJsonp(); });
  }

  // ---------- parcels ----------
  function prop(p, names) { for (var i = 0; i < names.length; i++) { var k = Object.keys(p).filter(function (x) { return x.toLowerCase() === names[i]; })[0]; if (k && p[k] != null && p[k] !== '') return p[k]; } return null; }
  function lotplan(p) { return prop(p, ['lotplan', 'lot_plan']) || ((prop(p, ['lot']) || '') + (prop(p, ['plan']) || '')) || 'Parcel'; }
  function title(p) { var lot = prop(p, ['lot']), plan = prop(p, ['plan']); return lot && plan ? 'Lot ' + lot + ' on ' + plan : lotplan(p); }
  function rings(g) { return !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; }
  function areaOf(g) { var a = 0; rings(g).forEach(function (poly) { poly.forEach(function (r, i) { var x = Geo.ringArea(r); a += i ? -x : x; }); }); return a; }
  function inside(ll, g) {
    var x = ll.lng, y = ll.lat;
    return rings(g).some(function (poly) {
      var ins = false;
      poly.forEach(function (r) { for (var i = 0, j = r.length - 1; i < r.length; j = i++) { var a = r[i], b = r[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins; } });
      return ins;
    });
  }
  function draw() {
    vectors.clearLayers(); labels.clearLayers();
    if (!feats.length) return;
    vectors.addLayer(L.geoJSON({ type: 'FeatureCollection', features: feats }, { renderer: renderer, interactive: false, style: { color: COLOR, weight: 1.6, opacity: 0.95, fill: false } }));
    drawLabels();
  }
  function drawLabels() {
    labels.clearLayers();
    if (map.getZoom() < LABEL_ZOOM || feats.length > 1500) return;
    var view = map.getBounds().pad(0.1), n = 0;
    feats.forEach(function (f) {
      if (n > 500) return;
      var poly = rings(f.geometry)[0]; if (!poly) return;
      var c = L.polygon(poly.map(function (r) { return r.map(function (q) { return [q[1], q[0]]; }); })).getBounds().getCenter();
      if (!view.contains(c)) return;
      n++;
      labels.addLayer(L.marker(c, { pane: 'cadastre', interactive: false, keyboard: false, icon: L.divIcon({ className: 'cad-label', iconSize: null, html: '<span>' + esc(lotplan(f.properties)) + '</span>' }) }));
    });
  }
  function load() {
    if (!on() || map.getZoom() < VECTOR_ZOOM) { if (feats.length) { feats = []; draw(); loadedBox = null; } if (on() && !map.hasLayer(tiles)) tiles.addTo(map); return; }
    if (navigator.onLine === false) { if (!map.hasLayer(tiles)) tiles.addTo(map); return; } // offline: saved boundary tiles only
    var view = map.getBounds();
    if (loadedBox && loadedBox.contains(view)) { drawLabels(); return; }
    var box = view.pad(0.35), b = [box.getWest(), box.getSouth(), box.getEast(), box.getNorth()].map(function (v) { return v.toFixed(6); }).join(',');
    var mine = loading = query({ where: '1=1', geometry: b, geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', resultRecordCount: 2000 });
    mine.then(function (g) {
      if (mine !== loading || !on()) return;
      feats = (g.features || []).filter(function (f) { return f.geometry; }); loadedBox = box; complete = !g.exceeded;
      draw();
      // With every parcel in hand the vectors replace the service drawing; otherwise keep both.
      if (complete) { if (map.hasLayer(tiles)) map.removeLayer(tiles); } else if (!map.hasLayer(tiles)) tiles.addTo(map);
    }, function (e) {
      if (mine !== loading) return;
      if (!map.hasLayer(tiles)) tiles.addTo(map);
      if (!load.warned) { load.warned = true; GC.toast('Lot boundaries could not be loaded (' + e.message + '). They need an internet connection.', 'warn', 7000); }
    });
  }
  var timer = null;
  map.on('moveend zoomend', function () { if (!on()) return; clearTimeout(timer); timer = setTimeout(load, 250); });

  // ---------- parcel balloon ----------
  function showParcel(f, ll) {
    if (GC.closeInspector) GC.closeInspector();
    var p = f.properties || {}, a = prop(p, ['lot_area']) || areaOf(f.geometry);
    var skip = /^(objectid|shape.*|st_area.*|st_length.*|se_anno.*|globalid|fid)$/i;
    var rows = Object.keys(p).filter(function (k) { return !skip.test(k) && p[k] != null && p[k] !== '' && p[k] !== ' '; }).map(function (k) { return [k, String(p[k])]; });
    var body = '<table class="gb-data"><tr><td>Lot/plan</td><td>' + esc(lotplan(p)) + '</td></tr><tr><td>Area</td><td>' + esc(GC.measure ? GC.measure.fmtArea(+a) : Math.round(a) + ' m²') + '</td></tr>' +
      rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
    var b = L.geoJSON(f).getBounds(), at = ll || b.getCenter();
    GC.card.open({ ll: at, title: title(p), sub: 'Lot boundaries · QLD cadastre, a guide only (not a survey)', body: body, target: f.geometry, at: [at.lng, at.lat], highlight: f, zoom: b,
      more: [{ label: 'Add this lot to the project', fn: function () { addToProject(f); GC.closeInspector(); } }] });
  }
  /** Copies a parcel into the project (a GIS layer "Lot boundaries") to keep, measure, export or use as a reference. */
  function addToProject(f) {
    var p = GC.project, lp = lotplan(f.properties);
    var l = p.layers.filter(function (x) { return x.kind === 'vector' && x.format === 'Cadastre'; })[0];
    if (!l) {
      l = { id: global.Ink.uid(), name: 'Lot boundaries', kind: 'vector', visible: true, opacity: 1, locked: true, geojson: { type: 'FeatureCollection', features: [] }, crs: 4326, format: 'Cadastre',
        warnings: ['From the Queensland cadastre (DCDB), © State of Queensland, CC BY 4.0. A guide only, not a survey.'], style: { color: '#ffb300', width: 2.5, fillOpacity: 0.08, useFileStyle: false }, labelField: 'lotplan', created: Date.now() };
      GC.insertLayer(l);
    }
    if (l.geojson.features.some(function (x) { return x.properties && x.properties.lotplan === lp; })) { GC.toast(lp + ' is already in “' + l.name + '”.'); return; }
    var keep = {}; Object.keys(f.properties || {}).forEach(function (k) { if (!/^(objectid|shape.*|st_area.*|st_length.*|se_anno.*|globalid)$/i.test(k)) keep[k] = f.properties[k]; });
    keep.name = title(f.properties); keep.lotplan = lp; keep.area_m2 = Math.round(areaOf(f.geometry));
    l.geojson.features.push({ type: 'Feature', properties: keep, geometry: f.geometry });
    l.geojson = { type: 'FeatureCollection', features: l.geojson.features.slice() }; // new object: the sync sees the change
    GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id); GC.refreshLayers();
    GC.toast('Added ' + keep.name + ' to “' + l.name + '”.');
  }

  /** Tap on the map with nothing else under it: show the parcel. Returns true when the cadastre took the tap. */
  function identify(ll) {
    if (!on() || map.getZoom() < 13) return false;
    var hit = map.getZoom() >= VECTOR_ZOOM && complete ? feats.filter(function (f) { return inside(ll, f.geometry); })[0] : null;
    if (hit) { showParcel(hit, ll); return true; }
    query({ geometry: ll.lng.toFixed(7) + ',' + ll.lat.toFixed(7), geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects' }).then(function (g) {
      var f = (g.features || []).filter(function (x) { return x.geometry; })[0];
      if (f) showParcel(f, ll); else if (GC.closeInspector) GC.closeInspector();
    }, function (e) { GC.toast('Could not look up the parcel: ' + e.message, 'warn'); });
    return true;
  }
  /** Finds a lot by lot/plan (e.g. "3RP123456", "Lot 3 on RP123456"). */
  function find(text) {
    var m = /^\s*(?:lot\s*)?([0-9a-z]+)\s*(?:on\s*|\/\s*)?([a-z]{1,4}\s*[0-9]+)\s*$/i.exec(text || '');
    if (!m || !/[0-9]/.test(m[2])) return null;
    var lp = (m[1] + m[2]).replace(/\s+/g, '').toUpperCase();
    return query({ where: "lotplan='" + lp.replace(/'/g, '') + "'" }).then(function (g) {
      var f = (g.features || []).filter(function (x) { return x.geometry; })[0];
      if (!f) throw new Error('No lot ' + lp + ' in the Queensland cadastre.');
      if (!on()) setOn(true);
      var b = L.geoJSON(f).getBounds(); map.fitBounds(b, { padding: [80, 80], maxZoom: 18 });
      setTimeout(function () { showParcel(f, b.getCenter()); }, 400);
      return f;
    });
  }
  /** Nearest parcel corner within tol screen pixels (for measuring and georeferencing). */
  function snap(ll, tol) {
    if (!on() || !feats.length || map.getZoom() < VECTOR_ZOOM) return null;
    var p = map.latLngToContainerPoint(ll), best = null, bd = tol || 16;
    feats.forEach(function (f) {
      rings(f.geometry).forEach(function (poly) { poly.forEach(function (r) { r.forEach(function (c) {
        var q = map.latLngToContainerPoint([c[1], c[0]]), d = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
        if (d < bd * 1.4 && Math.hypot(q.x - p.x, q.y - p.y) < bd) { bd = Math.hypot(q.x - p.x, q.y - p.y); best = L.latLng(c[1], c[0]); }
      }); }); });
    });
    return best;
  }

  // ---------- on/off ----------
  function on() { return !!GC.settings.cadastre; }
  function setOn(v) {
    GC.settings.cadastre = !!v; GC.saveSettings();
    $('ref-cad').checked = !!v;
    if (v) {
      tiles.addTo(map); vectors.addTo(map); labels.addTo(map);
      map.attributionControl.addAttribution(ATTR); load();
    } else {
      [tiles, vectors, labels].forEach(function (x) { if (map.hasLayer(x)) map.removeLayer(x); });
      map.attributionControl.removeAttribution(ATTR); feats = []; loadedBox = null; vectors.clearLayers(); labels.clearLayers();
    }
  }
  $('ref-cad').onchange = function () { setOn($('ref-cad').checked); if ($('ref-cad').checked && map.getZoom() < 14) GC.toast('Lot boundaries are on. Zoom in to see lot/plan labels; tap a lot for its details.'); };
  if (on()) setOn(true);

  GC.cadastre = { on: on, setOn: setOn, identify: identify, find: find, snap: snap, esriToGeoJSON: esriToGeoJSON, BASE: BASE,
    tiles: tiles, tileUrl: function (c) { return tiles.getTileUrl(c); } }; // offline maps save these tiles
})(window);

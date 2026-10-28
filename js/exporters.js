/* GeoCanvas web — georeferenced export. Vector formats use WGS84 lon/lat; rasters use EPSG:3857. */
(function (global) {
  'use strict';
  var Geo = global.Geo, Ink = global.Ink;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function r8(v) { return Math.round(v * 1e8) / 1e8; }
  function kmlColor(hex, a) { hex = hex.replace('#', ''); var aa = Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16); if (aa.length < 2) aa = '0' + aa; return (aa + hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2)).toLowerCase(); }

  /** Converts drawing items into GeoJSON features (strokes as centre-lines or ink outlines). */
  function itemFeatures(layer, items, outlines) {
    return items.map(function (el) {
      var p = { gc_layer: layer.name, gc_id: el.id, gc_type: el.type, gc_color: el.color, gc_created: new Date(el.created || Date.now()).toISOString() };
      var geom;
      if (el.type === 'stroke') {
        p.gc_tool = el.ink; p.gc_width_px = el.width; p.gc_opacity = el.opacity;
        p.gc_width_m = Math.round(el.width * Geo.metersPerPixel(el.z0, el.pts[0][1]) * 1000) / 1000;
        if (el.group) p.gc_group = el.group;
        p.stroke = el.color; p['stroke-width'] = el.width; p['stroke-opacity'] = el.opacity;
        if (outlines && el.ink !== 'highlighter' && el.ink !== 'marker') {
          var g = Ink.build(el), u = g.unit, ring = g.local.map(function (q) { var ll = Geo.unmerc(g.anchor[0] + q[0] * u, g.anchor[1] + q[1] * u); return [r8(ll[0]), r8(ll[1])]; });
          ring.push(ring[0]);
          geom = { type: 'Polygon', coordinates: [ring] }; p.fill = el.color; p['fill-opacity'] = el.opacity;
        } else {
          var pts = el.pts.map(function (q) { return [r8(q[0]), r8(q[1])]; });
          geom = pts.length > 1 ? { type: 'LineString', coordinates: pts } : { type: 'Point', coordinates: pts[0] };
        }
      } else if (el.type === 'shape') {
        p.gc_tool = el.kind; p.stroke = el.color; p['stroke-width'] = el.width;
        var o = Ink.shapeOutline(el).map(function (m) { var ll = Geo.unmerc(m[0], m[1]); return [r8(ll[0]), r8(ll[1])]; });
        if (Ink.isClosed(el)) { o.push(o[0]); geom = { type: 'Polygon', coordinates: [o] }; p.gc_area_m2 = Math.round(Geo.ringArea(o)); if (el.fill) { p.fill = el.color; p['fill-opacity'] = 0.25; } }
        else { geom = { type: 'LineString', coordinates: o }; p.gc_length_m = Math.round(Geo.pathLength(o) * 100) / 100; }
      } else if (el.type === 'text') {
        p.gc_text = el.text; p.name = el.text; geom = { type: 'Point', coordinates: [r8(el.at[0]), r8(el.at[1])] };
      } else {
        p.name = el.title || 'Marker'; p.gc_symbol = el.symbol; p.gc_note = el.note || ''; p['marker-color'] = el.color;
        if (el.photos && el.photos.length) p.gc_photos = el.photos.map(function (r) { return r.id; }).join(',');
        geom = { type: 'Point', coordinates: [r8(el.at[0]), r8(el.at[1])] };
      }
      return { type: 'Feature', properties: p, geometry: geom };
    });
  }

  function collect(project, layerIds, outlines) {
    var feats = [];
    project.layers.forEach(function (l) {
      if (layerIds.indexOf(l.id) < 0) return;
      if (l.kind === 'drawing') feats = feats.concat(itemFeatures(l, l.items || [], outlines));
      else if (l.kind === 'vector') (l.geojson.features || []).forEach(function (f) { var c = JSON.parse(JSON.stringify(f)); c.properties = Object.assign({ gc_layer: l.name }, c.properties); feats.push(c); });
      else if (l.kind === 'track') (l.tracks || []).forEach(function (t) { feats.push({ type: 'Feature', properties: { gc_layer: l.name, gc_type: 'gps_track', name: t.name, distance_m: Math.round(t.distance || 0), stroke: '#ff3d00' }, geometry: { type: 'LineString', coordinates: t.points.map(function (p) { return [r8(p[0]), r8(p[1])]; }) } }); });
      else if (l.kind === 'waypoints') (l.waypoints || []).forEach(function (w) { feats.push({ type: 'Feature', properties: { gc_layer: l.name, gc_type: 'waypoint', name: w.name, note: w.note, time: w.time, accuracy_m: w.acc, gc_photos: w.photos && w.photos.length ? w.photos.map(function (r) { return r.id; }).join(',') : undefined }, geometry: { type: 'Point', coordinates: [r8(w.lon), r8(w.lat)] } }); });
    });
    return feats;
  }

  function geojson(project, layerIds, outlines) {
    return JSON.stringify({ type: 'FeatureCollection', name: project.name, features: collect(project, layerIds, outlines) }, null, 1);
  }

  function kmlGeom(g) {
    function cs(a) { return a.map(function (c) { return c[0] + ',' + c[1] + ',0'; }).join(' '); }
    switch (g.type) {
      case 'Point': return '<Point><coordinates>' + cs([g.coordinates]) + '</coordinates></Point>';
      case 'LineString': return '<LineString><tessellate>1</tessellate><coordinates>' + cs(g.coordinates) + '</coordinates></LineString>';
      case 'Polygon': return '<Polygon><outerBoundaryIs><LinearRing><coordinates>' + cs(g.coordinates[0]) + '</coordinates></LinearRing></outerBoundaryIs>' +
        g.coordinates.slice(1).map(function (r) { return '<innerBoundaryIs><LinearRing><coordinates>' + cs(r) + '</coordinates></LinearRing></innerBoundaryIs>'; }).join('') + '</Polygon>';
      case 'MultiPoint': return '<MultiGeometry>' + g.coordinates.map(function (c) { return kmlGeom({ type: 'Point', coordinates: c }); }).join('') + '</MultiGeometry>';
      case 'MultiLineString': return '<MultiGeometry>' + g.coordinates.map(function (c) { return kmlGeom({ type: 'LineString', coordinates: c }); }).join('') + '</MultiGeometry>';
      case 'MultiPolygon': return '<MultiGeometry>' + g.coordinates.map(function (c) { return kmlGeom({ type: 'Polygon', coordinates: c }); }).join('') + '</MultiGeometry>';
      case 'GeometryCollection': return '<MultiGeometry>' + g.geometries.map(kmlGeom).join('') + '</MultiGeometry>';
    }
    return '';
  }

  var KML_SKIP = /^(name|description|stroke|stroke-opacity|stroke-width|fill|fill-opacity|marker-.*|styleUrl|styleHash|styleMapHash|icon|icon-.*|label-.*|visibility|open|coordinateProperties|@.*)$/;
  function cdata(t) { return '<![CDATA[' + String(t).replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>'; }
  /** opts.kmz: photos are packed in the KMZ as files/<id>.jpg and shown in the placemark's balloon. */
  function placemark(f, visible, opts) {
    var p = f.properties || {}, st = '<Style>';
    if (p.stroke) st += '<LineStyle><color>' + kmlColor(p.stroke, p['stroke-opacity'] == null ? 1 : p['stroke-opacity']) + '</color><width>' + (p['stroke-width'] || 2) + '</width></LineStyle>';
    if (p.fill) st += '<PolyStyle><color>' + kmlColor(p.fill, p['fill-opacity'] == null ? 0.3 : p['fill-opacity']) + '</color>' + (p.gc_type === 'stroke' ? '<outline>0</outline>' : '') + '</PolyStyle>';
    else if (f.geometry && /Polygon/.test(f.geometry.type)) st += '<PolyStyle><fill>0</fill></PolyStyle>';
    if (p.gc_type === 'text') st += '<IconStyle><scale>0</scale></IconStyle><LabelStyle><color>' + kmlColor(p.gc_color || '#ffffff', 1) + '</color></LabelStyle>';
    var ic = p['icon-color'] || p['marker-color'];
    var href = p.icon && (/^https?:/i.test(p.icon) || (opts && opts.kmz)) ? p.icon : null; // icons inside a KMZ are copied along in KMZ exports
    if (ic || href || p['icon-scale'] != null) st += '<IconStyle>' + (ic ? '<color>' + kmlColor(ic, p['icon-opacity'] == null ? 1 : p['icon-opacity']) + '</color>' : '') + (p['icon-scale'] != null ? '<scale>' + p['icon-scale'] + '</scale>' : '') + (href ? '<Icon><href>' + esc(href) + '</href></Icon>' : '') + '</IconStyle>';
    st += '</Style>';
    var desc = p.description == null ? '' : (typeof p.description === 'object' ? p.description.value || '' : String(p.description));
    if (opts && opts.kmz && p.gc_photos) {
      if (desc && !/<[a-z]/i.test(desc)) desc = esc(desc).replace(/\n/g, '<br>');
      if (p.gc_note && !desc) desc = esc(p.gc_note).replace(/\n/g, '<br>');
      desc += String(p.gc_photos).split(',').map(function (id) { return '<p><img src="files/' + esc(id) + '.jpg" width="480"></p>'; }).join('');
    }
    var keys = Object.keys(p).filter(function (k) { return !KML_SKIP.test(k) && p[k] != null; });
    var ext = keys.length ? '<ExtendedData>' + keys.map(function (k) { return '<Data name="' + esc(k) + '"><value>' + esc(typeof p[k] === 'object' ? JSON.stringify(p[k]) : p[k]) + '</value></Data>'; }).join('') + '</ExtendedData>' : '';
    return '<Placemark><name>' + esc(p.name || p.gc_tool || p.gc_type || 'Feature') + '</name>' + (visible === false ? '<visibility>0</visibility>' : '') + (desc ? '<description>' + cdata(desc) + '</description>' : '') + st + ext + kmlGeom(f.geometry) + '</Placemark>\n';
  }
  /** Imported GIS layers keep their KML folder tree, descriptions and visibility. */
  function vectorKml(l, opts) {
    var feats = l.geojson.features || [], hf = l.hiddenFeats || {}, fp = l.featPhotos || {};
    var tree = l.tree || feats.map(function (f, i) { return i; });
    return (function walk(nodes) {
      return nodes.map(function (nd) {
        if (typeof nd === 'number') {
          var f = feats[nd]; if (!f || !f.geometry) return '';
          if (fp[nd] && fp[nd].length) { f = { type: 'Feature', geometry: f.geometry, properties: Object.assign({}, f.properties, { gc_photos: fp[nd].map(function (r) { return r.id; }).join(',') }) }; }
          return placemark(f, !hf[nd], opts);
        }
        return '<Folder><name>' + esc(nd.n) + '</name>' + (nd.h ? '<visibility>0</visibility>' : '') + (nd.d ? '<description>' + cdata(nd.d) + '</description>' : '') + '\n' + walk(nd.c) + '</Folder>\n';
      }).join('');
    })(tree);
  }

  function kml(project, layerIds, outlines, opts) {
    var body = '';
    project.layers.forEach(function (l) {
      if (layerIds.indexOf(l.id) < 0) return;
      if (l.kind === 'raster') { if (opts && opts.kmz && l.dataURL) body += groundOverlay(l); return; }
      if (l.kind === 'cad' || l.kind === 'service' || l.kind === 'geopdf') return; // reference drawings and online maps stay in GeoCanvas
      var pm = l.kind === 'vector' ? vectorKml(l, opts) : collect(project, [l.id], outlines).map(function (f) { return placemark(f, true, opts); }).join('');
      body += '<Folder><name>' + esc(l.name) + '</name><visibility>' + (l.visible ? 1 : 0) + '</visibility>\n' + pm + '</Folder>\n';
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>' + esc(project.name) + '</name><description>Exported from GeoCanvas</description>\n' + body + '</Document></kml>\n';
  }
  function overlayFile(l) { return 'files/overlay-' + l.id + (/^data:image\/png/.test(l.dataURL) ? '.png' : '.jpg'); }
  /** Plans and GeoTIFFs as Google Earth ground overlays (a placed plan keeps its rotation via gx:LatLonQuad). */
  function groundOverlay(l) {
    var g = '<GroundOverlay><name>' + esc(l.name) + '</name><visibility>' + (l.visible ? 1 : 0) + '</visibility><color>' + kmlColor('#ffffff', l.opacity == null ? 1 : l.opacity) + '</color><Icon><href>' + overlayFile(l) + '</href></Icon>';
    if (l.corners) {
      var c = l.corners.map(function (p) { return Geo.merc(p[1], p[0]); }), br = [c[1][0] + c[2][0] - c[0][0], c[1][1] + c[2][1] - c[0][1]];
      var ll = [c[2], br, c[1], c[0]].map(function (m) { var q = Geo.unmerc(m[0], m[1]); return r8(q[0]) + ',' + r8(q[1]) + ',0'; }); // BL, BR, TR, TL
      g += '<gx:LatLonQuad><coordinates>' + ll.join(' ') + '</coordinates></gx:LatLonQuad>';
    } else {
      g += '<LatLonBox><north>' + l.bounds[1][0] + '</north><south>' + l.bounds[0][0] + '</south><east>' + l.bounds[1][1] + '</east><west>' + l.bounds[0][1] + '</west></LatLonBox>';
    }
    return g + '</GroundOverlay>\n';
  }

  function gpx(project, layerIds) {
    var w = '', t = '', iso = function (d) { return new Date(d).toISOString(); };
    project.layers.forEach(function (l) {
      if (layerIds.indexOf(l.id) < 0) return;
      if (l.kind === 'waypoints') (l.waypoints || []).forEach(function (p) { w += '<wpt lat="' + p.lat + '" lon="' + p.lon + '">' + (p.ele != null ? '<ele>' + p.ele + '</ele>' : '') + '<time>' + iso(p.time) + '</time><name>' + esc(p.name) + '</name>' + (p.note ? '<desc>' + esc(p.note) + '</desc>' : '') + '</wpt>\n'; });
      if (l.kind === 'track') (l.tracks || []).forEach(function (tr) { t += '<trk><name>' + esc(tr.name) + '</name><trkseg>\n' + tr.points.map(function (p) { return '<trkpt lat="' + p[1] + '" lon="' + p[0] + '">' + (p[3] != null ? '<ele>' + p[3] + '</ele>' : '') + '<time>' + iso(p[2]) + '</time></trkpt>'; }).join('\n') + '\n</trkseg></trk>\n'; });
      if (l.kind === 'vector') (l.geojson.features || []).forEach(function (f) {
        var g = f.geometry, p = f.properties || {}, nm = esc(p.name || p.NAME || p.Name || p.label || p.id || ''), parts = [];
        if (!g) return;
        if (g.type === 'Point') w += '<wpt lat="' + g.coordinates[1] + '" lon="' + g.coordinates[0] + '"><name>' + nm + '</name></wpt>\n';
        else if (g.type === 'MultiPoint') g.coordinates.forEach(function (c) { w += '<wpt lat="' + c[1] + '" lon="' + c[0] + '"><name>' + nm + '</name></wpt>\n'; });
        else if (g.type === 'LineString') parts = [g.coordinates]; else if (g.type === 'MultiLineString') parts = g.coordinates;
        if (parts.length) t += '<trk><name>' + nm + '</name>' + parts.map(function (c) { return '<trkseg>' + c.map(function (q) { return '<trkpt lat="' + q[1] + '" lon="' + q[0] + '">' + (q.length > 2 && q[2] != null ? '<ele>' + q[2] + '</ele>' : '') + '</trkpt>'; }).join('') + '</trkseg>'; }).join('') + '</trk>\n';
      });
      if (l.kind === 'drawing') (l.items || []).forEach(function (el) { if (el.type === 'marker' || el.type === 'text') w += '<wpt lat="' + el.at[1] + '" lon="' + el.at[0] + '"><name>' + esc(el.title || el.text || 'Marker') + '</name>' + (el.note ? '<desc>' + esc(el.note) + '</desc>' : '') + '</wpt>\n'; });
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GeoCanvas" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>' + esc(project.name) + '</name></metadata>\n' + w + t + '</gpx>\n';
  }

  // ---------- rasters ----------
  /** Extent covering drawing items at a ground resolution (m/px), max 6000 px per side. */
  function rasterExtent(items, mpp) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    items.forEach(function (el) { var m = Ink.mercBounds(el); b[0] = Math.min(b[0], m[0]); b[1] = Math.min(b[1], m[1]); b[2] = Math.max(b[2], m[2]); b[3] = Math.max(b[3], m[3]); });
    if (!isFinite(b[0])) return null;
    var pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.03 + 1e-9; b = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    var lat = Geo.unmerc(0, (b[1] + b[3]) / 2)[1];
    var unit = mpp / (40075016.685578488 * Math.cos(lat * Math.PI / 180)); // mercator units per pixel
    var w = Math.ceil((b[2] - b[0]) / unit), h = Math.ceil((b[3] - b[1]) / unit), k = Math.max(w, h) / 6000;
    if (k > 1) { w = Math.ceil(w / k); h = Math.ceil(h / k); unit *= k; }
    return { minX: b[0], minY: b[1], unit: unit, w: Math.max(1, w), h: Math.max(1, h) };
  }

  /** Renders items into a transparent canvas for an extent. Markers drawn as dots. */
  function renderCanvas(project, layerIds, ex) {
    var cv = document.createElement('canvas'); cv.width = ex.w; cv.height = ex.h;
    var ctx = cv.getContext('2d'), scale = 1 / ex.unit, z = Math.log(scale / 256) / Math.LN2;
    var pt = function (m) { return [(m[0] - ex.minX) * scale, (m[1] - ex.minY) * scale]; };
    project.layers.forEach(function (l) {
      if (l.kind !== 'drawing' || layerIds.indexOf(l.id) < 0) return;
      (l.items || []).forEach(function (el) {
        if (el.type === 'marker') { var p = pt(Geo.merc(el.at[0], el.at[1])); ctx.globalAlpha = l.opacity; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p[0], p[1], 9, 0, 7); ctx.fill(); ctx.fillStyle = el.color; ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
        else Ink.draw(ctx, el, pt, z, l.opacity);
      });
    });
    return cv;
  }

  function straightRGBA(cv) {
    var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; // already non-premultiplied in canvas API
    return d;
  }

  /** Uncompressed RGBA GeoTIFF (EPSG:3857, PixelIsArea, unassociated alpha). */
  function geotiff(cv, ex) {
    var w = cv.width, h = cv.height, px = straightRGBA(cv);
    var C = 40075016.685578488, ps = ex.unit * C, ulx = (ex.minX - 0.5) * C, uly = (0.5 - ex.minY) * C;
    var cit = 'GeoCanvas annotations|';
    var entries = [
      [256, 4, [w]], [257, 4, [h]], [258, 3, [8, 8, 8, 8]], [259, 3, [1]], [262, 3, [2]], [273, 4, [0]], [277, 3, [4]], [278, 4, [h]],
      [279, 4, [w * h * 4]], [284, 3, [1]], [338, 3, [2]], [339, 3, [1, 1, 1, 1]],
      [33550, 12, [ps, ps, 0]], [33922, 12, [0, 0, 0, ulx, uly, 0]],
      [34735, 3, [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 1026, 34737, cit.length, 0, 3072, 0, 1, 3857]],
      [34737, 2, cit]
    ];
    var size = { 2: 1, 3: 2, 4: 4, 12: 8 }, count = function (e) { return e[1] === 2 ? e[2].length + 1 : e[2].length; };
    var ifdSize = 2 + entries.length * 12 + 4, extra = 0, offs = [];
    entries.forEach(function (e) { var n = count(e) * size[e[1]]; offs.push(n > 4 ? 8 + ifdSize + extra : -1); if (n > 4) extra += n + (n % 2); });
    var dataOff = 8 + ifdSize + extra, total = dataOff + w * h * 4;
    entries[5][2] = [dataOff];
    var buf = new ArrayBuffer(total), dv = new DataView(buf), u8 = new Uint8Array(buf);
    dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, entries.length, true);
    entries.forEach(function (e, i) {
      var o = 10 + i * 12, n = count(e), tgt = offs[i] > 0 ? offs[i] : o + 8;
      dv.setUint16(o, e[0], true); dv.setUint16(o + 2, e[1], true); dv.setUint32(o + 4, n, true);
      if (offs[i] > 0) dv.setUint32(o + 8, offs[i], true);
      for (var k = 0; k < n; k++) {
        if (e[1] === 2) u8[tgt + k] = k < e[2].length ? e[2].charCodeAt(k) : 0;
        else if (e[1] === 3) dv.setUint16(tgt + k * 2, e[2][k], true);
        else if (e[1] === 4) dv.setUint32(tgt + k * 4, e[2][k], true);
        else dv.setFloat64(tgt + k * 8, e[2][k], true);
      }
    });
    dv.setUint32(10 + entries.length * 12, 0, true);
    u8.set(px, dataOff);
    return new Blob([buf], { type: 'image/tiff' });
  }

  var WKT3857 = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3857"]]';
  function worldFile(ex) {
    var C = 40075016.685578488, ps = ex.unit * C, ulx = (ex.minX - 0.5) * C, uly = (0.5 - ex.minY) * C;
    return [ps, 0, 0, -ps, ulx + ps / 2, uly - ps / 2].map(function (v) { return v.toFixed(10); }).join('\n') + '\n';
  }

  global.Exporters = { geojson: geojson, kml: kml, overlayFile: overlayFile, gpx: gpx, rasterExtent: rasterExtent, renderCanvas: renderCanvas, geotiff: geotiff, worldFile: worldFile, WKT3857: WKT3857, collect: collect };
})(typeof window !== 'undefined' ? window : global);

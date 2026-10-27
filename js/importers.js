/* GeoCanvas web — GIS import (KML, KMZ, shapefile/zip, GeoJSON, GPX, GeoTIFF).
   Projected data without CRS information is never placed silently: it is returned as "pending"
   so the user can choose the coordinate system (e.g. MGA zone 56 around Toowoomba). */
(function (global) {
  'use strict';
  var Geo = global.Geo;

  function ext(name) { var m = /\.([^.\/]+)$/.exec(name.toLowerCase()); return m ? m[1] : ''; }
  function base(name) { return name.replace(/^.*\//, '').replace(/\.[^.]+$/, ''); }
  function readFile(file) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(new Error('Could not read ' + file.name)); }; r.readAsArrayBuffer(file); });
  }
  function text(buf) { try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-1252').decode(buf); } }

  // ---------- coordinate walking ----------
  function eachCoord(g, f) {
    if (!g) return;
    switch (g.type) {
      case 'Point': f(g.coordinates); break;
      case 'MultiPoint': case 'LineString': g.coordinates.forEach(f); break;
      case 'MultiLineString': case 'Polygon': g.coordinates.forEach(function (r) { r.forEach(f); }); break;
      case 'MultiPolygon': g.coordinates.forEach(function (p) { p.forEach(function (r) { r.forEach(f); }); }); break;
      case 'GeometryCollection': g.geometries.forEach(function (x) { eachCoord(x, f); }); break;
    }
  }
  function mapGeom(g, f) {
    if (!g) return g;
    var m = function (c) { var r = f(c); return c.length > 2 ? [r[0], r[1], c[2]] : r; };
    switch (g.type) {
      case 'Point': return { type: g.type, coordinates: m(g.coordinates) };
      case 'MultiPoint': case 'LineString': return { type: g.type, coordinates: g.coordinates.map(m) };
      case 'MultiLineString': case 'Polygon': return { type: g.type, coordinates: g.coordinates.map(function (r) { return r.map(m); }) };
      case 'MultiPolygon': return { type: g.type, coordinates: g.coordinates.map(function (p) { return p.map(function (r) { return r.map(m); }); }) };
      case 'GeometryCollection': return { type: g.type, geometries: g.geometries.map(function (x) { return mapGeom(x, f); }) };
    }
    return g;
  }
  function bounds(fc) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    fc.features.forEach(function (ft) { eachCoord(ft.geometry, function (c) { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); }); });
    return b;
  }
  function looksGeographic(b) { return isFinite(b[0]) && b[0] >= -180.001 && b[2] <= 360.001 && b[1] >= -90.001 && b[3] <= 90.001; }
  function zoneHint(name) { var m = /(?:mga|zone|amg|utm|z)[ _-]?(\d{2})/i.exec(name); return m ? +m[1] : null; }

  function project(fc, code) {
    var bad = 0;
    var out = { type: 'FeatureCollection', features: fc.features.map(function (ft) {
      return { type: 'Feature', properties: ft.properties || {}, geometry: mapGeom(ft.geometry, function (c) {
        var ll = Geo.toWGS84(code, c); if (!isFinite(ll[0]) || Math.abs(ll[1]) > 90) bad++; return ll; }) };
    }) };
    if (bad) throw new Error(bad + ' coordinates fell outside the Earth after converting from ' + Geo.crsLabel(code) + '. The coordinate system is probably wrong.');
    return out;
  }

  // Decides the CRS of a raw collection and returns a vector result or a pending dataset.
  function finish(r, name, format, raw, declared, formatDefaultWGS84, files, warnings, extra) {
    var b = bounds(raw);
    if (!isFinite(b[0])) { r.failures.push({ file: name, error: 'No geographic features were found.' }); return; }
    if (r.force && !formatDefaultWGS84) declared = r.force;
    if (declared != null) {
      r.vectors.push(Object.assign({ name: name, format: format, geojson: (declared === 4326 || declared === 7844) ? raw : project(raw, declared), crs: declared, warnings: warnings, files: files }, extra));
    } else if (looksGeographic(b)) {
      if (!formatDefaultWGS84) warnings.unshift('No coordinate system (.prj) was supplied. The coordinates look like latitude/longitude and were treated as WGS84 — use “Change coordinate system” if the layer is misplaced.');
      r.vectors.push({ name: name, format: format, geojson: raw, crs: 4326, assumed: !formatDefaultWGS84, warnings: warnings, files: files });
    } else {
      r.pending.push({ name: name, format: format, raw: raw, files: files, warnings: warnings, suggestions: Geo.pickerOptions(zoneHint(name)),
        explanation: name + ' has projected coordinates (x ' + Math.round(b[0]) + '…' + Math.round(b[2]) + ', y ' + Math.round(b[1]) + '…' + Math.round(b[3]) + ') but no coordinate system information. Choose the system it was made in (around Toowoomba this is usually MGA zone 56).' });
    }
  }

  // ---------- Shapefile ----------
  function readShp(buf) {
    var dv = new DataView(buf), feats = [], warn = [];
    if (buf.byteLength < 100 || dv.getInt32(0, false) !== 9994) throw new Error('This .shp file is not a valid shapefile.');
    var fileLen = Math.min(buf.byteLength, dv.getInt32(24, false) * 2 || buf.byteLength), off = 100, idx = 0;
    while (off + 8 <= fileLen) {
      var len = dv.getInt32(off + 4, false) * 2, o = off + 8;
      if (len < 4 || o + len > buf.byteLength) { warn.push('The shapefile is truncated; ' + idx + ' records were read.'); break; }
      var t = dv.getInt32(o, true), base = { 0: 0, 1: 1, 11: 1, 21: 1, 3: 3, 13: 3, 23: 3, 5: 5, 15: 5, 25: 5, 31: 5, 8: 8, 18: 8, 28: 8 }[t];
      var geom = null;
      if (base === 1) geom = { type: 'Point', coordinates: [dv.getFloat64(o + 4, true), dv.getFloat64(o + 12, true)] };
      else if (base === 8) { var np = dv.getInt32(o + 36, true), pts = []; for (var i = 0; i < np; i++) pts.push([dv.getFloat64(o + 40 + i * 16, true), dv.getFloat64(o + 48 + i * 16, true)]); geom = { type: 'MultiPoint', coordinates: pts }; }
      else if (base === 3 || base === 5) {
        var nParts = dv.getInt32(o + 36, true), nPts = dv.getInt32(o + 40, true), parts = [];
        if (44 + nParts * 4 + nPts * 16 > len) throw new Error('A shape record is corrupt.');
        for (var p = 0; p < nParts; p++) parts.push(dv.getInt32(o + 44 + p * 4, true)); parts.push(nPts);
        var p0 = o + 44 + nParts * 4, rings = [];
        for (var q = 0; q < nParts; q++) { var ring = []; for (var k = parts[q]; k < parts[q + 1]; k++) ring.push([dv.getFloat64(p0 + k * 16, true), dv.getFloat64(p0 + k * 16 + 8, true)]); rings.push(ring); }
        if (base === 3) { rings = rings.filter(function (r) { return r.length >= 2; }); geom = rings.length === 1 ? { type: 'LineString', coordinates: rings[0] } : { type: 'MultiLineString', coordinates: rings }; }
        else geom = assemble(rings.filter(function (r) { return r.length >= 3; }));
      }
      feats.push(geom);
      off = o + len; idx++;
    }
    return { geoms: feats, warnings: warn };
  }
  function signedArea(r) { var s = 0; for (var i = 0; i < r.length; i++) { var a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
  function assemble(rings) { // outer rings clockwise, holes counter-clockwise
    var outers = [], holes = [];
    rings.forEach(function (r) { (signedArea(r) <= 0 ? outers : holes).push(r); });
    if (!outers.length) return { type: 'MultiPolygon', coordinates: holes.map(function (h) { return [h]; }) };
    var polys = outers.map(function (o) { return [o]; });
    holes.forEach(function (h) {
      var host = polys.filter(function (p) { return global.Ink.inPoly(p[0], h[0]); })[0];
      if (host) host.push(h); else polys.push([h]);
    });
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }
  function readDbf(buf, cpg) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf);
    var n = dv.getUint32(4, true), hl = dv.getUint16(8, true), rl = dv.getUint16(10, true), fields = [];
    for (var o = 32; o + 32 <= hl && u8[o] !== 0x0d; o += 32) {
      var nm = ''; for (var i = 0; i < 11 && u8[o + i]; i++) nm += String.fromCharCode(u8[o + i]);
      fields.push({ name: nm.trim(), type: String.fromCharCode(u8[o + 11]), len: u8[o + 16], dec: u8[o + 17] });
    }
    var enc = /1252|ansi/i.test(cpg || '') ? 'windows-1252' : (/8859|latin/i.test(cpg || '') ? 'iso-8859-1' : 'utf-8');
    var dec; try { dec = new TextDecoder(enc, { fatal: enc === 'utf-8' }); } catch (e) { dec = new TextDecoder('utf-8'); }
    var latin = new TextDecoder('windows-1252'), rows = [], deleted = [];
    var avail = Math.floor((buf.byteLength - hl) / rl);
    for (var r = 0; r < Math.min(n, avail); r++) {
      var b0 = hl + r * rl, pos = b0 + 1, row = {};
      deleted.push(u8[b0] === 0x2a);
      fields.forEach(function (f) {
        var bytes = u8.subarray(pos, pos + f.len); pos += f.len;
        var s; try { s = dec.decode(bytes); } catch (e) { s = latin.decode(bytes); }
        s = s.replace(/\0/g, '').trim();
        var v;
        if (f.type === 'N' || f.type === 'F') v = s === '' || /^\*+$/.test(s) ? null : (isNaN(+s) ? s : +s);
        else if (f.type === 'L') v = /^[TtYy]/.test(s) ? true : (/^[FfNn]/.test(s) ? false : null);
        else if (f.type === 'D') v = s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6) : (s || null);
        else v = s === '' ? null : s;
        row[f.name] = v;
      });
      rows.push(row);
    }
    return { rows: rows, deleted: deleted, fields: fields.map(function (f) { return f.name; }) };
  }

  // ---------- KML / KMZ ----------
  function kids(el, tag) { var out = []; for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === tag) out.push(c); return out; }
  function kidText(el, tag) { var k = kids(el, tag)[0]; return k ? k.textContent.trim() : null; }
  var KML_INTERNAL = /^(name|description|styleUrl|styleHash|styleMapHash|stroke|stroke-opacity|stroke-width|fill|fill-opacity|icon|icon-.*|label-.*|marker-.*|visibility|open|address|phoneNumber|timespan|timestamp|coordinateProperties|@.*)$/;
  /** Reads a KML document keeping Google Earth's structure: the folder tree, visibility, balloon styles,
      Data display names and placemark icons stored inside a KMZ. */
  function kmlToResult(r, name, format, kmlText, files, zipEntries) {
    var dom = new DOMParser().parseFromString(kmlText, 'text/xml');
    if (dom.getElementsByTagName('parsererror').length) throw new Error('The KML is not valid XML.');
    var warnings = [];
    if (dom.getElementsByTagName('NetworkLink').length) warnings.push('NetworkLinks (online content) were not loaded.');

    // Balloon templates by style id (StyleMap → its "normal" style).
    var bal = {}, maps = {};
    Array.prototype.forEach.call(dom.getElementsByTagName('Style'), function (st) {
      var b = kids(st, 'BalloonStyle')[0], t = b && kidText(b, 'text');
      if (t && st.getAttribute('id')) bal['#' + st.getAttribute('id')] = t;
    });
    Array.prototype.forEach.call(dom.getElementsByTagName('StyleMap'), function (sm) {
      kids(sm, 'Pair').forEach(function (pr) { if (kidText(pr, 'key') === 'normal' && sm.getAttribute('id')) maps['#' + sm.getAttribute('id')] = kidText(pr, 'styleUrl'); });
    });
    var dnames = {};
    Array.prototype.forEach.call(dom.getElementsByTagName('Data'), function (d) { var dn = kidText(d, 'displayName'); if (dn && d.getAttribute('name')) dnames[d.getAttribute('name')] = dn; });
    Array.prototype.forEach.call(dom.getElementsByTagName('SimpleField'), function (d) { var dn = kidText(d, 'displayName'); if (dn && d.getAttribute('name')) dnames[d.getAttribute('name')] = dn; });

    // Tag placemarks so features can be matched to their DOM element.
    var pms = dom.getElementsByTagName('Placemark'), ids = [];
    for (var i = 0; i < pms.length; i++) { ids.push(pms[i].getAttribute('id')); pms[i].setAttribute('id', 'gc~' + i); }
    var root = toGeoJSON.kmlWithFolders(dom);

    var feats = [], hidden = {}, templates = [], fb = {}, icons = {}, seq = 0;
    function balloonFor(pm, props) {
      var own = null, inline = kids(pm, 'Style')[0], b = inline && kids(inline, 'BalloonStyle')[0];
      if (b) own = kidText(b, 'text');
      if (!own && props.styleUrl) { var u = props.styleUrl.replace(/^[^#]*/, ''); own = bal[maps[u] ? maps[u].replace(/^[^#]*/, '') : u] || null; }
      return own;
    }
    function walk(node, out, parentHidden) {
      node.children.forEach(function (c) {
        if (c.type === 'folder') {
          var f = { id: 'f' + (seq++).toString(36), n: c.meta.name || 'Folder', c: [] };
          if (c.meta.visibility === '0') f.h = 1;
          if (c.meta.open === '1') f.o = 1;
          if (c.meta.description) f.d = c.meta.description;
          out.push(f); walk(c, f.c, parentHidden || f.h);
          return;
        }
        if (!c.geometry || (c.properties && c.properties['@geometry-type'] === 'groundoverlay')) return;
        var m = /^gc~(\d+)$/.exec(c.id || ''), pm = m ? pms[+m[1]] : null;
        if (m) { if (ids[+m[1]]) c.id = ids[+m[1]]; else delete c.id; }
        var p = c.properties = c.properties || {};
        if (p.description && typeof p.description === 'object') p.description = p.description.value || '';
        if (p.visibility === false) hidden[feats.length] = 1;
        delete p.visibility;
        if (pm) { var t = balloonFor(pm, p); if (t) { var k = templates.indexOf(t); if (k < 0) { k = templates.length; templates.push(t); } fb[feats.length] = k; } }
        if (p.icon && zipEntries) { var e = zipEntries[p.icon] || zipEntries[decodeURIComponent(p.icon)]; if (e) icons[p.icon] = e; }
        out.push(feats.length); feats.push(c);
      });
    }
    var tree = [];
    walk(root, tree, false);
    // A document holding a single folder: that folder is the layer itself, as Google Earth shows it.
    var doc = dom.getElementsByTagName('Document')[0], docName = doc && kidText(doc, 'name');
    while (tree.length === 1 && typeof tree[0] === 'object' && !tree[0].h) { docName = docName || tree[0].n; tree = tree[0].c; }
    var fc = { type: 'FeatureCollection', features: feats };
    var extra = { tree: tree, hiddenFeats: hidden, balloons: templates.length ? templates : null, featBalloon: templates.length ? fb : null,
      displayNames: Object.keys(dnames).length ? dnames : null, iconBlobs: Object.keys(icons).length ? icons : null, kml: true };
    if (feats.length) finish(r, docName || name, format, fc, 4326, true, files, warnings, extra);
    var gos = dom.getElementsByTagName('GroundOverlay');
    for (i = 0; i < gos.length; i++) {
      var go = gos[i], q = function (t) { var e = go.getElementsByTagName(t)[0]; return e ? e.textContent.trim() : null; };
      var href = q('href'), n = +q('north'), s = +q('south'), e = +q('east'), w = +q('west');
      if (!href || !isFinite(n)) continue;
      var entry = zipEntries && (zipEntries[href] || zipEntries[decodeURIComponent(href)]);
      if (!entry) { warnings.push('Ground overlay “' + (q('name') || href) + '” image is not inside the file and was skipped.'); continue; }
      r.overlays.push({ name: q('name') || 'Ground overlay', blob: entry, bounds: [[s, w], [n, e]], rotation: +(q('rotation') || 0), files: files });
    }
  }
  // ---------- GeoTIFF ----------
  var PROJ_KEYS = { 3072: 'ProjectedCSTypeGeoKey', 2048: 'GeographicTypeGeoKey' };
  function geotiff(r, name, buf, files, maxDim) {
    if (!global.GeoTIFF) throw new Error('GeoTIFF support could not load.');
    return GeoTIFF.fromArrayBuffer(buf).then(function (tiff) { return tiff.getImage(); }).then(function (img) {
      var keys = img.getGeoKeys() || {}, code = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey;
      if (code === 32767) code = null;
      var bbox; try { bbox = img.getBoundingBox(); } catch (e) { throw new Error(name + ' has no georeferencing. Georeference it in QGIS first.'); }
      var W = img.getWidth(), H = img.getHeight(), k = Math.max(1, Math.max(W, H) / maxDim), w = Math.round(W / k), h = Math.round(H / k);
      var nodata = img.getGDALNoData();
      return img.readRasters({ width: w, height: h, resampleMethod: 'nearest', interleave: false }).then(function (bands) {
        var rgba = new Uint8ClampedArray(w * h * 4), spp = bands.length;
        if (spp >= 3) {
          var sc = bands[0] instanceof Uint16Array ? 1 / 257 : 1;
          for (var i = 0; i < w * h; i++) { rgba[i * 4] = bands[0][i] * sc; rgba[i * 4 + 1] = bands[1][i] * sc; rgba[i * 4 + 2] = bands[2][i] * sc; rgba[i * 4 + 3] = spp > 3 ? bands[3][i] * sc : 255; if (nodata != null && bands[0][i] === nodata && bands[1][i] === nodata) rgba[i * 4 + 3] = 0; }
        } else {
          var b = bands[0], vals = [];
          for (var j = 0; j < b.length; j += Math.max(1, Math.floor(b.length / 50000))) if (isFinite(b[j]) && b[j] !== nodata) vals.push(b[j]);
          vals.sort(function (x, y) { return x - y; });
          var lo = vals[Math.floor(vals.length * 0.02)] || 0, hi = vals[Math.floor(vals.length * 0.98)] || 1, rg = hi > lo ? hi - lo : 1;
          for (var m = 0; m < w * h; m++) { var v = b[m]; if (!isFinite(v) || v === nodata) { rgba[m * 4 + 3] = 0; continue; } var gv = Math.max(0, Math.min(255, (v - lo) / rg * 255)); rgba[m * 4] = rgba[m * 4 + 1] = rgba[m * 4 + 2] = gv; rgba[m * 4 + 3] = 255; }
        }
        var raw = { rgba: rgba, w: w, h: h, bbox: bbox };
        if (!code) {
          var geo = bbox[0] >= -180 && bbox[2] <= 180 && bbox[1] >= -90 && bbox[3] <= 90;
          if (!geo) { r.pending.push({ name: name, format: 'GeoTIFF', raster: raw, files: files, warnings: [], suggestions: Geo.pickerOptions(zoneHint(name)), explanation: name + ' is georeferenced in projected coordinates but does not say which coordinate system. Choose it to continue.' }); return; }
          code = 4326;
        }
        if (!Geo.CRS[code]) throw new Error(name + ' uses EPSG:' + code + ', which GeoCanvas does not know. Reproject it to GDA2020 / MGA or WGS84 in QGIS.');
        r.rasters.push(warpRaster(raw, code, name, files));
      });
    });
  }

  // Reprojects a north-up raster in any CRS to a Web Mercator image + lat/lon bounds.
  function warpRaster(raw, code, name, files) {
    var w = raw.w, h = raw.h, b = raw.bbox, sx = (b[2] - b[0]) / w, sy = (b[3] - b[1]) / h;
    function pixToMerc(px, py) { var ll = Geo.toWGS84(code, [b[0] + px * sx, b[3] - py * sy]); return Geo.merc(ll[0], ll[1]); }
    var mb = [Infinity, Infinity, -Infinity, -Infinity];
    for (var i = 0; i <= 32; i++) { var f = i / 32;[[f * w, 0], [f * w, h], [0, f * h], [w, f * h]].forEach(function (p) { var m = pixToMerc(p[0], p[1]); mb[0] = Math.min(mb[0], m[0]); mb[1] = Math.min(mb[1], m[1]); mb[2] = Math.max(mb[2], m[0]); mb[3] = Math.max(mb[3], m[1]); }); }
    var ow = w, oh = Math.max(1, Math.round(w * (mb[3] - mb[1]) / (mb[2] - mb[0])));
    if (oh > 4096) { ow = Math.round(ow * 4096 / oh); oh = 4096; }
    var out = new Uint8ClampedArray(ow * oh * 4), G = 16, gw = Math.floor(ow / G) + 2, gh = Math.floor(oh / G) + 2, grid = [];
    for (var gy = 0; gy < gh; gy++) for (var gx = 0; gx < gw; gx++) {
      var mx = mb[0] + gx * G / ow * (mb[2] - mb[0]), my = mb[1] + gy * G / oh * (mb[3] - mb[1]);
      var ll = Geo.unmerc(mx, my), c = Geo.fromWGS84(code, ll);
      grid.push([(c[0] - b[0]) / sx, (b[3] - c[1]) / sy]);
    }
    for (var y = 0; y < oh; y++) {
      var ty = Math.floor(y / G), fy = (y % G + 0.5) / G;
      for (var x = 0; x < ow; x++) {
        var tx = Math.floor(x / G), fx = (x % G + 0.5) / G;
        var p00 = grid[ty * gw + tx], p10 = grid[ty * gw + tx + 1], p01 = grid[(ty + 1) * gw + tx], p11 = grid[(ty + 1) * gw + tx + 1];
        var px = (p00[0] + (p10[0] - p00[0]) * fx) * (1 - fy) + (p01[0] + (p11[0] - p01[0]) * fx) * fy;
        var py = (p00[1] + (p10[1] - p00[1]) * fx) * (1 - fy) + (p01[1] + (p11[1] - p01[1]) * fx) * fy;
        var ix = Math.floor(px), iy = Math.floor(py);
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
        var si = (iy * w + ix) * 4, oi = (y * ow + x) * 4;
        out[oi] = raw.rgba[si]; out[oi + 1] = raw.rgba[si + 1]; out[oi + 2] = raw.rgba[si + 2]; out[oi + 3] = raw.rgba[si + 3];
      }
    }
    var cv = document.createElement('canvas'); cv.width = ow; cv.height = oh;
    cv.getContext('2d').putImageData(new ImageData(out, ow, oh), 0, 0);
    var nw = Geo.unmerc(mb[0], mb[1]), se = Geo.unmerc(mb[2], mb[3]);
    return { name: name, format: 'GeoTIFF', dataURL: cv.toDataURL('image/png'), bounds: [[se[1], nw[0]], [nw[1], se[0]]], crs: code, warnings: [], files: files };
  }

  // ---------- main entry ----------
  /** files: File[]. Resolves {vectors, rasters, overlays, pending, failures}. */
  function importFiles(fileList, opts) {
    opts = opts || {};
    var r = { vectors: [], rasters: [], overlays: [], pending: [], failures: [], force: opts.forceCRS || null };
    var entries = []; // {name, buf, file}
    return Promise.all(Array.prototype.map.call(fileList, function (f) {
      return readFile(f).then(function (buf) { entries.push({ name: f.name, buf: buf, blob: f }); }, function (e) { r.failures.push({ file: f.name, error: e.message }); });
    })).then(function () {
      // Expand ZIP archives (not KMZ).
      return Promise.all(entries.filter(function (e) { return ext(e.name) === 'zip'; }).map(function (z) {
        return JSZip.loadAsync(z.buf).then(function (zip) {
          var inner = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir && !/__MACOSX|\/\._/.test(n); });
          var supported = inner.filter(function (n) { return /\.(shp|shx|dbf|prj|cpg|kml|kmz|geojson|json|gpx|tif|tiff)$/i.test(n); });
          if (!supported.length) r.failures.push({ file: z.name, error: 'The ZIP contains no supported GIS files.' });
          return Promise.all(supported.map(function (n) { return zip.files[n].async('arraybuffer').then(function (buf) { entries.push({ name: n.replace(/^.*\//, ''), path: n, buf: buf, fromZip: z }); }); }));
        }, function () { r.failures.push({ file: z.name, error: 'The archive is damaged or is not a valid ZIP file.' }); });
      }));
    }).then(function () {
      var tasks = [];
      var loose = entries.filter(function (e) { return ext(e.name) !== 'zip'; });
      var origin = function (e) { return e.fromZip ? e.fromZip.blob : e.blob; };
      // Shapefiles grouped by base name.
      var groups = {};
      loose.filter(function (e) { return /^(shp|shx|dbf|prj|cpg)$/.test(ext(e.name)); }).forEach(function (e) {
        var k = (e.path || e.name).replace(/\.[^.]+$/, '').toLowerCase(); (groups[k] = groups[k] || {})[ext(e.name)] = e;
      });
      Object.keys(groups).forEach(function (k) {
        var g = groups[k], nm = g.shp ? base(g.shp.name) : base(k);
        if (!g.shp) { Object.keys(g).forEach(function (x) { r.failures.push({ file: g[x].name, error: 'This is part of a shapefile, but the matching .shp file was not selected. Select the .shp together with its .dbf, .shx and .prj, or import the ZIP that contains them.' }); }); return; }
        try {
          var shp = readShp(g.shp.buf), warnings = shp.warnings.slice();
          if (!g.shx) warnings.push('The .shx index is missing; records were read in order.');
          var dbf = null;
          if (g.dbf) { try { dbf = readDbf(g.dbf.buf, g.cpg ? text(g.cpg.buf) : null); } catch (e) { warnings.push('Attributes could not be read; geometry was imported without them.'); } }
          else warnings.push('The .dbf attribute file is missing; features have no attributes.');
          var feats = [];
          shp.geoms.forEach(function (gm, i) { if (gm && !(dbf && dbf.deleted[i])) feats.push({ type: 'Feature', geometry: gm, properties: dbf && dbf.rows[i] ? dbf.rows[i] : {} }); });
          var declared = null;
          if (g.prj) { var pr = Geo.parsePrj(text(g.prj.buf)); if (pr) { declared = pr.code; if (pr.warning) warnings.push(pr.warning); } else warnings.push('The .prj file could not be interpreted.'); }
          var files = [g.shp, g.shx, g.dbf, g.prj, g.cpg].filter(Boolean).map(function (e) { return { name: e.name, blob: e.fromZip ? null : e.blob, buf: e.buf }; });
          finish(r, nm, 'Shapefile', { type: 'FeatureCollection', features: feats }, declared, false, files, warnings);
        } catch (e) { r.failures.push({ file: g.shp.name, error: e.message }); }
      });
      loose.forEach(function (e) {
        var x = ext(e.name), nm = base(e.name), files = [{ name: e.name, blob: e.fromZip ? null : e.blob, buf: e.buf }];
        try {
          if (x === 'kml') kmlToResult(r, nm, 'KML', text(e.buf), files, null);
          else if (x === 'kmz') tasks.push(JSZip.loadAsync(e.buf).then(function (zip) {
            var names = Object.keys(zip.files), main = names.filter(function (n) { return /\.kml$/i.test(n); }).sort(function (a, b) { return (a === 'doc.kml' ? -1 : 0) - (b === 'doc.kml' ? -1 : 0) || a.split('/').length - b.split('/').length; })[0];
            if (!main) throw new Error('The KMZ contains no KML document.');
            var imgs = {};
            return Promise.all(names.filter(function (n) { return /\.(png|jpe?g|gif)$/i.test(n); }).map(function (n) { return zip.files[n].async('blob').then(function (b) { imgs[n] = b; }); }))
              .then(function () { return zip.files[main].async('string'); }).then(function (k) { kmlToResult(r, nm, 'KMZ', k, files, imgs); });
          }).catch(function (err) { r.failures.push({ file: e.name, error: /zip/i.test(err.message) ? 'The KMZ is damaged.' : err.message }); }));
          else if (x === 'geojson' || x === 'json') {
            var js = JSON.parse(text(e.buf)), fc = js.type === 'FeatureCollection' ? js : (js.type === 'Feature' ? { type: 'FeatureCollection', features: [js] } : { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: js }] });
            var crsName = js.crs && js.crs.properties && js.crs.properties.name, code = null;
            if (crsName) { var mm = /(\d{4,5})\s*$/.exec(crsName); code = /CRS84/i.test(crsName) ? 4326 : (mm && Geo.CRS[+mm[1]] ? +mm[1] : null); }
            finish(r, nm, 'GeoJSON', fc, code, code == null, files, []);
          } else if (x === 'gpx') {
            var dom = new DOMParser().parseFromString(text(e.buf), 'text/xml');
            if (dom.getElementsByTagName('parsererror').length) throw new Error('The GPX is not valid XML.');
            var gfc = toGeoJSON.gpx(dom), md = dom.getElementsByTagName('metadata')[0], title = md && md.getElementsByTagName('name')[0];
            finish(r, title ? title.textContent : nm, 'GPX', gfc, 4326, true, files, []);
          } else if (x === 'tif' || x === 'tiff') {
            tasks.push(geotiff(r, nm, e.buf, files, opts.maxRaster || 3000).catch(function (err) { r.failures.push({ file: e.name, error: err.message || String(err) }); }));
          } else if (!/^(shp|shx|dbf|prj|cpg)$/.test(x)) {
            r.failures.push({ file: e.name, error: 'Unsupported file type (.' + x + '). GeoCanvas imports KML, KMZ, shapefiles, GeoJSON, GPX, GeoTIFF and ZIP files containing them.' });
          }
        } catch (err) {
          r.failures.push({ file: e.name, error: err instanceof SyntaxError ? 'The file is not valid ' + (x === 'gpx' ? 'GPX' : 'JSON') + '.' : err.message });
        }
      });
      return Promise.all(tasks);
    }).then(function () { return r; });
  }

  /** Completes a pending dataset with the CRS chosen by the user. */
  function resolvePending(p, code) {
    if (p.raster) return { rasters: [warpRaster(p.raster, code, p.name, p.files)] };
    return { vectors: [{ name: p.name, format: p.format, geojson: project(p.raw, code), crs: code, chosen: true, warnings: p.warnings, files: p.files }] };
  }

  global.Importers = { importFiles: importFiles, resolvePending: resolvePending, project: project, bounds: bounds, eachCoord: eachCoord, KML_INTERNAL: KML_INTERNAL };
})(typeof window !== 'undefined' ? window : global);

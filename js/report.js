/* GeoCanvas web — PDF photo report from the actions register (also a work pack for a contractor, e.g. an arborist).
   A4 portrait, written directly as PDF (real text, the original JPEGs, clickable links): the project logo in the header;
   a cover with the summary, an overview map with numbered pins and a register of every action (each row links to its
   page); then the actions, two per page (or one large) with their photo beside a location map, extra photos, category,
   importance, taken, checked by/when, nearest street address and lot/plan (looked up online), lat/long and MGA,
   Google Maps and directions links, size and comments. Page numbers on every page. */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, $ = GC.$, esc = GC.esc;
  var W = 595.28, H = 841.89, M = 40;

  // ---------- a small PDF writer: Helvetica text, JPEG images, lines and boxes ----------
  var HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  var BW = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
  var WIN = { 0x2022: 0x95, 0x2026: 0x85, 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x20AC: 0x80, 0x2122: 0x99 };
  /** A JS string as WinAnsi bytes (what the standard PDF fonts understand). */
  function win(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); out.push(c < 128 ? c : WIN[c] || (c >= 0xA0 && c <= 0xFF ? c : 63)); }
    return out;
  }
  function textWidth(s, size, bold) {
    var t = bold ? BW : HW, w = 0, b = win(String(s));
    for (var i = 0; i < b.length; i++) w += b[i] >= 32 && b[i] <= 126 ? t[b[i] - 32] : b[i] === 0xB7 ? 278 : b[i] === 0x95 ? 350 : 556;
    return w * size / 1000;
  }
  function pdfStr(s) { return '(' + win(String(s)).map(function (c) { return c === 40 || c === 41 || c === 92 ? '\\' + String.fromCharCode(c) : c < 32 || c > 126 ? '\\' + ('00' + c.toString(8)).slice(-3) : String.fromCharCode(c); }).join('') + ')'; }
  function rgb(hex) { var n = parseInt(hex.replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255].map(function (v) { return v.toFixed(3); }).join(' '); }
  function wrap(s, size, bold, width) {
    var lines = []; String(s || '').split(/\n/).forEach(function (para) {
      var line = ''; para.split(/\s+/).forEach(function (w) {
        var t = line ? line + ' ' + w : w;
        if (textWidth(t, size, bold) <= width || !line) { line = t; while (textWidth(line, size, bold) > width && line.length > 1) { var cut = line.length - 1; while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > width) cut--; lines.push(line.slice(0, cut)); line = line.slice(cut); } }
        else { lines.push(line); line = w; }
      });
      lines.push(line);
    });
    return lines;
  }
  function Doc() { this.pages = []; this.images = []; }
  Doc.prototype.page = function () { var p = { ops: [], imgs: {}, links: [] }; this.pages.push(p); this.p = p; return p; };
  /** A clickable area: to a web address (uri) or to a page of this PDF ({ page: index, top: y }). */
  Doc.prototype.link = function (x, y, w, h, to, page) { (page || this.p).links.push({ r: [x, H - y - h, x + w, H - y], to: to }); };
  /** Blue underlined link text; returns its width. */
  Doc.prototype.linkText = function (x, y, s, size, to) { var w = textWidth(s, size); this.text(x, y, s, size, false, '#1a5fd0'); this.line(x, y + 1.5, x + w, y + 1.5, '#1a5fd0', 0.5); this.link(x, y - size, w, size + 3, to); return w; };
  Doc.prototype.op = function (s) { this.p.ops.push(s); };
  Doc.prototype.text = function (x, y, s, size, bold, color) { this.op('BT ' + rgb(color || '#202124') + ' rg /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + x.toFixed(2) + ' ' + (H - y).toFixed(2) + ' Td ' + pdfStr(s) + ' Tj ET'); };
  Doc.prototype.rect = function (x, y, w, h, fill, stroke, lw) { this.op('q ' + (fill ? rgb(fill) + ' rg ' : '') + (stroke ? rgb(stroke) + ' RG ' + (lw || 0.5) + ' w ' : '') + x.toFixed(2) + ' ' + (H - y - h).toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re ' + (fill && stroke ? 'B' : fill ? 'f' : 'S') + ' Q'); };
  Doc.prototype.line = function (x1, y1, x2, y2, color, lw) { this.op('q ' + rgb(color || '#dadce0') + ' RG ' + (lw || 0.6) + ' w ' + x1.toFixed(2) + ' ' + (H - y1).toFixed(2) + ' m ' + x2.toFixed(2) + ' ' + (H - y2).toFixed(2) + ' l S Q'); };
  Doc.prototype.circle = function (cx, cy, r, fill) { var k = 0.5523 * r, y = H - cy; this.op('q ' + rgb(fill) + ' rg ' + (cx + r) + ' ' + y + ' m ' + (cx + r) + ' ' + (y + k) + ' ' + (cx + k) + ' ' + (y + r) + ' ' + cx + ' ' + (y + r) + ' c ' + (cx - k) + ' ' + (y + r) + ' ' + (cx - r) + ' ' + (y + k) + ' ' + (cx - r) + ' ' + y + ' c ' + (cx - r) + ' ' + (y - k) + ' ' + (cx - k) + ' ' + (y - r) + ' ' + cx + ' ' + (y - r) + ' c ' + (cx + k) + ' ' + (y - r) + ' ' + (cx + r) + ' ' + (y - k) + ' ' + (cx + r) + ' ' + y + ' c f Q'); };
  /** Adds a JPEG (bytes + pixel size) once; returns its name. */
  Doc.prototype.jpeg = function (bytes, w, h) { var name = 'Im' + (this.images.length + 1); this.images.push({ name: name, bytes: bytes, w: w, h: h }); return name; };
  Doc.prototype.image = function (name, x, y, w, h) { this.p.imgs[name] = 1; this.op('q ' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' + x.toFixed(2) + ' ' + (H - y - h).toFixed(2) + ' cm /' + name + ' Do Q'); };
  /** The finished PDF as a Blob. */
  Doc.prototype.blob = function (title) {
    var chunks = [], len = 0, offs = [];
    var push = function (x) { var u = typeof x === 'string' ? new Uint8Array(win(x)) : x; chunks.push(u); len += u.length; };
    var obj = function (n, body, stream) { offs[n] = len; push(n + ' 0 obj\n' + body + (stream ? '\nstream\n' : '\nendobj\n')); if (stream) { push(stream); push('\nendstream\nendobj\n'); } };
    var self = this, nImg = this.images.length, nPg = this.pages.length;
    // 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 info, images 6.., then per page: page + content
    var imgObj = {}; this.images.forEach(function (im, i) { imgObj[im.name] = 6 + i; });
    var pageObj = function (i) { return 6 + nImg + i * 2; };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'.replace(/[\xE2\xE3\xCF\xD3]/g, '~'));
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Count ' + nPg + ' /Kids [' + this.pages.map(function (p, i) { return pageObj(i) + ' 0 R'; }).join(' ') + '] >>');
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    obj(5, '<< /Title ' + pdfStr(title || 'Photo report') + ' /Producer (GeoCanvas) /CreationDate (D:' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + ') >>');
    this.images.forEach(function (im) { obj(imgObj[im.name], '<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>', im.bytes); });
    this.pages.forEach(function (p, i) {
      var xo = Object.keys(p.imgs).map(function (n) { return '/' + n + ' ' + imgObj[n] + ' 0 R'; }).join(' ');
      var an = (p.links || []).map(function (a) {
        return '<< /Type /Annot /Subtype /Link /Rect [' + a.r.map(function (v) { return v.toFixed(2); }).join(' ') + '] /Border [0 0 0] ' +
          (typeof a.to === 'string' ? '/A << /S /URI /URI ' + pdfStr(a.to) + ' >>' : '/Dest [' + pageObj(a.to.page) + ' 0 R /XYZ 0 ' + (H - (a.to.top || 0)).toFixed(2) + ' null]') + ' >>';
      });
      obj(pageObj(i), '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>' + (xo ? ' /XObject << ' + xo + ' >>' : '') + ' >>' + (an.length ? ' /Annots [' + an.join(' ') + ']' : '') + ' /Contents ' + (pageObj(i) + 1) + ' 0 R >>');
      var c = new Uint8Array(win(p.ops.join('\n')));
      obj(pageObj(i) + 1, '<< /Length ' + c.length + ' >>', c);
    });
    var n = 6 + nImg + nPg * 2, xref = len;
    var x = 'xref\n0 ' + n + '\n0000000000 65535 f \n'; for (var k = 1; k < n; k++) x += ('0000000000' + offs[k]).slice(-10) + ' 00000 n \n';
    push(x + 'trailer\n<< /Size ' + n + ' /Root 1 0 R /Info 5 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(chunks, { type: 'application/pdf' });
  };

  // ---------- pictures ----------
  function bytesOf(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(new Uint8Array(r.result)); }; r.onerror = function () { rej(r.error); }; r.readAsArrayBuffer(blob); }); }
  function canvasJpeg(cv, q) { return new Promise(function (res) { cv.toBlob(function (b) { bytesOf(b).then(res); }, 'image/jpeg', q || 0.85); }); }
  function loadImg(src) { return new Promise(function (res) { var im = new Image(); im.crossOrigin = 'anonymous'; var done = false, t = setTimeout(function () { if (!done) { done = true; res(null); } }, 9000); im.onload = function () { if (!done) { done = true; clearTimeout(t); res(im); } }; im.onerror = function () { if (!done) { done = true; clearTimeout(t); res(null); } }; im.src = src; }); }
  /** An overview map of the actions with numbered pins (background imagery when it can be fetched). */
  var withLayers = true; // the project's visible layers on the report's maps (set per report)
  function overview(items, pxW, pxH, zMax, focus) {
    var crs = L.CRS.EPSG3857, b = null;
    (focus || items).forEach(function (it) { var w = it.x.w, g = GC.camera.shapeOf(w), add = function (lat, lon) { b = b ? b.extend([lat, lon]) : L.latLngBounds([lat, lon], [lat, lon]); }; add(w.lat, w.lon); if (g) (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates).forEach(function (q) { add(q[1], q[0]); }); });
    if (!b) return Promise.resolve(null);
    var pad = 70, z = zMax || 19;
    for (; z > 3; z--) { var a = crs.latLngToPoint(b.getNorthWest(), z), c = crs.latLngToPoint(b.getSouthEast(), z); if (c.x - a.x <= pxW - 2 * pad && c.y - a.y <= pxH - 2 * pad) break; }
    var mid = crs.latLngToPoint(b.getCenter(), z), o = L.point(mid.x - pxW / 2, mid.y - pxH / 2);
    var px = function (lat, lon) { var p = crs.latLngToPoint(L.latLng(lat, lon), z); return [p.x - o.x, p.y - o.y]; };
    var cv = document.createElement('canvas'); cv.width = pxW; cv.height = pxH;
    var ctx = cv.getContext('2d'); ctx.fillStyle = '#e8ebe6'; ctx.fillRect(0, 0, pxW, pxH);
    var key = (GC.project && GC.project.basemap) || 'qld', defs = [GC.BASEMAPS[key], GC.BASEMAPS.esri].filter(function (d, i, a) { return d && a.indexOf(d) === i && d.layers && d.layers[0]; });
    var tiles = function (def) {
      var lay = def.layers[0], tz = Math.min(z, (lay.o && lay.o.maxNativeZoom) || 19), k = Math.pow(2, z - tz), size = 256 * k, jobs = [];
      for (var tx = Math.floor(o.x / size); tx <= Math.floor((o.x + pxW) / size); tx++) for (var ty = Math.floor(o.y / size); ty <= Math.floor((o.y + pxH) / size); ty++) {
        (function (tx, ty) {
          var url = lay.url.replace('{z}', tz).replace('{x}', tx).replace('{y}', ty).replace('{s}', (lay.o && lay.o.subdomains || 'a')[0]).replace('{r}', '');
          jobs.push(loadImg(url).then(function (im) { if (im) ctx.drawImage(im, tx * size - o.x, ty * size - o.y, size, size); return !!im; }));
        })(tx, ty);
      }
      return Promise.all(jobs).then(function (r) { return { ok: r.filter(Boolean).length, n: r.length, label: def.label }; });
    };
    var tryDefs = function (i) { if (i >= defs.length) return Promise.resolve(null); return tiles(defs[i]).then(function (r) { return r.ok >= Math.max(1, r.n * 0.5) ? r : tryDefs(i + 1); }); };
    return tryDefs(0).then(function (bg) {
      var dpr = pxW / (focus ? 560 : 1000); // a location map is printed small: bigger pins and labels
      return (withLayers && GC.mapRender ? GC.mapRender.draw(ctx, { z: z, ox: o.x, oy: o.y, w: pxW, h: pxH, k: dpr }, { skip: function (l) { return l.photoPts; } }) : Promise.resolve(null)).then(function (lr) {
      items.forEach(function (it) {
        var w = it.x.w, col = GC.camera.impOf(w).c;
        if (w.geom) {
          var pts = (w.geom.type === 'Polygon' ? w.geom.coordinates[0] : w.geom.coordinates).map(function (q) { return px(q[1], q[0]); });
          ctx.beginPath(); pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
          if (w.geom.type === 'Polygon') { ctx.closePath(); ctx.fillStyle = col + '40'; ctx.fill(); }
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 6 * dpr; ctx.stroke(); ctx.strokeStyle = col; ctx.lineWidth = 3.5 * dpr; ctx.stroke();
        }
        if (w.sketch) { // a drawn action: its ink as drawn, in a dashed frame
          var fb = GC.camera.sketchBounds(w.sketch);
          if (fb) { var a1 = px(fb.getNorth(), fb.getWest()), a2 = px(fb.getSouth(), fb.getEast()); ctx.save(); ctx.setLineDash([8 * dpr, 6 * dpr]); ctx.strokeStyle = col; ctx.lineWidth = 2.5 * dpr; ctx.strokeRect(a1[0] - 6 * dpr, a1[1] - 6 * dpr, a2[0] - a1[0] + 12 * dpr, a2[1] - a1[1] + 12 * dpr); ctx.restore(); }
          var Wz = 256 * Math.pow(2, z);
          GC.camera.drawInk(ctx, w.sketch, function (m) { return [m[0] * Wz - o.x, m[1] * Wz - o.y]; }, z, 7 * dpr);
        }
      });
      items.slice().sort(function (a, b) { return (focus && focus.indexOf(a) >= 0 ? 1 : 0) - (focus && focus.indexOf(b) >= 0 ? 1 : 0); }).forEach(function (it) {
        var w = it.x.w, p = px(w.lat, w.lon), r = (focus && focus.indexOf(it) < 0 ? 12 : 19) * dpr; // a location map: its action big, the neighbours small
        if (p[0] < -r || p[1] < -r || p[0] > pxW + r || p[1] > pxH + r) return;
        ctx.beginPath(); ctx.arc(p[0], p[1], r + 2.5 * dpr, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fillStyle = GC.camera.impOf(w).c; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.round(r) + 'px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(it.n), p[0], p[1] + dpr);
      });
      // scale bar and north
      var mpp = 40075016.686 * Math.cos(b.getCenter().lat * Math.PI / 180) / (256 * Math.pow(2, z)), target = pxW * 0.18 * mpp, nice = [1, 2, 5].reduce(function (best, m) { var e = Math.pow(10, Math.floor(Math.log10(target))) * m; return e <= target ? e : best; }, 1);
      var bw = nice / mpp, x0 = 24 * dpr, y0 = pxH - 26 * dpr;
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(x0 - 8 * dpr, y0 - 22 * dpr, bw + 16 * dpr, 34 * dpr);
      ctx.fillStyle = '#202124'; ctx.fillRect(x0, y0, bw, 4 * dpr); ctx.font = Math.round(13 * dpr) + 'px Helvetica, Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(nice >= 1000 ? nice / 1000 + ' km' : nice + ' m', x0, y0 - 6 * dpr);
      var nx = pxW - 34 * dpr, ny = 30 * dpr; ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(nx, ny + 6 * dpr, 20 * dpr, 0, 7); ctx.fill();
      ctx.fillStyle = '#202124'; ctx.beginPath(); ctx.moveTo(nx, ny - 8 * dpr); ctx.lineTo(nx + 7 * dpr, ny + 10 * dpr); ctx.lineTo(nx, ny + 6 * dpr); ctx.lineTo(nx - 7 * dpr, ny + 10 * dpr); ctx.closePath(); ctx.fill();
      ctx.font = 'bold ' + Math.round(11 * dpr) + 'px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('N', nx, ny + 22 * dpr);
      return canvasJpeg(cv, 0.86).then(function (bytes) { return { bytes: bytes, w: pxW, h: pxH, bg: bg, layers: lr }; });
      });
    });
  }
  function photo(ref) {
    return GC.photos.blob(ref.id).then(function (b) {
      if (!b) return null;
      return bytesOf(b).then(function (u) {
        if (u[0] !== 0xFF || u[1] !== 0xD8) return null;
        if (ref.w && ref.h) return { bytes: u, w: ref.w, h: ref.h };
        return loadImg(URL.createObjectURL(b)).then(function (im) { return im ? { bytes: u, w: im.naturalWidth, h: im.naturalHeight } : null; });
      });
    }, function () { return null; });
  }

  // ---------- where each action is: nearest street address (online) and its lot ----------
  var ADDR = 'gc.addrCache', lastAsk = 0;
  function addrCache(set) {
    try { if (set) { var k = Object.keys(set); if (k.length > 800) k.slice(0, k.length - 800).forEach(function (x) { delete set[x]; }); localStorage.setItem(ADDR, JSON.stringify(set)); return set; } return JSON.parse(localStorage.getItem(ADDR) || '{}'); } catch (e) { return {}; }
  }
  function getJSON(url) { return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }
  var STATE = { Queensland: 'QLD', 'New South Wales': 'NSW', Victoria: 'VIC', 'South Australia': 'SA', 'Western Australia': 'WA', Tasmania: 'TAS', 'Northern Territory': 'NT', 'Australian Capital Territory': 'ACT' };
  /** OpenStreetMap (Nominatim: at most one request a second), else Esri's world geocoder. → { t, near, src } */
  function nominatim(lat, lon) {
    var wait = Math.max(0, lastAsk + 1100 - Date.now()); lastAsk = Date.now() + wait;
    return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
      return getJSON('https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=en-AU&lat=' + lat.toFixed(6) + '&lon=' + lon.toFixed(6));
    }).then(function (j) {
      var a = j && j.address; if (!a) throw new Error('no address');
      var place = a.suburb || a.town || a.city || a.village || a.hamlet || a.locality || a.municipality || '', st = STATE[a.state] || a.state || '';
      var street = (a.house_number ? a.house_number + ' ' : '') + (a.road || '');
      if (!street.trim()) return { t: (j.display_name || '').split(',').slice(0, 3).join(',').trim(), near: true, src: 'osm' };
      return { t: [street.trim(), [place, st, a.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', '), near: !a.house_number, src: 'osm' };
    });
  }
  function esri(lat, lon) {
    return getJSON('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?f=json&langCode=en&location=' + lon.toFixed(6) + ',' + lat.toFixed(6)).then(function (j) {
      var a = j && j.address; if (!a || !(a.Match_addr || a.LongLabel)) throw new Error('no address');
      return { t: a.Match_addr || a.LongLabel, near: !a.AddNum, src: 'esri' };
    });
  }
  function addressOf(lat, lon) {
    var k = lat.toFixed(5) + ',' + lon.toFixed(5), c = addrCache(); if (c[k]) return Promise.resolve(c[k]);
    if (navigator.onLine === false) return Promise.resolve(null);
    return nominatim(lat, lon).catch(function () { return esri(lat, lon); }).then(function (a) { var cc = addrCache(); cc[k] = a; addrCache(cc); return a; }, function () { return null; });
  }
  /** The QLD cadastre lot the point is in (lot/plan and tenure), or that it is in no lot (usually road reserve). */
  function lotOf(lat, lon) {
    var C = GC.cadastre; if (!C || !C.query || navigator.onLine === false) return Promise.resolve(null);
    return C.query({ geometry: lon.toFixed(7) + ',' + lat.toFixed(7), geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects' }).then(function (g) {
      var f = (g.features || []).filter(function (x) { return x.geometry; })[0];
      if (!f) return { none: true };
      var pr = f.properties || {}; return { lot: C.title(pr), lp: C.lotplan(pr), tenure: C.prop(pr, ['tenure']) || '' };
    }, function () { return null; });
  }
  function mapsUrl(lat, lon) { return 'https://www.google.com/maps/search/?api=1&query=' + lat.toFixed(6) + '%2C' + lon.toFixed(6); }
  function dirUrl(lat, lon) { return 'https://www.google.com/maps/dir/?api=1&destination=' + lat.toFixed(6) + '%2C' + lon.toFixed(6); }
  /** The report header logo (a JPEG on white), or null. */
  function logo() {
    return loadImg('img/report-logo.png').then(function (im) {
      if (!im) return null;
      var k = 3, cv = document.createElement('canvas'); cv.width = im.naturalWidth * k; cv.height = im.naturalHeight * k;
      var x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, cv.width, cv.height);
      return canvasJpeg(cv, 0.92).then(function (b) { return { bytes: b, w: cv.width, h: cv.height }; });
    });
  }

  // ---------- the report ----------
  function fit(iw, ih, bw, bh) { var k = Math.min(bw / iw, bh / ih); return [iw * k, ih * k]; }
  function hasPic(w) { return !!((w.photos && w.photos.length) || w.sketch); } // a drawing is its own picture
  /**
   * Builds the PDF for the listed register rows. opt: { title, by, forWho, perPage (1|2), map, layers, noPhoto, scope,
   * logo, register (front-page table), locMaps (a map of each action), lookup (address and lot), links (Google Maps) }.
   */
  function build(list, opt, progress) {
    withLayers = opt.layers !== false;
    var cam = GC.camera, items = list.filter(function (x) { return opt.noPhoto || hasPic(x.w); }).map(function (x, i) { return { x: x, n: i + 1 }; });
    var doc = new Doc(), when = new Date(), proj = GC.project, team = GC.cloud && GC.cloud.team && GC.cloud.team();
    var dateStr = when.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    var say = function (t) { if (progress) progress(t); };
    var lg = null, where = {}, addrSrc = {};
    var head = function (cover) {
      var x0 = M;
      if (lg && !cover) { var lh = 22, lw = lh * lg.w / lg.h; doc.image(lg.name, M, 14, lw, lh); x0 = M + lw + 10; }
      doc.text(x0, 28, proj.name || 'GeoCanvas', 8.5, true, '#5f6368');
      var r = (opt.title || 'Photo report') + ' · ' + dateStr; doc.text(W - M - textWidth(r, 8.5), 28, r, 8.5, false, '#5f6368');
      doc.line(M, 40, W - M, 40);
    };
    var TOP = 48;
    var pics = {}, missing = 0;
    var need = []; items.forEach(function (it) { (it.x.w.photos || []).slice(0, 5).forEach(function (r) { need.push(r); }); });
    var steps = Promise.resolve();
    if (opt.logo !== false) steps = steps.then(function () { return logo().then(function (l) { if (l) lg = { name: doc.jpeg(l.bytes, l.w, l.h), w: l.w, h: l.h }; }, function () {}); });
    steps = need.reduce(function (ch, r, i) { return ch.then(function () { say('Adding photos ' + (i + 1) + ' of ' + need.length + '…'); return photo(r).then(function (p) { if (p) pics[r.id] = { name: doc.jpeg(p.bytes, p.w, p.h), w: p.w, h: p.h }; else missing++; }); }); }, steps);
    // a drawn action without a photo: a picture of its drawing over the imagery
    steps = items.filter(function (it) { return it.x.w.sketch && !(it.x.w.photos && it.x.w.photos.length); }).reduce(function (ch, it) {
      return ch.then(function () { say('Drawing ' + (it.x.w.name || 'action') + '…'); return overview([it], 1400, 1000, 21).then(function (p) { if (p) pics['sk' + it.n] = { name: doc.jpeg(p.bytes, p.w, p.h), w: p.w, h: p.h }; }, function () {}); });
    }, steps);
    if (opt.locMaps) steps = items.reduce(function (ch, it, i) {
      return ch.then(function () { say('Location maps ' + (i + 1) + ' of ' + items.length + '…'); return overview(items, 900, 600, 19, [it]).then(function (p) { if (p) pics['loc' + it.n] = { name: doc.jpeg(p.bytes, p.w, p.h), w: p.w, h: p.h }; }, function () {}); });
    }, steps);
    if (opt.lookup) steps = items.reduce(function (ch, it, i) {
      return ch.then(function () {
        say('Looking up addresses and lots ' + (i + 1) + ' of ' + items.length + '…');
        var w = it.x.w; return Promise.all([addressOf(w.lat, w.lon), lotOf(w.lat, w.lon)]).then(function (r) { where[it.n] = { addr: r[0], lot: r[1] }; if (r[0]) addrSrc[r[0].src] = 1; });
      });
    }, steps);
    return steps.then(function () {
      say(opt.map ? 'Drawing the overview map…' : 'Laying out…');
      return opt.map && items.length ? overview(items, 1600, 1000).catch(function () { return null; }) : null;
    }).then(function (ov) {
      var addrLine = function (it) { var a = where[it.n] && where[it.n].addr; return a ? (a.near ? 'Near ' : '') + a.t : ''; };
      var lotLine = function (it) { var l = where[it.n] && where[it.n].lot; return !l ? '' : l.none ? 'No lot (road reserve or unparcelled)' : l.lot + (l.tenure ? ' · ' + l.tenure : ''); };
      // ----- cover -----
      doc.page(); head(true);
      var y = 64;
      if (lg) { var ch = 46, cw = ch * lg.w / lg.h; doc.image(lg.name, W - M - cw, 52, cw, ch); }
      doc.text(M, y + 28, opt.title || 'Photo report', 24, true);
      doc.text(M, y + 50, proj.name || '', 12.5, false, '#3c4043');
      var meta = [['Date', dateStr], ['Prepared by', opt.by || '—']].concat(opt.forWho ? [['Prepared for', opt.forWho]] : []).concat(team ? [['Team', team.name]] : []).concat([['Covers', opt.scope || 'All actions']]);
      y += 76; meta.forEach(function (m, i) { doc.text(M, y + i * 15, m[0], 9.5, true, '#5f6368'); doc.text(M + 80, y + i * 15, m[1], 9.5); });
      y += meta.length * 15 + 10;
      var n = items.length, done = items.filter(function (it) { return it.x.w.chk; }).length;
      doc.text(M, y, n + ' action' + (n === 1 ? '' : 's') + ' · ' + done + ' checked · ' + (n - done) + ' to check' + (missing ? ' · ' + missing + ' photo' + (missing === 1 ? '' : 's') + ' not on this device' : ''), 10.5, true);
      var bx = M; y += 16;
      cam.IMP.slice().reverse().forEach(function (m, k) {
        var lvl = 4 - k, c = items.filter(function (it) { return (it.x.w.imp | 0) === lvl; }).length; if (!c) return;
        var t = c + ' ' + m.n; doc.rect(bx, y - 8, 9, 9, m.c); doc.text(bx + 13, y, t, 9.5); bx += 13 + textWidth(t, 9.5) + 16;
      });
      y += 12;
      if (ov) {
        var mw = W - 2 * M, mh = mw * ov.h / ov.w;
        if (opt.register) { mh = Math.min(mh, 250); mw = mh * ov.w / ov.h; }
        var my = y + 6;
        doc.image(doc.jpeg(ov.bytes, ov.w, ov.h), M, my, mw, mh); doc.rect(M, my, mw, mh, null, '#9aa0a6', 0.6);
        y = my + mh + 12;
        doc.text(M, y, 'Numbers match the actions on the following pages; colours show importance.' + (ov.bg ? ' Imagery: ' + ov.bg.label + '.' : ''), 7.5, false, '#5f6368');
        if (ov.layers && (ov.layers.drawn.length || ov.layers.missed.length)) {
          var lt = (ov.layers.drawn.length ? 'Layers: ' + ov.layers.drawn.join(', ') + '.' : '') + (ov.layers.missed.length ? ' Not shown: ' + ov.layers.missed.map(function (m) { return m.name + ' (' + m.why + ')'; }).join('; ') + '.' : '');
          wrap(lt.trim(), 7.5, false, W - 2 * M).slice(0, 3).forEach(function (ln) { y += 9.5; doc.text(M, y, ln, 7.5, false, '#5f6368'); });
        }
        y += 8;
      }
      // ----- the register: one row per action (tap a row to go to its page) -----
      var regRows = [];
      if (opt.register && items.length) {
        var cols = [{ t: '#', w: 22 }, { t: 'Action', w: 118 }, { t: 'Category · importance', w: 92 }, { t: 'Where', w: 203 }, { t: 'Status', w: 80 }];
        var rowH = 26, header = function (yy) {
          doc.rect(M, yy, W - 2 * M, 16, '#eef1ef'); var cx = M + 4;
          cols.forEach(function (c) { doc.text(cx, yy + 11, c.t, 8, true, '#3c4043'); cx += c.w; });
          return yy + 16;
        };
        doc.text(M, y + 12, 'Register', 12, true); y = header(y + 20);
        items.forEach(function (it) {
          var w = it.x.w, imp = cam.impOf(w), c = cam.catOf(it.x.l, w), cx = M + 4, wh = [];
          var al = addrLine(it), ll = lotLine(it), ww = cols[3].w - 30;
          if (al) wrap(al, 8.5, false, ww).slice(0, 2).forEach(function (t) { wh.push([t, 8.5, '#202124']); });
          if (ll) wrap(ll, 7.5, false, ww).slice(0, 2).forEach(function (t) { wh.push([t, 7.5, '#5f6368']); });
          if (!wh.length) wh = [[w.lat.toFixed(5) + ', ' + w.lon.toFixed(5), 8.5, '#202124']];
          rowH = Math.max(26, 8 + wh.length * 10);
          if (y + rowH > H - 40) { doc.page(); head(); doc.text(M, TOP + 14, 'Register (continued)', 11, true); y = header(TOP + 22); }
          doc.circle(cx + 7, y + 10, 7, imp.c); var ns = String(it.n); doc.text(cx + 7 - textWidth(ns, 7.5, true) / 2, y + 12.6, ns, 7.5, true, '#ffffff'); cx += cols[0].w;
          doc.text(cx, y + 11, wrap(w.name || 'Action', 9, true, cols[1].w - 6)[0], 9, true); doc.text(cx, y + 21, Geo.fmt([w.lon, w.lat], 'mga').replace(/\s+/g, ' '), 7, false, '#5f6368'); cx += cols[1].w;
          doc.text(cx, y + 11, wrap(c ? c.name : 'General', 8.5, false, cols[2].w - 6)[0], 8.5); doc.text(cx, y + 21, imp.n, 8, false, imp.c); cx += cols[2].w;
          wh.forEach(function (t, k) { doc.text(cx, y + 11 + k * 10, t[0], t[1], false, t[2]); });
          if (opt.links) doc.linkText(cx + cols[3].w - 26, y + 11, 'Map', 8, mapsUrl(w.lat, w.lon));
          cx += cols[3].w;
          doc.text(cx, y + 11, w.chk ? 'Checked' : 'To do', 8.5, true, w.chk ? '#137333' : '#b06000'); if (w.chk) doc.text(cx, y + 21, w.chk.by, 7, false, '#5f6368');
          regRows.push({ page: doc.p, y: y, h: rowH, it: it });
          doc.line(M, y + rowH, W - M, y + rowH, '#e3e6e3', 0.5);
          y += rowH;
        });
        if (addrSrc.osm || addrSrc.esri) doc.text(M, Math.min(y + 12, H - 32), 'Addresses are the nearest found online (' + [addrSrc.osm ? '© OpenStreetMap contributors' : '', addrSrc.esri ? 'Esri' : ''].filter(Boolean).join(', ') + '); lots from the QLD cadastre (a guide only). Tap a row to go to its page.', 7, false, '#5f6368');
      }
      // ----- the actions -----
      var per = opt.perPage === 1 ? 1 : 2, slotH = (H - TOP - 46) / per, pageOf = {};
      items.forEach(function (it, i) {
        if (i % per === 0) { doc.page(); head(); }
        var w = it.x.w, top = TOP + (i % per) * slotH + 4, imp = cam.impOf(w), kd = cam.kindOf(w), c = cam.catOf(it.x.l, w);
        pageOf[it.n] = { page: doc.pages.length - 1, top: top - 4 };
        // number + name
        doc.circle(M + 11, top + 9, 11, imp.c); var ns = String(it.n); doc.text(M + 11 - textWidth(ns, 10, true) / 2, top + 12.5, ns, 10, true, '#ffffff');
        doc.text(M + 30, top + 14, w.name || 'Action', 15, true);
        doc.text(M + 30 + textWidth(w.name || 'Action', 15, true) + 8, top + 14, kd.k + (kd.size ? ' · ' + kd.size : ''), 9.5, false, '#5f6368');
        // photo and location map side by side (or the photo alone)
        var py = top + 26, refs = w.photos || [], big = (refs[0] && pics[refs[0].id]) || (!refs.length && pics['sk' + it.n]), loc = pics['loc' + it.n];
        var full = W - 2 * M, both = !!loc, bw = both ? (full - 10) / 2 : full, bh = per === 1 ? (both ? 220 : 330) : (both ? 150 : 170);
        var ph = 0;
        if (big) { var d = fit(big.w, big.h, bw, bh); doc.image(big.name, M, py, d[0], d[1]); ph = d[1]; }
        else if (refs.length || per !== 1 || both) { doc.rect(M, py, bw, Math.min(bh, 110), '#f1f3f4', '#dadce0'); doc.text(M + 12, py + 58, refs.length ? 'Photo not on this device yet' : 'No photo', 9.5, false, '#5f6368'); ph = Math.min(bh, 110); }
        if (loc) {
          var dl = fit(loc.w, loc.h, bw, bh), lx = M + bw + 10;
          doc.image(loc.name, lx, py, dl[0], dl[1]); doc.rect(lx, py, dl[0], dl[1], null, '#9aa0a6', 0.6);
          if (opt.links) doc.link(lx, py, dl[0], dl[1], mapsUrl(w.lat, w.lon));
          ph = Math.max(ph, dl[1]);
        }
        var ty = py + ph + 6;
        var thumbs = refs.slice(1, 7).filter(function (r) { return pics[r.id]; });
        thumbs.forEach(function (r, k) { var p = pics[r.id], d = fit(p.w, p.h, 54, 40); doc.image(p.name, M + k * 60, ty, d[0], d[1]); });
        if (thumbs.length) { if (refs.length > 7) doc.text(M + 6 * 60 + 4, ty + 24, '+' + (refs.length - 7) + ' more', 9, false, '#5f6368'); ty += 46; }
        // details: two columns
        var wh = where[it.n] || {}, rows = [['Category', c ? c.name : 'General'], ['Importance', imp.n], [refs.length ? 'Taken' : 'Created', GC.fmtTime(cam.taken(w))],
          ['Checked', w.chk ? 'Yes — ' + w.chk.by + ', ' + GC.fmtTime(w.chk.t) : 'Not yet']];
        var rows2 = [];
        if (opt.lookup) rows2.push(['Address', addrLine(it) || 'Not found'], ['Lot', lotLine(it) || 'Not found']);
        rows2.push(['Location', w.lat.toFixed(6) + ', ' + w.lon.toFixed(6)], ['MGA2020', Geo.fmt([w.lon, w.lat], 'mga').replace(/\s+/g, ' ')]);
        if (w.acc != null) rows.push(['GPS accuracy', '±' + Math.round(w.acc) + ' m']);
        if (kd.size) rows.push([kd.k === 'Area' || kd.k === 'Drawing' ? kd.k : 'Length', kd.size]);
        var colW = (full - 14) / 2, drawRows = function (rs, x, yy) {
          rs.forEach(function (r) {
            doc.text(x, yy + 10, r[0], 8.5, true, '#5f6368');
            if (r[0] === 'Importance') { doc.rect(x + 66, yy + 2, 9, 9, imp.c); doc.text(x + 79, yy + 10, r[1], 9.5); }
            else if (r[0] === 'Checked') doc.text(x + 66, yy + 10, wrap(r[1], 9.5, false, colW - 66)[0], 9.5, !!w.chk, w.chk ? '#137333' : '#b06000');
            else { var ls = wrap(r[1], 9, false, colW - 66); doc.text(x + 66, yy + 10, ls[0], 9); if (ls[1] && (r[0] === 'Address' || r[0] === 'Lot')) { doc.text(x + 66, yy + 21, ls[1], 9); yy += 10; } }
            yy += 14;
          });
          return yy;
        };
        var dy = Math.max(drawRows(rows, M, ty), drawRows(rows2, M + colW + 14, ty));
        if (opt.links) { var lx2 = M; doc.text(lx2, dy + 10, 'Open:', 8.5, true, '#5f6368'); lx2 += 32; lx2 += doc.linkText(lx2, dy + 10, 'Google Maps', 9, mapsUrl(w.lat, w.lon)) + 14; doc.linkText(lx2, dy + 10, 'Directions', 9, dirUrl(w.lat, w.lon)); dy += 16; }
        if (w.note) {
          doc.text(M, dy + 12, 'Comments', 8.5, true, '#5f6368'); dy += 14;
          var room = Math.max(1, Math.floor((top + slotH - 14 - dy) / 12)), ls = wrap(w.note, 9.5, false, full);
          ls.slice(0, room).forEach(function (l, k) { doc.text(M, dy + 10 + k * 12, k === room - 1 && ls.length > room ? l.slice(0, Math.max(0, l.length - 2)) + '…' : l, 9.5); });
        }
        if (per === 2 && i % 2 === 0 && i + 1 < items.length) doc.line(M, top + slotH - 6, W - M, top + slotH - 6, '#dadce0', 0.8);
      });
      regRows.forEach(function (r) { doc.link(M, r.y, W - 2 * M - (opt.links ? 120 : 0), r.h, pageOf[r.it.n], r.page); }); // register row → its page
      // page numbers
      var total = doc.pages.length;
      doc.pages.forEach(function (p, i) { doc.p = p; var s2 = 'Page ' + (i + 1) + ' of ' + total; doc.text(W - M - textWidth(s2, 8), H - 22, s2, 8, false, '#5f6368'); doc.text(M, H - 22, 'GeoCanvas', 8, false, '#9aa0a6'); });
      return { blob: doc.blob(opt.title), pages: total, items: items.length, missing: missing, map: !!ov, mapBg: ov && ov.bg, where: where };
    });
  }

  /** The report dialog (from the register). list: the register rows to report; scope: which actions, in words. */
  var OPTS = 'gc.reportOpts';
  function open(list, scope) {
    var s = GC.settings || {}, me = (s.cloud && s.cloud.device) || s.lastName || '', last = {};
    try { last = JSON.parse(localStorage.getItem(OPTS) || '{}'); } catch (e) { /* defaults */ }
    var on = function (k, d) { return (last[k] == null ? d : last[k]) ? ' checked' : ''; };
    var withPh = list.filter(function (x) { return x.w.photos && x.w.photos.length; }).length, withInk = list.filter(function (x) { return x.w.sketch && !(x.w.photos && x.w.photos.length); }).length;
    GC.modal('<h2>PDF photo report</h2><p class="sub">' + list.length + ' action' + (list.length === 1 ? '' : 's') + ' (' + esc(scope || 'All actions') + '), ' + withPh + ' with photos' + (withInk ? ', ' + withInk + ' drawing' + (withInk === 1 ? '' : 's') : '') + '.</p>' +
      '<label class="field">Title<input type="text" id="pr-title" value="' + esc(last.title || 'Photo report') + '"></label>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap"><label class="field" style="flex:1;min-width:160px">Prepared by<input type="text" id="pr-by" value="' + esc(me) + '" placeholder="Your name"></label>' +
      '<label class="field" style="flex:1;min-width:160px">Prepared for<input type="text" id="pr-for" value="' + esc(last.forWho || '') + '" placeholder="e.g. the arborist (optional)"></label></div>' +
      '<div class="cam-lbl">Layout</div><div class="seg small" id="pr-per"><button data-p="2" class="on">2 per page</button><button data-p="1">1 per page, large photo</button></div>' +
      '<div class="cam-lbl">Front page</div>' +
      '<label class="opt"><input type="checkbox" id="pr-logo"' + on('logo', true) + '> Logo in the header (CPB | nacap · CNJV T2W – Stage 1)</label>' +
      '<label class="opt"><input type="checkbox" id="pr-map" checked> Overview map (numbered pins)</label>' +
      '<label class="opt"><input type="checkbox" id="pr-reg"' + on('register', true) + '> Register: a table of every action (tap a row to go to its page)</label>' +
      '<div class="cam-lbl">Each action</div>' +
      '<label class="opt"><input type="checkbox" id="pr-loc"' + on('locMaps', true) + '> Location map beside the photo (with the map’s layers)</label>' +
      '<label class="opt"><input type="checkbox" id="pr-look"' + on('lookup', true) + '> Nearest street address and lot/plan (looked up online)</label>' +
      '<label class="opt"><input type="checkbox" id="pr-links"' + on('links', true) + '> Clickable Google Maps and directions links</label>' +
      '<label class="opt"><input type="checkbox" id="pr-layers" checked> Show the map’s visible layers on the maps (drawings, CAD, GIS, plans, online maps)</label>' +
      '<label class="opt"><input type="checkbox" id="pr-nophoto" checked> Include actions without a photo or drawing</label>' +
      '<div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="go">Create PDF</button></div>',
    function (el, close) {
      var per = 2, q = function (x) { return el.querySelector(x); };
      q('#pr-per').onclick = function (e) { var b = e.target.closest('[data-p]'); if (!b) return; per = +b.getAttribute('data-p'); [].forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); }); };
      q('[data-a=no]').onclick = close;
      q('[data-a=go]').onclick = function () {
        var opt = { title: q('#pr-title').value.trim() || 'Photo report', by: q('#pr-by').value.trim(), forWho: q('#pr-for').value.trim(), perPage: per, map: q('#pr-map').checked, noPhoto: q('#pr-nophoto').checked, layers: q('#pr-layers').checked, scope: scope,
          logo: q('#pr-logo').checked, register: q('#pr-reg').checked, locMaps: q('#pr-loc').checked, lookup: q('#pr-look').checked, links: q('#pr-links').checked };
        try { localStorage.setItem(OPTS, JSON.stringify({ title: opt.title, forWho: opt.forWho, logo: opt.logo, register: opt.register, locMaps: opt.locMaps, lookup: opt.lookup, links: opt.links })); } catch (e) { /* private mode */ }
        close(); GC.busy('Creating the report…');
        build(list, opt, function (t) { GC.busy(t); }).then(function (r) {
          GC.busy(null);
          if (!r.items) { GC.toast('Nothing to report: none of these actions has a photo (tick “Include actions without a photo”).', 'warn', 7000); return; }
          GC.lastReport = r; // for tests
          GC.saveBlob(r.blob, (GC.project.name || 'GeoCanvas').replace(/[^\w\- ]+/g, '').trim() + ' ' + opt.title.replace(/[^\w\- ]+/g, '').trim() + ' ' + new Date().toISOString().slice(0, 10) + '.pdf');
          var noAddr = opt.lookup && Object.keys(r.where).some(function (k) { return !r.where[k].addr; });
          GC.toast('Report ready: ' + r.items + ' action' + (r.items === 1 ? '' : 's') + ', ' + r.pages + ' page' + (r.pages === 1 ? '' : 's') + '.' + (r.missing ? ' ' + r.missing + ' photo' + (r.missing === 1 ? ' is' : 's are') + ' not on this device yet.' : '') + (opt.map && !r.mapBg ? ' (The map has no background imagery: it could not be fetched.)' : '') + (noAddr ? ' Some addresses could not be looked up (they need internet).' : ''), r.missing || noAddr ? 'warn' : null, 8000);
        }, function (e) { GC.busy(null); GC.toast('Could not create the report: ' + e.message, 'err'); });
      };
    }, function () { setTimeout(function () { if (GC.register && !document.querySelector('#modal .rg')) GC.register.open(); }, 0); });
  }

  GC.report = { open: open, build: build, _pdf: { Doc: Doc, wrap: wrap, textWidth: textWidth } };
})(window);

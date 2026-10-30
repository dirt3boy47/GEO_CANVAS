/* GeoCanvas web — PDF photo report from the actions register.
   A4 portrait, written directly as PDF (real text, the original JPEGs): a cover with the summary and an overview map
   with numbered pins, then the actions, two per page (or one large) with their photo, extra photos, category,
   importance, taken, checked by/when, location (lat/long and MGA), size and note. Page numbers on every page. */
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
  Doc.prototype.page = function () { var p = { ops: [], imgs: {} }; this.pages.push(p); this.p = p; return p; };
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
      obj(pageObj(i), '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>' + (xo ? ' /XObject << ' + xo + ' >>' : '') + ' >> /Contents ' + (pageObj(i) + 1) + ' 0 R >>');
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
  function overview(items, pxW, pxH, zMax) {
    var crs = L.CRS.EPSG3857, b = null;
    items.forEach(function (it) { var w = it.x.w, g = GC.camera.shapeOf(w), add = function (lat, lon) { b = b ? b.extend([lat, lon]) : L.latLngBounds([lat, lon], [lat, lon]); }; add(w.lat, w.lon); if (g) (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates).forEach(function (q) { add(q[1], q[0]); }); });
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
      var dpr = pxW / 1000;
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
      items.forEach(function (it) {
        var w = it.x.w, p = px(w.lat, w.lon), r = 19 * dpr;
        ctx.beginPath(); ctx.arc(p[0], p[1], r + 2.5 * dpr, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fillStyle = GC.camera.impOf(w).c; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.round(19 * dpr) + 'px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(it.n), p[0], p[1] + dpr);
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
      return canvasJpeg(cv, 0.86).then(function (bytes) { return { bytes: bytes, w: pxW, h: pxH, bg: bg }; });
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

  // ---------- the report ----------
  function hasPic(w) { return !!((w.photos && w.photos.length) || w.sketch); } // a drawing is its own picture
  function fit(iw, ih, bw, bh) { var k = Math.min(bw / iw, bh / ih); return [iw * k, ih * k]; }
  /** Builds the PDF for the listed register rows. opt: { title, by, perPage (1|2), map, noPhoto, scope } */
  function build(list, opt, progress) {
    var cam = GC.camera, items = list.filter(function (x) { return opt.noPhoto || hasPic(x.w); }).map(function (x, i) { return { x: x, n: i + 1 }; });
    var doc = new Doc(), when = new Date(), proj = GC.project, team = GC.cloud && GC.cloud.team && GC.cloud.team();
    var dateStr = when.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    var head = function () {
      doc.text(M, 28, proj.name || 'GeoCanvas', 8.5, true, '#5f6368');
      var r = (opt.title || 'Photo report') + ' · ' + dateStr; doc.text(W - M - textWidth(r, 8.5), 28, r, 8.5, false, '#5f6368');
      doc.line(M, 34, W - M, 34);
    };
    var pics = {}, missing = 0;
    var need = []; items.forEach(function (it) { (it.x.w.photos || []).slice(0, opt.perPage === 1 ? 5 : 5).forEach(function (r) { need.push(r); }); });
    var loadPics = need.reduce(function (ch, r, i) { return ch.then(function () { if (progress) progress('Adding photos ' + (i + 1) + ' of ' + need.length + '…'); return photo(r).then(function (p) { if (p) pics[r.id] = { name: doc.jpeg(p.bytes, p.w, p.h), w: p.w, h: p.h }; else missing++; }); }); }, Promise.resolve());
    // a drawn action without a photo: a picture of its drawing over the imagery
    var loadInk = function () {
      return items.filter(function (it) { return it.x.w.sketch && !(it.x.w.photos && it.x.w.photos.length); }).reduce(function (ch, it) {
        return ch.then(function () {
          if (progress) progress('Drawing ' + (it.x.w.name || 'action') + '…');
          return overview([it], 1400, 1000, 21).then(function (p) { if (p) pics['sk' + it.n] = { name: doc.jpeg(p.bytes, p.w, p.h), w: p.w, h: p.h }; }, function () {});
        });
      }, Promise.resolve());
    };
    return loadPics.then(loadInk).then(function () {
      if (progress) progress(opt.map ? 'Drawing the overview map…' : 'Laying out…');
      return opt.map && items.length ? overview(items, 1600, 1000).catch(function () { return null; }) : null;
    }).then(function (ov) {
      // ----- cover -----
      doc.page(); head();
      doc.text(M, 92, opt.title || 'Photo report', 26, true);
      doc.text(M, 116, proj.name || '', 13, false, '#3c4043');
      var meta = [['Date', dateStr], ['Prepared by', opt.by || '—']].concat(team ? [['Team', team.name]] : []).concat([['Covers', opt.scope || 'All actions']]);
      meta.forEach(function (m, i) { doc.text(M, 146 + i * 16, m[0], 9.5, true, '#5f6368'); doc.text(M + 80, 146 + i * 16, m[1], 9.5); });
      var y = 146 + meta.length * 16 + 14, n = items.length, done = items.filter(function (it) { return it.x.w.chk; }).length;
      doc.text(M, y, n + ' action' + (n === 1 ? '' : 's') + ' · ' + done + ' checked · ' + (n - done) + ' to check' + (missing ? ' · ' + missing + ' photo' + (missing === 1 ? '' : 's') + ' not on this device' : ''), 10.5, true);
      var bx = M; y += 16;
      cam.IMP.slice().reverse().forEach(function (m, k) {
        var lvl = 4 - k, c = items.filter(function (it) { return (it.x.w.imp | 0) === lvl; }).length; if (!c) return;
        var t = c + ' ' + m.n; doc.rect(bx, y - 8, 9, 9, m.c); doc.text(bx + 13, y, t, 9.5); bx += 13 + textWidth(t, 9.5) + 16;
      });
      if (ov) {
        var mw = W - 2 * M, mh = mw * ov.h / ov.w, my = y + 20;
        doc.image(doc.jpeg(ov.bytes, ov.w, ov.h), M, my, mw, mh); doc.rect(M, my, mw, mh, null, '#9aa0a6', 0.6);
        doc.text(M, my + mh + 12, 'Numbers match the actions on the following pages; colours show importance.' + (ov.bg ? ' Imagery: ' + ov.bg.label + '.' : ''), 7.5, false, '#5f6368');
      }
      // ----- the actions -----
      var per = opt.perPage === 1 ? 1 : 2, slotH = (H - 44 - 50) / per;
      items.forEach(function (it, i) {
        if (i % per === 0) { doc.page(); head(); }
        var w = it.x.w, top = 44 + (i % per) * slotH + 10, imp = cam.impOf(w), kd = cam.kindOf(w), c = cam.catOf(it.x.l, w);
        // number + name
        doc.circle(M + 11, top + 9, 11, imp.c); var ns = String(it.n); doc.text(M + 11 - textWidth(ns, 10, true) / 2, top + 12.5, ns, 10, true, '#ffffff');
        doc.text(M + 30, top + 14, w.name || 'Action', 15, true);
        doc.text(M + 30 + textWidth(w.name || 'Action', 15, true) + 8, top + 14, kd.k + (kd.size ? ' · ' + kd.size : ''), 9.5, false, '#5f6368');
        var py = top + 28, refs = w.photos || [], big = (refs[0] && pics[refs[0].id]) || (!refs.length && pics['sk' + it.n]);
        var boxW = per === 1 ? W - 2 * M : 262, boxH = per === 1 ? 380 : slotH - 70;
        if (per === 1 && !big) boxH = 0;
        if (big) { var d = fit(big.w, big.h, boxW, boxH); doc.image(big.name, M, py, d[0], d[1]); if (per !== 1) boxH = d[1]; else boxH = d[1]; }
        else if (refs.length) { doc.rect(M, py, boxW, 120, '#f1f3f4', '#dadce0'); doc.text(M + 12, py + 64, 'Photo not on this device yet', 9.5, false, '#5f6368'); boxH = 120; }
        else if (per !== 1) { doc.rect(M, py, boxW, 120, '#f1f3f4', '#dadce0'); doc.text(M + 12, py + 64, 'No photo', 9.5, false, '#5f6368'); boxH = 120; }
        var ty = py + boxH + 6;
        refs.slice(1, 5).forEach(function (r, k) { var p = pics[r.id]; if (!p) return; var d = fit(p.w, p.h, 60, 45); doc.image(p.name, M + k * 66, ty, d[0], d[1]); });
        if (refs.length > 5) doc.text(M + 4 * 66 + 4, ty + 26, '+' + (refs.length - 5) + ' more', 9, false, '#5f6368');
        // details
        var dx = per === 1 ? M : M + boxW + 16, dw = per === 1 ? W - 2 * M : W - M - dx, dy = per === 1 ? ty + (refs.length > 1 ? 56 : 8) : py + 4;
        var rows = [['Category', c ? c.name : 'General'], ['Importance', imp.n], [refs.length ? 'Taken' : 'Created', GC.fmtTime(cam.taken(w))],
          ['Checked', w.chk ? 'Yes — ' + w.chk.by + ', ' + GC.fmtTime(w.chk.t) : 'Not yet'],
          ['Location', w.lat.toFixed(6) + ', ' + w.lon.toFixed(6)], ['MGA2020', Geo.fmt([w.lon, w.lat], 'mga').replace(/\s+/g, ' ')]];
        if (w.acc != null) rows.push(['GPS accuracy', '±' + Math.round(w.acc) + ' m']);
        if (kd.size) rows.push([kd.k === 'Area' || kd.k === 'Drawing' ? kd.k : 'Length', kd.size]);
        rows.forEach(function (r) {
          doc.text(dx, dy + 10, r[0], 8.5, true, '#5f6368');
          if (r[0] === 'Importance') { doc.rect(dx + 74, dy + 2, 9, 9, imp.c); doc.text(dx + 87, dy + 10, r[1], 9.5); }
          else if (r[0] === 'Checked') { doc.text(dx + 74, dy + 10, wrap(r[1], 9.5, false, dw - 74)[0], 9.5, !!w.chk, w.chk ? '#137333' : '#b06000'); }
          else doc.text(dx + 74, dy + 10, wrap(r[1], 9.5, false, dw - 74)[0], 9.5);
          dy += 15;
        });
        if (w.note) {
          doc.text(dx, dy + 12, 'Note', 8.5, true, '#5f6368'); dy += 14;
          var room = Math.max(1, Math.floor((top + slotH - 20 - dy) / 12.5)), ls = wrap(w.note, 9.5, false, dw);
          ls.slice(0, room).forEach(function (l, k) { doc.text(dx, dy + 10 + k * 12.5, k === room - 1 && ls.length > room ? l.slice(0, Math.max(0, l.length - 2)) + '…' : l, 9.5); });
        }
        if (per === 2 && i % 2 === 0 && i + 1 < items.length) doc.line(M, top + slotH - 6, W - M, top + slotH - 6, '#dadce0', 0.8);
      });
      // page numbers
      var total = doc.pages.length;
      doc.pages.forEach(function (p, i) { doc.p = p; var s = 'Page ' + (i + 1) + ' of ' + total; doc.text(W - M - textWidth(s, 8), H - 22, s, 8, false, '#5f6368'); doc.text(M, H - 22, 'GeoCanvas', 8, false, '#9aa0a6'); });
      return { blob: doc.blob(opt.title), pages: total, items: items.length, missing: missing, map: !!ov, mapBg: ov && ov.bg };
    });
  }

  /** The report dialog (from the register). list: the register rows to report; scope: which actions, in words. */
  function open(list, scope) {
    var s = GC.settings || {}, me = (s.cloud && s.cloud.device) || s.lastName || '';
    var withPh = list.filter(function (x) { return x.w.photos && x.w.photos.length; }).length, withInk = list.filter(function (x) { return x.w.sketch && !(x.w.photos && x.w.photos.length); }).length;
    GC.modal('<h2>PDF photo report</h2><p class="sub">' + list.length + ' action' + (list.length === 1 ? '' : 's') + ' (' + esc(scope || 'All actions') + '), ' + withPh + ' with photos' + (withInk ? ', ' + withInk + ' drawing' + (withInk === 1 ? '' : 's') : '') + '.</p>' +
      '<label class="field">Title<input type="text" id="pr-title" value="Photo report"></label>' +
      '<label class="field">Prepared by<input type="text" id="pr-by" value="' + esc(me) + '" placeholder="Your name"></label>' +
      '<div class="cam-lbl">Layout</div><div class="seg small" id="pr-per"><button data-p="2" class="on">2 per page</button><button data-p="1">1 per page, large photo</button></div>' +
      '<label class="opt"><input type="checkbox" id="pr-map" checked> Overview map on the first page (numbered pins)</label>' +
      '<label class="opt"><input type="checkbox" id="pr-nophoto" checked> Include actions without a photo or drawing</label>' +
      '<div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="go">Create PDF</button></div>',
    function (el, close) {
      var per = 2;
      el.querySelector('#pr-per').onclick = function (e) { var b = e.target.closest('[data-p]'); if (!b) return; per = +b.getAttribute('data-p'); [].forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); }); };
      el.querySelector('[data-a=no]').onclick = close;
      el.querySelector('[data-a=go]').onclick = function () {
        var opt = { title: el.querySelector('#pr-title').value.trim() || 'Photo report', by: el.querySelector('#pr-by').value.trim(), perPage: per, map: el.querySelector('#pr-map').checked, noPhoto: el.querySelector('#pr-nophoto').checked, scope: scope };
        close(); GC.busy('Creating the report…');
        build(list, opt, function (t) { GC.busy(t); }).then(function (r) {
          GC.busy(null);
          if (!r.items) { GC.toast('Nothing to report: none of these actions has a photo (tick “Include actions without a photo”).', 'warn', 7000); return; }
          GC.lastReport = r; // for tests
          GC.saveBlob(r.blob, (GC.project.name || 'GeoCanvas').replace(/[^\w\- ]+/g, '').trim() + ' ' + opt.title.replace(/[^\w\- ]+/g, '').trim() + ' ' + new Date().toISOString().slice(0, 10) + '.pdf');
          GC.toast('Report ready: ' + r.items + ' action' + (r.items === 1 ? '' : 's') + ', ' + r.pages + ' page' + (r.pages === 1 ? '' : 's') + '.' + (r.missing ? ' ' + r.missing + ' photo' + (r.missing === 1 ? ' is' : 's are') + ' not on this device yet.' : '') + (opt.map && !r.mapBg ? ' (The map has no background imagery: it could not be fetched.)' : ''), r.missing ? 'warn' : null, 8000);
        }, function (e) { GC.busy(null); GC.toast('Could not create the report: ' + e.message, 'err'); });
      };
    }, function () { setTimeout(function () { if (GC.register && !document.querySelector('#modal .rg')) GC.register.open(); }, 0); });
  }

  GC.report = { open: open, build: build, _pdf: { Doc: Doc, wrap: wrap, textWidth: textWidth } };
})(window);

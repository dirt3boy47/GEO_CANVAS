/* GeoCanvas web — photos on points (drawn markers, GPS waypoints, imported placemarks).
   A photo is resized on the iPad (longest side 2048 px, JPEG) and stored in IndexedDB under the
   pseudo-layer "_photos" (key "projectId:_photos:<id>.jpg"). Points keep only small references:
   photos: [{ id, t (time taken), w, h, lat?, lon? }]. Cloud sync, backups and KMZ export carry the images. */
(function (global) {
  'use strict';
  var GC = global.GC, Store = global.Store, Ink = global.Ink, $ = GC.$, esc = GC.esc;
  var MAX = 2048, QUALITY = 0.85, urls = {};

  function file(id) { return id + '.jpg'; }
  function readBuf(f) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(new Error('Could not read ' + f.name)); }; r.readAsArrayBuffer(f); }); }

  /** Date taken and GPS position from a JPEG's EXIF block (when the photo still has them). */
  function exif(buf) {
    var out = {}, dv = new DataView(buf);
    try {
      if (dv.getUint16(0) !== 0xFFD8) return out;
      var o = 2;
      while (o + 4 < dv.byteLength) {
        var mk = dv.getUint16(o), len = dv.getUint16(o + 2);
        if (mk === 0xFFE1 && dv.getUint32(o + 4) === 0x45786966) { // "Exif"
          var t = o + 10, le = dv.getUint16(t) === 0x4949, u16 = function (p) { return dv.getUint16(t + p, le); }, u32 = function (p) { return dv.getUint32(t + p, le); };
          var ifd = function (p) { var n = u16(p), tags = {}; for (var i = 0; i < n; i++) { var e = p + 2 + i * 12; tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), off: e + 8 }; } return tags; };
          var rat = function (tag, i) { var p = u32(tag.off) + i * 8; return u32(p) / (u32(p + 4) || 1); };
          var str = function (tag) { var p = tag.count > 4 ? u32(tag.off) : tag.off, s = ''; for (var i = 0; i < tag.count - 1; i++) s += String.fromCharCode(dv.getUint8(t + p + i)); return s; };
          var ascii = function (tag) { return String.fromCharCode(dv.getUint8(t + tag.off)); };
          var d0 = ifd(u32(4));
          if (d0[0x8769]) { var ex = ifd(u32(d0[0x8769].off)), dt = ex[0x9003] || ex[0x9004]; if (dt) { var m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(str(dt)); if (m) out.t = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); } }
          if (d0[0x8825]) {
            var g = ifd(u32(d0[0x8825].off));
            if (g[2] && g[4]) {
              var lat = rat(g[2], 0) + rat(g[2], 1) / 60 + rat(g[2], 2) / 3600, lon = rat(g[4], 0) + rat(g[4], 1) / 60 + rat(g[4], 2) / 3600;
              if (g[1] && ascii(g[1]) === 'S') lat = -lat;
              if (g[3] && ascii(g[3]) === 'W') lon = -lon;
              if (isFinite(lat) && isFinite(lon) && (lat || lon)) { out.lat = lat; out.lon = lon; }
            }
          }
          return out;
        }
        if ((mk & 0xFF00) !== 0xFF00 || mk === 0xFFDA) break;
        o += 2 + len;
      }
    } catch (e) { /* no usable EXIF */ }
    return out;
  }

  /** Resizes and stores picked image files. Resolves photo references. */
  function ingest(files) {
    var pid = GC.project.id;
    return files.reduce(function (chain, f) {
      return chain.then(function (refs) {
        return readBuf(f).then(function (buf) {
          var meta = exif(buf), url = URL.createObjectURL(new Blob([buf], { type: f.type || 'image/jpeg' }));
          return new Promise(function (res, rej) {
            var img = new Image();
            img.onload = function () {
              var k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
              var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
              cv.getContext('2d').drawImage(img, 0, 0, w, h);
              URL.revokeObjectURL(url);
              cv.toBlob(function (b) { if (b) res({ blob: b, w: w, h: h }); else rej(new Error('Could not compress ' + f.name)); }, 'image/jpeg', QUALITY);
            };
            img.onerror = function () { URL.revokeObjectURL(url); rej(new Error(f.name + ' is not an image this browser can open.')); };
            img.src = url;
          }).then(function (r) {
            return readBuf(r.blob).then(function (data) {
              var ref = { id: Ink.uid(), t: meta.t || f.lastModified || Date.now(), w: r.w, h: r.h };
              if (meta.lat != null) { ref.lat = Math.round(meta.lat * 1e7) / 1e7; ref.lon = Math.round(meta.lon * 1e7) / 1e7; }
              return Store.putFile(pid, '_photos', file(ref.id), data).then(function () { return refs.concat([ref]); });
            });
          });
        });
      });
    }, Promise.resolve([]));
  }

  /** Opens the iPad's picker (Take Photo / Photo Library / Files). Must run inside a tap handler. */
  function pick() {
    return new Promise(function (res) {
      var inp = document.createElement('input'), done = false;
      inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true; inp.style.display = 'none';
      inp.onchange = function () {
        done = true; var fs = Array.prototype.slice.call(inp.files || []); document.body.removeChild(inp);
        if (!fs.length) { res([]); return; }
        GC.busy(fs.length > 1 ? 'Adding ' + fs.length + ' photos…' : 'Adding photo…');
        ingest(fs).then(function (refs) { GC.busy(null); res(refs); }, function (e) { GC.busy(null); GC.toast(e.message, 'err'); res([]); });
      };
      document.body.appendChild(inp); inp.click();
      // Cancelling the picker fires no event; the promise simply stays pending (nothing to clean up).
    });
  }

  function blob(id) {
    return Store.getFile(GC.project.id, '_photos', file(id)).then(function (d) { return d ? new Blob([d], { type: 'image/jpeg' }) : null; });
  }
  function url(id) {
    if (urls[id]) return Promise.resolve(urls[id]);
    return blob(id).then(function (b) { if (!b) return null; urls[id] = URL.createObjectURL(b); return urls[id]; });
  }

  /** Thumbnail strip. opts: { onAdd, onChange(refs) } — onChange makes photos removable in the viewer. */
  function strip(box, refs, opts) {
    opts = opts || {};
    refs = refs || [];
    box.classList.add('ph-strip');
    box.innerHTML = refs.map(function (r, i) { return '<button class="ph-th" data-i="' + i + '" aria-label="Photo ' + (i + 1) + '"><span class="ph-load"></span></button>'; }).join('') +
      (opts.onAdd ? '<button class="ph-add" data-add="1"><svg><use xlink:href="#i-camera"/></svg><span>' + (refs.length ? 'Add' : 'Add photo') + '</span></button>' : '');
    refs.forEach(function (r, i) {
      url(r.id).then(function (u) {
        var b = box.querySelector('[data-i="' + i + '"]'); if (!b) return;
        b.innerHTML = u ? '<img src="' + u + '" alt="">' : '<span class="ph-miss" title="Not on this device yet">⌛</span>';
      });
    });
    box.onclick = function (e) {
      var t = e.target.closest('[data-i]'), a = e.target.closest('[data-add]');
      if (a && opts.onAdd) { opts.onAdd(); return; }
      if (t) view(refs, +t.getAttribute('data-i'), opts.onChange ? function (left) { opts.onChange(left); } : null);
    };
  }

  /** Full-screen viewer with swipe/arrows, Share (save to Photos or Files) and Remove. */
  function view(refs, start, onChange) {
    var i = start, box = $('photo-view');
    var show = function () {
      var r = refs[i];
      $('pv-img').removeAttribute('src');
      url(r.id).then(function (u) { if (refs[i] === r) { if (u) $('pv-img').src = u; else $('pv-img').alt = 'This photo has not reached this device yet.'; } });
      $('pv-cap').textContent = (refs.length > 1 ? (i + 1) + ' of ' + refs.length + ' · ' : '') + GC.fmtTime(r.t) + (r.lat != null ? ' · ' + r.lat.toFixed(5) + ', ' + r.lon.toFixed(5) : '');
      $('pv-prev').hidden = $('pv-next').hidden = refs.length < 2;
      $('pv-del').hidden = !onChange;
    };
    var go = function (d) { i = (i + d + refs.length) % refs.length; show(); };
    var close = function () { box.hidden = true; document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); };
    $('pv-prev').onclick = function () { go(-1); }; $('pv-next').onclick = function () { go(1); };
    $('pv-close').onclick = close;
    $('pv-share').onclick = function () { var r = refs[i]; blob(r.id).then(function (b) { if (b) GC.saveBlob(b, 'GeoCanvas_' + new Date(r.t).toISOString().slice(0, 10) + '_' + r.id + '.jpg'); }); };
    $('pv-del').onclick = function () {
      GC.confirm('Remove this photo?', 'It is removed from this point. Undo is available for drawn markers.', 'Remove', true).then(function (ok) {
        if (!ok) return;
        refs = refs.slice(0, i).concat(refs.slice(i + 1));
        onChange(refs);
        if (!refs.length) { close(); return; }
        i = Math.min(i, refs.length - 1); show();
      });
    };
    var x0 = null;
    box.ontouchstart = function (e) { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; };
    box.ontouchend = function (e) { if (x0 == null) return; var dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50 && refs.length > 1) go(dx < 0 ? 1 : -1); x0 = null; };
    document.addEventListener('keydown', key);
    box.hidden = false; show();
  }

  /** Every photo id referenced in a project (markers, waypoints, imported features). */
  function refsIn(layers) {
    var ids = {};
    var add = function (list) { (list || []).forEach(function (r) { if (r && r.id) ids[r.id] = r; }); };
    layers.forEach(function (l) {
      if (l.kind === 'drawing') (l.items || []).forEach(function (el) { add(el.photos); });
      else if (l.kind === 'waypoints') (l.waypoints || []).forEach(function (w) { add(w.photos); });
      else if (l.kind === 'vector' && l.featPhotos) Object.keys(l.featPhotos).forEach(function (k) { add(l.featPhotos[k]); });
    });
    return ids;
  }

  GC.photos = { pick: pick, ingest: ingest, strip: strip, view: view, url: url, blob: blob, file: file, refsIn: refsIn, exif: exif };
})(window);

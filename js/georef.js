/* GeoCanvas web — georeference plans (PDF, PNG, JPG) in the browser, like QGIS's Georeferencer.
   The plan shows on one half of the screen, the map on the other. Each control point is a tap on the plan
   followed by a tap on the same spot on the map (snapping to cadastre corners when lot boundaries are on).
   2 points: position, scale and rotation (Helmert). 3+: least-squares fit with an error per point; optionally
   affine (stretch/skew) for scanned or distorted plans. Fitting is done in Web Mercator metres; at site scale
   (a few km) that is conformal to well under a millimetre per metre. The result is a raster layer placed by its
   three corners (GC.AffineImage), with the white paper optionally blended away. */
(function (global) {
  'use strict';
  var GC = global.GC, map = GC.map, $ = GC.$, esc = GC.esc, Ink = global.Ink;
  var MAX = 4096; // longest side kept (iPad Safari limits canvas size)
  var S = null; // editor state

  // ---------- loading plans ----------
  function loadPdfJs() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'vendor/pdfjs/pdf.min.js';
      s.onload = function () { global.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js'; res(global.pdfjsLib); };
      s.onerror = function () { rej(new Error('The PDF reader could not load. Open GeoCanvas online once so it is saved for offline use.')); };
      document.head.appendChild(s);
    });
  }
  function canvasToPlan(cv) { return { url: cv.toDataURL('image/jpeg', 0.9), w: cv.width, h: cv.height }; }
  function fromPdf(file) {
    return Promise.all([loadPdfJs(), file.arrayBuffer ? file.arrayBuffer() : new Response(file).arrayBuffer()]).then(function (r) {
      return r[0].getDocument({ data: new Uint8Array(r[1]) }).promise;
    }).then(function (doc) {
      var pick = doc.numPages > 1 ? GC.prompt('“' + file.name + '” has ' + doc.numPages + ' pages. Which page is the plan?', '1', 'Page number', 'Open') : Promise.resolve('1');
      return pick.then(function (n) {
        if (!n) return null;
        var no = Math.max(1, Math.min(doc.numPages, parseInt(n, 10) || 1));
        GC.busy('Reading page ' + no + '…');
        return doc.getPage(no).then(function (page) {
          var v1 = page.getViewport({ scale: 1 }), k = Math.min(MAX / Math.max(v1.width, v1.height), 8), vp = page.getViewport({ scale: k });
          var cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
          var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
          return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () { return canvasToPlan(cv); });
        });
      });
    });
  }
  function fromImage(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight)), cv = document.createElement('canvas');
        cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
        var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url); res(canvasToPlan(cv));
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error(file.name + ' could not be opened as an image.')); };
      img.src = url;
    });
  }
  /** Import entry point for a plan file. */
  function start(file) {
    GC.busy('Opening ' + file.name + '…');
    (/\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? fromPdf(file) : fromImage(file)).then(function (plan) {
      GC.busy(null);
      if (plan) open({ name: file.name.replace(/\.[^.]+$/, ''), url: plan.url, w: plan.w, h: plan.h, pairs: [] });
    }, function (e) { GC.busy(null); GC.toast('Could not open the plan: ' + e.message, 'err', 9000); });
  }

  // ---------- fitting ----------
  function proj(ll) { return L.CRS.EPSG3857.project(L.latLng(ll)); }
  function unproj(x, y) { return L.CRS.EPSG3857.unproject(L.point(x, y)); }
  /** Least-squares fit of plan pixels (u right, v down) to Web Mercator metres. */
  function fit(pairs, affine) {
    var n = pairs.length; if (n < 2) return null;
    var P = pairs.map(function (q) { var m = proj(q.ll); return { u: q.u, v: -q.v, x: m.x, y: m.y }; }); // v up, like the map
    var f;
    if (affine && n >= 3) {
      // x = a0 + a1 u + a2 v ; y = b0 + b1 u + b2 v (normal equations)
      var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
      P.forEach(function (p) { var r = [1, p.u, p.v]; for (var i = 0; i < 3; i++) { bx[i] += r[i] * p.x; by[i] += r[i] * p.y; for (var j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; } });
      var ax = solve3(A, bx), ay = solve3(A, by);
      if (!ax || !ay) return null;
      f = function (u, v) { v = -v; return [ax[0] + ax[1] * u + ax[2] * v, ay[0] + ay[1] * u + ay[2] * v]; };
    } else {
      // similarity: x = a u − b v + tx ; y = b u + a v + ty
      var mu = 0, mv = 0, mx = 0, my = 0;
      P.forEach(function (p) { mu += p.u / n; mv += p.v / n; mx += p.x / n; my += p.y / n; });
      var sn = 0, sa = 0, sb = 0;
      P.forEach(function (p) { var du = p.u - mu, dv = p.v - mv, dx = p.x - mx, dy = p.y - my; sn += du * du + dv * dv; sa += du * dx + dv * dy; sb += du * dy - dv * dx; });
      if (!sn) return null;
      var a = sa / sn, b = sb / sn, tx = mx - a * mu + b * mv, ty = my - b * mu - a * mv;
      f = function (u, v) { v = -v; return [a * u - b * v + tx, b * u + a * v + ty]; };
    }
    var lat0 = pairs[0].ll.lat, k = Math.cos(lat0 * Math.PI / 180); // mercator metres → ground metres
    var res = pairs.map(function (q) { var m = proj(q.ll), g = f(q.u, q.v); return Math.hypot(g[0] - m.x, g[1] - m.y) * k; });
    var rms = Math.sqrt(res.reduce(function (s, r) { return s + r * r; }, 0) / n);
    var o = f(0, 0), ex = f(1, 0), ey = f(0, 1);
    return {
      f: f, residuals: res, rms: n > (affine && n >= 3 ? 3 : 2) ? rms : null,
      metresPerPixel: Math.sqrt(Math.abs((ex[0] - o[0]) * (ey[1] - o[1]) - (ex[1] - o[1]) * (ey[0] - o[0]))) * k,
      rotation: (Math.atan2(ex[1] - o[1], ex[0] - o[0]) * 180 / Math.PI + 360) % 360
    };
  }
  function solve3(A, b) {
    var M = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var c = 0; c < 3; c++) {
      var piv = c; for (var r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      var t = M[c]; M[c] = M[piv]; M[piv] = t;
      for (r = 0; r < 3; r++) if (r !== c) { var k = M[r][c] / M[c][c]; for (var j = c; j < 4; j++) M[r][j] -= k * M[c][j]; }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  }
  function cornersOf(t, w, h) { return [[0, 0], [w, 0], [0, h]].map(function (c) { var g = t.f(c[0], c[1]), ll = unproj(g[0], g[1]); return [ll.lat, ll.lng]; }); }
  function boundsOf(t, w, h) {
    var lls = [[0, 0], [w, 0], [0, h], [w, h]].map(function (c) { var g = t.f(c[0], c[1]); return unproj(g[0], g[1]); });
    var b = L.latLngBounds(lls); return [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]];
  }

  // ---------- editor ----------
  var planMap = null;
  function numIcon(n, cls) { return L.divIcon({ className: 'gr-pt ' + (cls || ''), iconSize: [26, 26], iconAnchor: [13, 13], html: '<span>' + n + '</span>' }); }
  function open(st) {
    if (GC.mode === 'draw') GC.setMode('nav');
    if (GC.measure && GC.measure.isOn()) GC.measure.close();
    if (GC.closeInspector) GC.closeInspector();
    $('gps-panel').hidden = true;
    S = st; S.pending = null; S.affine = !!st.affine; S.blend = st.blend !== false; S.opacity = st.opacity || 0.7;
    S.mapMarkers = []; S.planMarkers = []; S.preview = null;
    if (S.layer && GC.views[S.layer.id]) GC.views[S.layer.id].pane.style.display = 'none'; // the preview stands in for it
    document.body.classList.add('georef');
    $('georef').hidden = false; $('gr-title').textContent = 'Place “' + S.name + '”';
    $('gr-affine').checked = S.affine; $('gr-blend').checked = S.blend; $('gr-op').value = Math.round(S.opacity * 100); $('gr-opv').textContent = Math.round(S.opacity * 100) + '%';
    if (!planMap) {
      planMap = L.map('gr-planmap', { crs: L.CRS.Simple, minZoom: -6, maxZoom: 5, zoomSnap: 0.25, attributionControl: false, zoomControl: false, boxZoom: false });
      planMap.on('click', function (e) { if (S) planTap(e.latlng); });
    }
    if (S.overlay) planMap.removeLayer(S.overlay);
    var b = [[-S.h, 0], [0, S.w]];
    S.overlay = L.imageOverlay(S.url, b).addTo(planMap);
    // Keep what was on screen in the half of the map that stays visible.
    var sz = map.getSize(), portrait = sz.y > sz.x;
    S.shift = portrait ? L.point(0, -Math.round(sz.y * 0.27)) : L.point(-Math.round(sz.x * 0.25), 0);
    map.panBy(S.shift, { animate: false });
    setTimeout(function () { planMap.invalidateSize(); planMap.fitBounds(b, { padding: [10, 10] }); map.invalidateSize(); }, 60);
    S.pairs.forEach(function (q, i) { addMarkers(q, i); });
    refresh();
  }
  function addMarkers(q, i) {
    var pm = L.marker([-q.v, q.u], { draggable: true, icon: numIcon(i + 1, 'done') }).addTo(planMap);
    pm.on('dragend', function () { var ll = pm.getLatLng(); q.u = ll.lng; q.v = -ll.lat; refresh(); });
    var mm = L.marker(q.ll, { draggable: true, icon: numIcon(i + 1, 'done'), zIndexOffset: 2000 }).addTo(map);
    mm.on('dragend', function () { var ll = mm.getLatLng(), s = GC.cadastre && GC.cadastre.snap(ll); if (s) mm.setLatLng(s); q.ll = s || ll; refresh(); });
    S.planMarkers[i] = pm; S.mapMarkers[i] = mm;
  }
  function clearMarkers() {
    S.planMarkers.forEach(function (m) { if (m) planMap.removeLayer(m); }); S.mapMarkers.forEach(function (m) { if (m) map.removeLayer(m); });
    S.planMarkers = []; S.mapMarkers = [];
    if (S.pending && S.pending.marker) planMap.removeLayer(S.pending.marker);
  }
  function planTap(ll) {
    if (S.pending && S.pending.marker) planMap.removeLayer(S.pending.marker);
    var n = S.pairs.length + 1;
    S.pending = { u: ll.lng, v: -ll.lat, marker: L.marker(ll, { icon: numIcon(n, 'wait') }).addTo(planMap) };
    refresh();
  }
  /** Map taps while georeferencing (called from the map's click handler). */
  function click(e) {
    if (!S) return false;
    if (!S.pending) { GC.toast('First tap a point on the plan (a lot corner, kerb, fence corner…), then the same spot here on the map.'); return true; }
    var s = GC.cadastre && GC.cadastre.snap(e.latlng), q = { u: S.pending.u, v: S.pending.v, ll: s || e.latlng };
    planMap.removeLayer(S.pending.marker); S.pending = null;
    S.pairs.push(q); addMarkers(q, S.pairs.length - 1);
    if (s) GC.toast('Snapped to the lot corner.');
    refresh();
    return true;
  }
  function refresh() {
    var t = fit(S.pairs, S.affine), n = S.pairs.length;
    $('gr-step').innerHTML = S.pending ? '<b>Point ' + (n + 1) + ':</b> now tap the same spot on the map' + (GC.cadastre && GC.cadastre.on() ? ' (snaps to lot corners).' : '.') :
      n < 2 ? '<b>Point ' + (n + 1) + ' of 2:</b> tap a clear point on the plan: a lot corner, kerb or fence corner. Use points far apart.' :
      n === 2 ? 'The plan is placed. Add a 3rd point (or more) to check the fit; drag numbers to fine-tune.' : 'Fit checked on ' + n + ' points. Drag a number to adjust, or add more points.';
    $('gr-pairs').innerHTML = S.pairs.map(function (q, i) {
      var r = t && t.rms != null ? t.residuals[i] : null;
      return '<div class="gr-row"><span class="gr-n">' + (i + 1) + '</span><span class="grow">' + (r == null ? '—' : 'off by ' + (r < 1 ? (r * 100).toFixed(0) + ' cm' : r.toFixed(2) + ' m')) + '</span><button class="ib" data-del="' + i + '" title="Remove point ' + (i + 1) + '">✕</button></div>';
    }).join('') + (t ? '<p class="hint" style="margin:6px 2px 0">' + (t.rms != null ? 'Overall error (RMS) <b>' + (t.rms < 1 ? (t.rms * 100).toFixed(0) + ' cm' : t.rms.toFixed(2) + ' m') + '</b> · ' : '') +
      'rotation ' + t.rotation.toFixed(1) + '° · ' + (t.metresPerPixel * 1000).toFixed(0) + ' mm per plan pixel</p>' : '');
    Array.prototype.forEach.call($('gr-pairs').querySelectorAll('[data-del]'), function (b) { b.onclick = function () { var i = +b.getAttribute('data-del'); clearMarkers(); S.pairs.splice(i, 1); S.pending = null; S.pairs.forEach(addMarkers); refresh(); }; });
    $('gr-save').disabled = !t; $('gr-undo').disabled = !S.pairs.length && !S.pending;
    planMap.invalidateSize(); // the panel below the plan may have grown
    // live preview on the map
    if (t) {
      var c = cornersOf(t, S.w, S.h);
      if (!S.preview) { if (!map.getPane('grPreview')) { var pn = map.createPane('grPreview'); pn.style.zIndex = 590; pn.style.pointerEvents = 'none'; } S.preview = new GC.AffineImage(S.url, c, { pane: 'grPreview' }).addTo(map); }
      else S.preview.setCorners(c);
      var pane = map.getPane('grPreview'); pane.style.opacity = S.opacity; pane.style.mixBlendMode = S.blend ? 'multiply' : '';
      S.fit = t; S.corners = c;
    } else if (S.preview) { map.removeLayer(S.preview); S.preview = null; S.fit = null; }
  }
  function close() {
    if (!S) return;
    clearMarkers(); if (S.preview) map.removeLayer(S.preview);
    if (S.overlay) planMap.removeLayer(S.overlay);
    if (S.shift) map.panBy(S.shift.multiplyBy(-1), { animate: false });
    S = null; $('georef').hidden = true; document.body.classList.remove('georef');
    if (GC.project) GC.applyLayerState();
    setTimeout(function () { map.invalidateSize(); }, 60);
  }
  function save() {
    var t = fit(S.pairs, S.affine); if (!t) return;
    var gcps = S.pairs.map(function (q) { return { u: Math.round(q.u * 100) / 100, v: Math.round(q.v * 100) / 100, lat: q.ll.lat, lng: q.ll.lng }; });
    var data = { corners: cornersOf(t, S.w, S.h), bounds: boundsOf(t, S.w, S.h), gcps: gcps, transform: S.affine && S.pairs.length >= 3 ? 'affine' : 'helmert', blend: S.blend, size: [S.w, S.h], rms: t.rms };
    var l = S.layer;
    if (l) { Object.keys(data).forEach(function (k) { l[k] = data[k]; }); l.opacity = S.opacity; }
    else {
      l = Object.assign({ id: Ink.uid(), name: S.name, kind: 'raster', visible: true, opacity: S.opacity, locked: true, dataURL: S.url, crs: 3857, format: 'Plan', warnings: [], created: Date.now() }, data);
      GC.insertLayer(l);
    }
    var name = l.name;
    close();
    GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id); GC.refreshLayers();
    GC.toast('“' + name + '” placed' + (t.rms != null ? ' (overall error ' + (t.rms < 1 ? (t.rms * 100).toFixed(0) + ' cm' : t.rms.toFixed(2) + ' m') + ')' : '') + '. Find it in Layers; ⋯ › Adjust georeferencing to fine-tune.');
  }
  /** Re-opens a saved plan with its control points. */
  function edit(l) {
    var img = new Image();
    img.onload = function () {
      open({ layer: l, name: l.name, url: l.dataURL, w: img.naturalWidth, h: img.naturalHeight, affine: l.transform === 'affine', blend: !!l.blend, opacity: l.opacity,
        pairs: (l.gcps || []).map(function (g) { return { u: g.u, v: g.v, ll: L.latLng(g.lat, g.lng) }; }) });
    };
    img.src = l.dataURL;
  }

  $('gr-planmap').addEventListener('contextmenu', function (e) { e.preventDefault(); });
  $('gr-undo').onclick = function () {
    if (S.pending) { planMap.removeLayer(S.pending.marker); S.pending = null; refresh(); return; }
    clearMarkers(); S.pairs.pop(); S.pairs.forEach(addMarkers); refresh();
  };
  $('gr-cancel').onclick = function () { if (!S.pairs.length || S.layer) { close(); return; } GC.confirm('Stop placing this plan?', 'The control points you added are discarded.', 'Discard', true).then(function (ok) { if (ok) close(); }); };
  $('gr-save').onclick = save;
  $('gr-affine').onchange = function () { S.affine = $('gr-affine').checked; refresh(); };
  $('gr-blend').onchange = function () { S.blend = $('gr-blend').checked; refresh(); };
  $('gr-op').oninput = function () { S.opacity = $('gr-op').value / 100; $('gr-opv').textContent = $('gr-op').value + '%'; refresh(); };

  GC.georef = { start: start, edit: edit, click: click, isOn: function () { return !!S; }, fit: fit, planMap: function () { return planMap; }, isPlan: function (name) { return /\.(pdf|png|jpe?g|gif|webp|heic|heif|bmp)$/i.test(name); } };
})(window);

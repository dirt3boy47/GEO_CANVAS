/* GeoCanvas web — Photo register: every photo point as one table.
   Columns: ✓ checked (who and when), photo, name, category, importance, when the photo was taken, note.
   Edit category, importance and the tick in place; sort by any column; filter by text, category, importance and
   checked / to check; export the table as CSV for Excel. The records are the photo points themselves, so they sync
   with the team, show on the map and export with the project like everything else. */
(function (global) {
  'use strict';
  var GC = global.GC, map = GC.map, $ = GC.$, esc = GC.esc;
  var st = { q: '', cat: '', min: 0, chk: 'all', sort: 'taken', dir: -1, sel: {} };
  function rowKey(x) { return x.l.id + ':' + (x.w.time != null ? x.w.time : x.w.name); }

  /** Every photo point in the project: [{l, w}]. */
  function rows() {
    var out = [];
    if (!GC.project || !GC.camera) return out;
    GC.project.layers.forEach(function (l) {
      if (l.kind !== 'waypoints') return;
      (l.waypoints || []).forEach(function (w) { out.push({ l: l, w: w }); }); // every waypoint is an action: photos, pins, drawn areas and lines
    });
    return out;
  }
  function short(t) { var d = new Date(t); return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' }) + ', ' + d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }); }
  function catName(x) { var c = GC.camera.catOf(x.l, x.w); return c ? c.name : ''; }
  function filtered(noFilter) {
    var q = st.q.toLowerCase().trim(), cam = GC.camera;
    var list = rows().filter(function (x) {
      if (noFilter === true) return true;
      var w = x.w;
      if (st.cat && (w.cat || 'gen') !== st.cat) return false;
      if ((w.imp | 0) < st.min) return false;
      if (st.chk === 'todo' && w.chk) return false;
      if (st.chk === 'done' && !w.chk) return false;
      if (q && (w.name + ' ' + cam.kindOf(w).k + ' ' + (w.note || '') + ' ' + catName(x) + ' ' + cam.impOf(w).n + ' ' + (w.chk ? w.chk.by : '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = {
      taken: function (x) { return cam.taken(x.w); }, imp: function (x) { return x.w.imp | 0; }, name: function (x) { return (x.w.name || '').toLowerCase(); },
      cat: function (x) { return catName(x).toLowerCase(); }, chk: function (x) { return x.w.chk ? x.w.chk.t : 0; }
    }[st.sort];
    list.sort(function (a, b) { var ka = key(a), kb = key(b); return (ka < kb ? -1 : ka > kb ? 1 : 0) * st.dir || (cam.taken(b.w) - cam.taken(a.w)); });
    return list;
  }
  function catOptions(sel, withAll) {
    var seen = {}, opts = withAll ? '<option value="">All categories</option>' : '';
    // the categories of every photo layer (normally just "Photo points")
    GC.project.layers.forEach(function (l) { if (l.kind === 'waypoints' && l.photoPts) GC.camera.cats(l).forEach(function (c) { if (!seen[c.id]) { seen[c.id] = 1; opts += '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>'; } }); });
    if (!Object.keys(seen).length) GC.camera.CATS.forEach(function (c) { opts += '<option value="' + c.id + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>'; });
    return opts;
  }

  function open() {
    if (!GC.project || !GC.camera) return;
    if (GC.ui) GC.ui.close();
    var cam = GC.camera, IMP = cam.IMP, list = [];
    var H = [['', '<button class="rg-sel" id="rg-all" aria-pressed="false" title="Select all shown" aria-label="Select all shown"><i></i></button>'], ['', 'Photo'], ['name', 'Action'], ['cat', 'Category'], ['imp', 'Importance'], ['taken', 'Taken'], ['chk', 'Checked'], ['', 'Note'], ['', '']];
    GC.modal('<div class="rg"><div class="rg-top"><h2>Actions register <small id="rg-count"></small></h2>' +
      '<div class="rg-tools"><input type="search" id="rg-q" placeholder="Search name, note, who checked…" value="' + esc(st.q) + '">' +
      '<div class="rg-strip"><select id="rg-cat">' + catOptions(st.cat, true) + '</select>' +
      '<select id="rg-min">' + IMP.map(function (m, i) { return '<option value="' + i + '"' + (i === st.min ? ' selected' : '') + '>' + (i === 0 ? 'All importance' : i === 4 ? 'Critical only' : m.n + ' and above') + '</option>'; }).join('') + '</select>' +
      '<div class="seg small" id="rg-chk"><button data-c="all">All</button><button data-c="todo">To check</button><button data-c="done">Checked</button></div></div>' +
      '<div class="rg-strip"><button class="btn primary" id="rg-new">+ New action</button><button class="btn" id="rg-pdf">PDF report</button><button class="btn" id="rg-photos">Export photos</button><button class="btn" id="rg-csv">Export CSV</button></div></div></div>' +
      '<div class="rg-table" role="table"><div class="rg-row rg-head" role="row">' + H.map(function (h) { return '<span role="columnheader"' + (h[0] ? ' data-s="' + h[0] + '"' : '') + '>' + h[1] + '</span>'; }).join('') + '</div><div id="rg-body"></div></div>' +
      // the selection shows here, in the footer that is always there, so selecting never moves the list under your finger
      '<div class="actions rg-foot"><span class="hint" id="rg-hint">Tick the first column to choose actions for a report or export; tick Checked once an action has been checked.</span>' +
      '<span class="rg-selbar" id="rg-selbar" hidden><b id="rg-seln"></b> <span class="rg-selwhat">selected for PDF report and exports</span> <button class="link" id="rg-selclear">Clear</button></span><span class="spacer"></span><button class="btn primary" data-a="done">Done</button></div></div>',
    function (el, close) {
      $('modal').classList.add('wide', 'reg');
      var q = function (s) { return el.querySelector(s); }, bodyEl = q('#rg-body');
      var paintCount = function () {
        var all = rows(), todo = all.filter(function (x) { return !x.w.chk; }).length;
        q('#rg-count').textContent = (list.length === all.length ? all.length + ' actions' : list.length + ' of ' + all.length + ' actions') + ' · ' + todo + ' to check';
      };
      var rowHtml = function (x, i) {
        var w = x.w, imp = cam.impOf(w), ro = x.l.locked, ph = w.photos && w.photos[0], kd = cam.kindOf(w);
        return '<div class="rg-row' + (w.chk ? ' done' : '') + (st.sel[rowKey(x)] ? ' picked' : '') + '" role="row" data-i="' + i + '" style="--ic:' + imp.c + '">' +
          // buttons, not hidden checkboxes: tapping a checkbox focuses it and iPhone Safari then scrolls the whole dialog to it
          '<button class="rg-sel" data-k="sel" aria-pressed="' + !!st.sel[rowKey(x)] + '" title="Select for a report or export" aria-label="Select ' + esc(w.name || 'action') + '"><i></i></button>' +
          '<button class="rg-ph" data-k="view" aria-label="Open the photo">' + (ph ? '<img data-ph="' + esc(ph.id) + '" alt="">' : '<span class="rg-glyph">' + cam.pinSvg(imp.c, cam.catOf(x.l, w)) + '</span>') + (w.photos && w.photos.length > 1 ? '<em>' + w.photos.length + '</em>' : '') + '</button>' +
          '<span class="rg-name"><b>' + esc(w.name || 'Action') + '</b><small><span class="rg-kind">' + esc(kd.k) + '</span>' + esc((kd.size ? kd.size + ' · ' : '') + x.l.name) + '</small></span>' +
          '<select data-k="cat"' + (ro ? ' disabled' : '') + '>' + cam.cats(x.l).map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === (w.cat || 'gen') ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select>' +
          '<select data-k="imp" class="rg-imp"' + (ro ? ' disabled' : '') + '>' + IMP.map(function (m, k) { return '<option value="' + k + '"' + (k === (w.imp | 0) ? ' selected' : '') + '>' + m.n + '</option>'; }).join('') + '</select>' +
          '<span class="rg-taken" title="When the photo was taken">' + esc(short(cam.taken(w))) + '</span>' +
          '<span class="rg-chkcell"><button class="rg-tick" data-k="chk" aria-pressed="' + !!w.chk + '"' + (ro ? ' disabled' : '') + ' title="Checked" aria-label="Checked"><i></i></button>' +
          '<span class="rg-who">' + whoHtml(w) + '</span></span>' +
          '<span class="rg-note">' + esc(w.note || '') + '</span>' +
          '<button class="btn rg-go" data-k="show">Map</button></div>';
      };
      var whoHtml = function (w) { return w.chk ? esc(w.chk.by) + '<small>' + esc(short(w.chk.t)) + '</small>' : '<small>Not checked</small>'; };
      var paintSel = function () {
        var n = Object.keys(st.sel).length, shownSel = list.filter(function (x) { return st.sel[rowKey(x)]; }).length;
        q('#rg-selbar').hidden = !n; q('#rg-hint').hidden = !!n; q('#rg-seln').textContent = n + ' selected' + (shownSel < n ? ' (' + (n - shownSel) + ' hidden by filters)' : '');
        q('#rg-all').setAttribute('aria-pressed', list.length > 0 && shownSel === list.length ? 'true' : shownSel > 0 ? 'mixed' : 'false');
      };
      /** What exports work on: the selected actions (in register order), else everything shown. */
      var target = function () { var n = Object.keys(st.sel).length; if (!n) return list.slice(); var f = filtered.call(null, true); return f.filter(function (x) { return st.sel[rowKey(x)]; }); };
      var paint = function () {
        var keep = {}; rows().forEach(function (x) { if (st.sel[rowKey(x)]) keep[rowKey(x)] = 1; }); st.sel = keep; // forget deleted actions
        list = filtered();
        bodyEl.innerHTML = list.length ? list.map(rowHtml).join('') : '<p class="rg-empty">' + (rows().length ? 'No photos match.' : 'No photos yet. Tap Camera to take the first one.') + '</p>';
        [].forEach.call(bodyEl.querySelectorAll('img[data-ph]'), function (im) { GC.photos.url(im.getAttribute('data-ph')).then(function (u) { if (u) im.src = u; }); });
        [].forEach.call(q('.rg-head').querySelectorAll('[data-s]'), function (h) { h.classList.toggle('on', h.getAttribute('data-s') === st.sort); h.setAttribute('data-dir', st.dir > 0 ? '▲' : '▼'); });
        [].forEach.call(q('#rg-chk').children, function (b) { b.classList.toggle('on', b.getAttribute('data-c') === st.chk); });
        paintCount(); paintSel();
      };
      bodyEl.addEventListener('change', function (e) {
        var r = e.target.closest('.rg-row'); if (!r) return;
        var x = list[+r.getAttribute('data-i')], k = e.target.getAttribute('data-k'), w = x.w;
        if (k === 'cat') w.cat = e.target.value;
        if (k === 'imp') { w.imp = +e.target.value; r.style.setProperty('--ic', cam.impOf(w).c); }
        GC.renderLayer(x.l); GC.markDirty(x.l.id); GC.refreshLayers(true);
      });
      bodyEl.addEventListener('click', function (e) {
        var t = e.target.closest('[data-k=sel],[data-k=chk]');
        if (t) {
          var rr = t.closest('.rg-row'), xx = list[+rr.getAttribute('data-i')], on = t.getAttribute('aria-pressed') !== 'true';
          t.setAttribute('aria-pressed', String(on));
          if (t.getAttribute('data-k') === 'sel') { if (on) st.sel[rowKey(xx)] = 1; else delete st.sel[rowKey(xx)]; rr.classList.toggle('picked', on); paintSel(); }
          else { cam.setChecked(xx.l, xx.w, on); rr.classList.toggle('done', !!xx.w.chk); rr.querySelector('.rg-who').innerHTML = whoHtml(xx.w); paintCount(); }
          return;
        }
        var b = e.target.closest('[data-k=view],[data-k=show]'); if (!b) return;
        var x = list[+b.closest('.rg-row').getAttribute('data-i')];
        if (b.getAttribute('data-k') === 'view' && x.w.photos && x.w.photos.length) { GC.photos.view(x.w.photos, 0, null, { name: x.w.name, lat: x.w.lat, lon: x.w.lon, note: x.w.note }); return; }
        close(); if (x.w.geom) map.fitBounds(GC.card.boundsOf(x.w.geom), { padding: [80, 80], maxZoom: 19, animate: false }); else map.setView([x.w.lat, x.w.lon], Math.max(map.getZoom(), 18), { animate: false }); GC.inspectWaypoint(x.l, x.w);
      });
      q('.rg-head').addEventListener('click', function (e) {
        var h = e.target.closest('[data-s]'); if (!h) return;
        var s = h.getAttribute('data-s');
        if (st.sort === s) st.dir = -st.dir; else { st.sort = s; st.dir = s === 'name' || s === 'cat' ? 1 : -1; }
        paint();
      });
      q('#rg-q').oninput = function () { st.q = q('#rg-q').value; paint(); };
      q('#rg-cat').onchange = function () { st.cat = q('#rg-cat').value; paint(); };
      q('#rg-min').onchange = function () { st.min = +q('#rg-min').value; paint(); };
      q('#rg-chk').onclick = function (e) { var b = e.target.closest('[data-c]'); if (!b) return; st.chk = b.getAttribute('data-c'); paint(); };
      q('#rg-all').onclick = function () { var on = q('#rg-all').getAttribute('aria-pressed') !== 'true'; list.forEach(function (x) { if (on) st.sel[rowKey(x)] = 1; else delete st.sel[rowKey(x)]; }); paint(); };
      q('#rg-selclear').onclick = function () { st.sel = {}; paint(); };
      q('#rg-pdf').onclick = function () { var t = target(); if (!t.length) { GC.toast('Nothing to report: no actions are shown.', 'warn'); return; } if (GC.report) GC.report.open(t, describeFilter(Object.keys(st.sel).length)); };
      q('#rg-csv').onclick = function () { GC.saveBlob(new Blob([csv(target())], { type: 'text/csv' }), (GC.project.name || 'GeoCanvas').replace(/[^\w\- ]+/g, '').trim() + ' actions register.csv'); };
      q('[data-a=done]').onclick = close;
      q('#rg-photos').onclick = function () { exportPhotos(target()); };
      q('#rg-new').onclick = function () { close(); newMenu(); };
      paint();
    }, function () { $('modal').classList.remove('wide', 'reg'); });
  }

  /** In words, which actions a report covers. */
  function describeFilter(nSel) {
    if (nSel) return 'Selected actions (' + nSel + ')';
    var bits = [];
    if (st.cat) { var c = null; GC.project.layers.forEach(function (l) { if (l.kind === 'waypoints' && l.photoPts) c = c || GC.camera.cats(l).filter(function (x) { return x.id === st.cat; })[0]; }); bits.push(c ? c.name : 'one category'); }
    if (st.min) bits.push(st.min === 4 ? 'Critical only' : GC.camera.IMP[st.min].n + ' and above');
    if (st.chk === 'todo') bits.push('To check'); else if (st.chk === 'done') bits.push('Checked');
    if (st.q) bits.push('“' + st.q + '”');
    return bits.length ? 'Filter: ' + bits.join(', ') : 'All actions';
  }
  /** File names for every photo of the listed actions, unique across the export: [{ x, ref, path }]. */
  function photoFiles(list, folders) {
    var used = {}, out = [];
    list.forEach(function (x) {
      var refs = x.w.photos || [], folder = folders ? (catName(x) || 'General').replace(/[\\\/:*?"<>|]+/g, '-') + '/' : '';
      refs.forEach(function (r, i) {
        var f = GC.photos.fileName(x.w.name, i, refs.length), k = (folder + f).toLowerCase(), n = 2;
        while (used[k]) { f = GC.photos.fileName(x.w.name + ' ~' + n++, i, refs.length); k = (folder + f).toLowerCase(); } // two actions with the same name
        used[k] = 1; out.push({ x: x, ref: r, path: folder + f });
      });
    });
    return out;
  }
  /** The listed actions' photos as a ZIP of JPEGs named after their actions (with date, place and name inside each),
      plus the register as CSV. On iPhone/iPad the photos can also go straight to the share sheet (Save to Photos). */
  function exportPhotos(list) {
    var withPh = list.filter(function (x) { return x.w.photos && x.w.photos.length; }), n = withPh.reduce(function (s, x) { return s + x.w.photos.length; }, 0);
    if (!n) { GC.toast('None of the actions shown in the register has a photo.', 'warn'); return; }
    var canShare = !!(navigator.canShare && global.File && (function () { try { return navigator.canShare({ files: [new File([''], 'a.jpg', { type: 'image/jpeg' })] }); } catch (e) { return false; } })());
    GC.modal('<h2>Export photos</h2><p class="sub">' + n + ' photo' + (n > 1 ? 's' : '') + ' from the ' + withPh.length + ' action' + (withPh.length > 1 ? 's' : '') + ' shown in the register, each named after its action (e.g. “' + esc(GC.photos.fileName(withPh[0].w.name, 0, withPh[0].w.photos.length)) + '”). Each photo carries the date it was taken, where it was and its name.</p>' +
      '<label class="opt"><input type="checkbox" id="ep-fold"> A folder for each category</label>' +
      '<label class="opt"><input type="checkbox" id="ep-csv" checked> Include the register (CSV)</label>' +
      '<div class="actions"><button class="btn" data-a="no">Cancel</button><span class="spacer"></span>' + (canShare ? '<button class="btn" data-a="share">Share photos…</button>' : '') + '<button class="btn primary" data-a="zip">Download ZIP</button></div>',
    function (el, close) {
      el.querySelector('[data-a=no]').onclick = close;
      var files = function () { return photoFiles(withPh, el.querySelector('#ep-fold').checked); };
      var tagged = function (f) { var w = f.x.w; return GC.photos.exportBlob(f.ref, { lat: w.lat, lon: w.lon, ele: w.ele, title: w.name + (w.note ? ' - ' + w.note : '') }); };
      el.querySelector('[data-a=zip]').onclick = function () {
        var fs = files(), csvToo = el.querySelector('#ep-csv').checked, fold = el.querySelector('#ep-fold').checked, missing = 0, z = new global.JSZip(); // read before close() empties the dialog
        close(); GC.busy('Packing ' + fs.length + ' photos…');
        fs.reduce(function (ch, f) { return ch.then(function () { return tagged(f).then(function (b) { if (b) z.file(f.path, b); else missing++; }); }); }, Promise.resolve()).then(function () {
          if (csvToo) z.file('actions register.csv', csv(list, fold));
          return z.generateAsync({ type: 'blob', compression: 'STORE' });
        }).then(function (blob) {
          GC.busy(null);
          var day = new Date().toISOString().slice(0, 10);
          GC.saveBlob(blob, (GC.project.name || 'GeoCanvas').replace(/[^\w\- ]+/g, '').trim() + ' photos ' + day + '.zip');
          GC.toast((fs.length - missing) + ' photo' + (fs.length - missing === 1 ? '' : 's') + ' exported.' + (missing ? ' ' + missing + ' are not on this device yet (they download from the team cloud when online).' : ''), missing ? 'warn' : null, 7000);
        }, function (e) { GC.busy(null); GC.toast(e.message, 'err'); });
      };
      if (canShare) el.querySelector('[data-a=share]').onclick = function () {
        // Safari needs the share to start in this tap: gather the files first, then ask for a second tap
        var fs = files().map(function (f) { return { f: f, path: f.path.split('/').pop() }; }), b = el.querySelector('[data-a=share]');
        b.disabled = true; b.textContent = 'Preparing…';
        Promise.all(fs.map(function (o) { return tagged(o.f).then(function (bl) { return bl && new File([bl], o.path, { type: 'image/jpeg' }); }); })).then(function (list2) {
          var ready = list2.filter(Boolean); b.disabled = false; b.textContent = 'Share ' + ready.length + ' photo' + (ready.length > 1 ? 's' : '') + ' now';
          b.onclick = function () { close(); navigator.share({ files: ready, title: GC.project.name + ' photos' }).catch(function (e) { if (e && e.name !== 'AbortError') GC.toast('Could not share: ' + e.message, 'err'); }); };
        });
      };
    }, function () { setTimeout(open, 0); }); // back to the register, filters as they were
  }
  /** + New action: a choice of photo, pin, area or line. */
  function newMenu() {
    GC.modal('<h2>New action</h2><div class="pm-grid na-grid">' +
      '<button data-n="photo"><svg><use xlink:href="#i-camera"/></svg><span>Photo</span></button><button data-n="pin"><svg><use xlink:href="#i-gpt"/></svg><span>Pin at my position</span></button>' +
      '<button data-n="area"><svg><use xlink:href="#i-gpoly"/></svg><span>Draw an area</span></button><button data-n="line"><svg><use xlink:href="#i-gline"/></svg><span>Draw a line</span></button></div>' +
      '<p class="hint">Or press and hold the map to pin a spot. Any drawing or measurement: tap it › More › Create action.</p><div class="actions"><button class="btn" data-a="no">Cancel</button></div>',
    function (el, close) {
      el.querySelector('[data-a=no]').onclick = close;
      [].forEach.call(el.querySelectorAll('[data-n]'), function (b) {
        b.onclick = function () { var n = b.getAttribute('data-n'); close(); if (n === 'photo') GC.camera.capture(); else if (n === 'pin') GC.camera.newAction({}); else GC.camera.drawAction(n); };
      });
    });
  }
  /** The register as CSV (opens in Excel: UTF-8 with BOM, CRLF lines). */
  function csv(list, folders) {
    var names = {}; photoFiles(list, !!folders).forEach(function (f) { (names[f.x.w.time] = names[f.x.w.time] || []).push(f.path); });
    var cam = GC.camera, iso = function (t) { var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
    var q = function (v) { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var head = ['Name', 'Type', 'Size', 'Category', 'Importance', 'Checked', 'Checked by', 'Checked at', 'Taken', 'Latitude', 'Longitude', 'MGA2020', 'GPS accuracy (m)', 'Note', 'Photos', 'Photo files', 'Layer'];
    var lines = [head.join(',')].concat(list.map(function (x) {
      var w = x.w;
      var kd = cam.kindOf(w);
      return [w.name, kd.k, kd.size, catName(x), cam.impOf(w).n, w.chk ? 'Yes' : 'No', w.chk ? w.chk.by : '', w.chk ? iso(w.chk.t) : '', iso(cam.taken(w)),
        w.lat.toFixed(7), w.lon.toFixed(7), Geo.fmt([w.lon, w.lat], 'mga'), w.acc != null ? Math.round(w.acc) : '', w.note || '', (w.photos || []).length, (names[w.time] || []).join('; '), x.l.name].map(q).join(',');
    }));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  if ($('btn-photos')) $('btn-photos').onclick = open;
  GC.register = { open: open, newMenu: newMenu, exportPhotos: exportPhotos, photoFiles: photoFiles, rows: rows, csv: function () { return csv(filtered()); } };
})(window);

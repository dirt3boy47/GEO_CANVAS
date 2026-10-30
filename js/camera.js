/* GeoCanvas web — Camera: quick photo points.
   Top-bar Camera → the iPad/iPhone camera opens straight away → the photo gets a pin at your GPS position, with a
   category (General, Defect, Safety…; the team can add their own) and an importance level (Info → Critical).
   Photo points are waypoints in a "Photo points" layer: they sync, search, export and get tap cards like any waypoint.
   Pins are coloured by importance and carry the category's symbol; the layer's options filter them. */
(function (global) {
  'use strict';
  var GC = global.GC, Geo = global.Geo, map = GC.map, $ = GC.$, esc = GC.esc;

  var IMP = [{ n: 'Info', c: '#6b7280' }, { n: 'Low', c: '#2e9d5b' }, { n: 'Medium', c: '#d99a00' }, { n: 'High', c: '#f26b00' }, { n: 'Critical', c: '#d62f2f' }];
  var CATS = [{ id: 'gen', name: 'General', icon: 'camera' }, { id: 'prog', name: 'Progress', icon: 'flag' }, { id: 'def', name: 'Defect', icon: 'wrench' },
    { id: 'safe', name: 'Safety', icon: 'alert' }, { id: 'env', name: 'Environmental', icon: 'leaf' }, { id: 'built', name: 'As-built', icon: 'check' }];
  // white symbols drawn inside the pin (24×24 box)
  var GLYPH = {
    camera: '<path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><circle cx="12" cy="13.3" r="3" fill="none" stroke="#fff" stroke-width="2.4"/>',
    flag: '<path d="M6 21V4m0 1h11l-2.5 4L17 13H6" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>',
    wrench: '<path d="M14.5 5.5a4 4 0 0 0-5 5L4.5 15.5l3.5 3.5 5-5a4 4 0 0 0 5-5L15.5 11.5 12.5 11 12 8z" fill="none" stroke="#fff" stroke-width="2.3" stroke-linejoin="round"/>',
    alert: '<path d="M12 4 21 20H3z" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><path d="M12 10v4.5" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.4" fill="#fff"/>',
    leaf: '<path d="M5 19C5 10 10.5 5 19 5c0 8.5-5 14-14 14zm0 0 8-8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  var LAST = 'gc.camCat';

  /** The project's photo points layer (made on first use). */
  function layer(create) {
    var l = GC.project && GC.project.layers.filter(function (x) { return x.kind === 'waypoints' && x.photoPts; }).pop();
    if (!l && create) {
      l = { id: global.Ink.uid(), name: 'Photo points', kind: 'waypoints', visible: true, opacity: 1, locked: false, color: '#e8590c', photoPts: true, cats: CATS.map(function (c) { return Object.assign({}, c); }), waypoints: [], created: Date.now() };
      GC.insertLayer(l, true);
    }
    return l;
  }
  function cats(l) { return (l && l.cats) || CATS; }
  function catOf(l, w) { var k = w.cat || 'gen'; return cats(l).filter(function (c) { return c.id === k; })[0] || null; } // no category yet = General
  function isPhotoPt(l, w) { return !!(l && l.photoPts) || w.cat != null || w.imp != null; }
  function impOf(w) { return IMP[Math.max(0, Math.min(4, w.imp | 0))]; }
  function symbol(c, x, y, s) {
    if (c && GLYPH[c.icon]) return '<g transform="translate(' + x + ' ' + y + ') scale(' + s + ')">' + GLYPH[c.icon] + '</g>';
    var ch = c ? c.name.trim().charAt(0).toUpperCase() : '?';
    return '<text x="' + (x + 12 * s) + '" y="' + (y + 16.5 * s) + '" text-anchor="middle" font-size="' + 14 * s + '" font-weight="700" font-family="-apple-system,Segoe UI,Roboto,sans-serif" fill="#fff">' + esc(ch) + '</text>';
  }
  var TICK = '<g transform="translate(24 6)"><circle r="6.5" fill="#1e8e3e" stroke="#fff" stroke-width="1.8"/><path d="m-3 0 2 2.2L3.2-2.4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>';
  function pinSvg(color, c, done) {
    return '<svg width="32" height="40" viewBox="0 0 32 40"><path d="M15 38.5S3 26.6 3 15a12 12 0 0 1 24 0c0 11.6-12 23.5-12 23.5z" fill="' + color + '" stroke="#fff" stroke-width="2.2"/>' + symbol(c, 6.6, 6.6, 0.7) + (done ? TICK : '') + '</svg>';
  }
  /** Map pin for a photo point: importance colour, category symbol, a green tick once checked. */
  function icon(l, w) { return L.divIcon({ className: 'gc-ppin', html: pinSvg(impOf(w).c, catOf(l, w), !!w.chk), iconSize: [32, 40], iconAnchor: [15, 38] }); }
  /** Whether the layer's filter shows this point. */
  function shown(l, w) {
    if (!l.photoPts) return true;
    if (l.hideCats && l.hideCats[w.cat || 'gen']) return false;
    if (l.hideChecked && w.chk) return false;
    return (w.imp | 0) >= (l.minImp | 0);
  }
  function label(l, w) { var c = catOf(l, w); return (c ? c.name + ' · ' : '') + impOf(w).n; }
  /** When the photo was taken: the camera's own time (EXIF), else when it was pinned. */
  function taken(w) { return w.taken || (w.photos && w.photos[0] && w.photos[0].t) || w.time; }
  function me() { var s = GC.settings || {}; return (s.cloud && s.cloud.device) || s.lastName || 'This device'; }
  /** Ticks a photo point as checked (who and when), or unticks it. */
  function setChecked(l, w, on) {
    if (on) w.chk = { t: Date.now(), by: me() }; else delete w.chk;
    GC.renderLayer(l); GC.markDirty(l.id); GC.refreshLayers(true);
  }
  function checkedText(w) { return w.chk ? 'Checked by ' + w.chk.by + ' · ' + GC.fmtTime(w.chk.t) : 'Not checked yet'; }

  // ---------- take a photo ----------
  /** Opens the camera straight away (iPad/iPhone; elsewhere a file picker). Must run inside a tap handler. */
  function capture() {
    if (!GC.project) return;
    if (GC.gps) GC.gps.start(); // the fix comes in while the photo is taken
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.setAttribute('capture', 'environment'); inp.style.display = 'none';
    inp.onchange = function () {
      var fs = Array.prototype.slice.call(inp.files || []); if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (!fs.length) return;
      GC.busy('Adding photo…');
      GC.photos.ingest([fs[0]]).then(function (refs) { GC.busy(null); sheet(refs[0], { again: true }); }, function (e) { GC.busy(null); GC.toast(e.message, 'err'); });
    };
    document.body.appendChild(inp); inp.click();
  }
  /** Where a new photo point goes: a fresh GPS fix, else the photo's own location, else the map centre. */
  function position(ref) {
    var f = GC.gps && GC.gps.fix(), c = map.getCenter();
    if (f && Date.now() - f.t < 60000) return { lat: f.lat, lon: f.lon, acc: f.acc, ele: f.alt != null ? f.alt : null, src: 'gps' };
    if (ref && ref.lat != null) return { lat: ref.lat, lon: ref.lon, acc: null, ele: null, src: 'photo' };
    return { lat: c.lat, lon: c.lng, acc: null, ele: null, src: 'centre' };
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function chipsHtml(cs, sel) {
    return cs.map(function (c) { return '<button class="cam-chip' + (c.id === sel ? ' on' : '') + '" data-c="' + esc(c.id) + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + symbol(c, 0, 0, 1).replace(/#fff/g, 'currentColor') + '</svg><span>' + esc(c.name) + '</span></button>'; }).join('') +
      '<button class="cam-chip add" data-new>+ New</button>';
  }
  function impHtml(sel) {
    return IMP.map(function (m, i) { return '<button class="cam-imp' + (i === sel ? ' on' : '') + '" data-i="' + i + '" style="--ic:' + m.c + '"><i></i>' + m.n + '</button>'; }).join('');
  }
  /** Size and middle of a drawn action: { text, ll:[lon,lat] }. */
  function geomInfo(g) {
    if (g.type === 'Polygon') {
      var r = g.coordinates[0], a = Math.abs(Geo.ringArea(r)), b = L.polygon(r.map(function (q) { return [q[1], q[0]]; })).getBounds().getCenter();
      return { text: 'Area ' + GC.fmtArea(a) + ' · perimeter ' + GC.fmtDist(Geo.pathLength(r)), short: GC.fmtArea(a), ll: [b.lng, b.lat], kind: 'Area' };
    }
    var c = g.coordinates, m = c[Math.floor((c.length - 1) / 2)];
    if (c.length % 2 === 0 && c.length > 1) { var n = c[c.length / 2]; m = [(m[0] + n[0]) / 2, (m[1] + n[1]) / 2]; }
    return { text: 'Line ' + GC.fmtDist(Geo.pathLength(c)), short: GC.fmtDist(Geo.pathLength(c)), ll: m, kind: 'Line' };
  }
  function marks(n) { return n + (n === 1 ? ' mark' : ' marks'); }
  var inkCopies = typeof WeakMap === 'function' ? new WeakMap() : null;
  /** A drawable copy of a drawn action's ink item (the copy carries the render cache; the saved item stays plain data). */
  function inkEl(it) {
    var c = inkCopies && inkCopies.get(it);
    if (!c) { c = {}; for (var k in it) if (k !== '_g') c[k] = it[k]; if (inkCopies) inkCopies.set(it, c); }
    return c;
  }
  /** Latitude/longitude bounds of a drawing's ink items. */
  function sketchBounds(items) {
    var b = null;
    (items || []).forEach(function (it) {
      var m; try { m = global.Ink.mercBounds(inkEl(it)); } catch (e) { return; }
      [Geo.unmerc(m[0], m[1]), Geo.unmerc(m[2], m[3])].forEach(function (q) { if (isFinite(q[0]) && isFinite(q[1])) b = b ? b.extend([q[1], q[0]]) : L.latLngBounds([q[1], q[0]], [q[1], q[0]]); });
    });
    return b;
  }
  /** Draws ink items into a 2D context; pt(merc) gives the pixel, z the zoom of that pixel grid. Markers become dots. */
  function drawInk(ctx, items, pt, z, r) {
    (items || []).forEach(function (it) {
      var el = inkEl(it);
      if (el.type === 'marker') { var p = pt(Geo.merc(el.at[0], el.at[1])); ctx.beginPath(); ctx.arc(p[0], p[1], r || 5, 0, 7); ctx.fillStyle = el.color || '#e53935'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke(); return; }
      try { global.Ink.draw(ctx, el, pt, z, 1); } catch (e) { /* degenerate item */ }
    });
  }
  var thumbs = typeof WeakMap === 'function' ? new WeakMap() : null;
  /** A small picture of a drawn action (PNG data URL) for the register and the phone's Actions grid. */
  function sketchThumb(w, size) {
    var hit = thumbs && thumbs.get(w.sketch); if (hit) return hit;
    var b = sketchBounds(w.sketch); if (!b) return '';
    var crs = L.CRS.EPSG3857, z = 23, pad = size * 0.1;
    for (; z > 2; z--) { var a = crs.latLngToPoint(b.getNorthWest(), z), c = crs.latLngToPoint(b.getSouthEast(), z); if (c.x - a.x <= size - 2 * pad && c.y - a.y <= size - 2 * pad) break; }
    var mid = crs.latLngToPoint(b.getCenter(), z), W = 256 * Math.pow(2, z), ox = mid.x - size / 2, oy = mid.y - size / 2;
    var cv = document.createElement('canvas'), k = 2; cv.width = cv.height = size * k;
    var ctx = cv.getContext('2d'); ctx.scale(k, k); ctx.fillStyle = '#f3f1ea'; ctx.fillRect(0, 0, size, size);
    drawInk(ctx, w.sketch, function (m) { return [m[0] * W - ox, m[1] * W - oy]; }, z, 4);
    var url = cv.toDataURL('image/png'); if (thumbs) thumbs.set(w.sketch, url);
    return url;
  }
  /** Where a drawing's pin goes: the middle of its top edge (so the pin does not hide the drawing). */
  function sketchPin(items) { var b = sketchBounds(items); return b ? [Math.round(b.getCenter().lng * 1e7) / 1e7, Math.round(b.getNorth() * 1e7) / 1e7] : null; }
  /** The shape that stands for an action on the map (zoom, highlight, Go): its area or line, or the frame round its drawing. */
  function shapeOf(w) {
    if (w.geom) return w.geom;
    var b = w.sketch && sketchBounds(w.sketch); if (!b) return null;
    var s = b.getSouth(), n = b.getNorth(), e = b.getEast(), x = b.getWest();
    return { type: 'Polygon', coordinates: [[[x, s], [e, s], [e, n], [x, n], [x, s]]] };
  }
  /** What kind of action a waypoint is: Photo, Pin, Area, Line or Drawing (+ size). */
  function kindOf(w) {
    if (w.sketch) return { k: 'Drawing', size: marks(w.sketch.length) };
    if (w.geom) { var gi = geomInfo(w.geom); return { k: gi.kind, size: gi.short }; }
    return { k: w.photos && w.photos.length ? 'Photo' : 'Pin', size: '' };
  }
  /**
   * The quick sheet for a new action: photo (if any), name, category, importance, note. Closing it any other way than
   * Discard saves. opt: { geom (drawn Polygon/LineString), sketch (drawing items), at ([lon, lat] a chosen place), again (offer "Save + next photo"),
   * done (called once the sheet has closed, saved or not) }.
   * Without geom or at, the action goes at your GPS position (else the photo's own location, else the map centre).
   */
  function sheet(ref, opt) {
    opt = opt || {};
    var l0 = layer(false), cs = cats(l0).map(function (c) { return Object.assign({}, c); }), last = null;
    try { last = localStorage.getItem(LAST); } catch (e) { /* private mode */ }
    var st = { cat: cs.some(function (c) { return c.id === last; }) ? last : cs[0].id, imp: 0, done: false, photos: ref ? [ref] : [] };
    var sp = opt.sketch ? sketchPin(opt.sketch) : null;
    var gi = opt.geom ? geomInfo(opt.geom) : sp ? { text: 'Drawing · ' + marks(opt.sketch.length), ll: sp, kind: 'Drawing' } : null, what = gi ? gi.kind.toLowerCase() : ref ? 'photo' : 'pin';
    var timer = null;
    var where = function () {
      if (gi) return { lat: gi.ll[1], lon: gi.ll[0], acc: null, ele: null, src: 'drawn' };
      if (opt.at) return { lat: opt.at[1], lon: opt.at[0], acc: null, ele: null, src: 'chosen' };
      return position(st.photos[0]);
    };
    var save = function (el) {
      if (st.done) return null; st.done = true; clearInterval(timer);
      var l = layer(true), p = where(), c = cs.filter(function (x) { return x.id === st.cat; })[0];
      l.cats = cs;
      var n = l.waypoints.filter(function (w) { return w.cat === st.cat; }).length + 1;
      var name = el && el.querySelector('#cam-name').value.trim() || (c ? c.name : 'Action') + ' ' + pad(n);
      var w = { lat: p.lat, lon: p.lon, ele: p.ele, acc: p.acc, time: Date.now(), taken: st.photos[0] ? st.photos[0].t || Date.now() : Date.now(), name: name, note: el ? el.querySelector('#cam-note').value.trim() : '', cat: st.cat, imp: st.imp };
      if (st.photos.length) w.photos = st.photos;
      if (opt.geom) w.geom = opt.geom;
      if (opt.sketch) w.sketch = opt.sketch;
      l.waypoints.push(w);
      try { localStorage.setItem(LAST, st.cat); } catch (e) { /* private mode */ }
      if (!l.visible) l.visible = true;
      GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id, true); GC.refreshLayers();
      if (!shown(l, w)) GC.toast('Saved, but the layer’s filter hides ' + label(l, w) + ' actions.', 'warn');
      else if (p.src === 'gps') GC.toast('“' + name + '” pinned at your GPS position (±' + Math.round(p.acc) + ' m).');
      else if (p.src === 'photo') GC.toast('“' + name + '” pinned where the photo was taken.');
      else if (p.src === 'drawn' || p.src === 'chosen') GC.toast('“' + name + '” saved.');
      else GC.toast('No GPS fix yet, so “' + name + '” is at the map centre. Tap it › More › Move pin to put it in the right spot.', 'warn', 8000);
      return { l: l, w: w };
    };
    GC.modal('<div class="cam-sheet"><div class="cam-top"><div class="cam-thumb"><img alt=""><button class="cam-addph" type="button"><svg><use xlink:href="#i-camera"/></svg><span>Add photo</span></button></div><div class="cam-meta">' +
      '<input type="text" id="cam-name" placeholder="Name (automatic)" autocomplete="off"><div class="cam-loc" id="cam-loc"></div></div></div>' +
      '<div class="cam-lbl">Category</div><div class="cam-chips" id="cam-cats">' + chipsHtml(cs, st.cat) + '</div>' +
      '<div class="cam-lbl">Importance</div><div class="cam-imps" id="cam-imps">' + impHtml(st.imp) + '</div>' +
      '<textarea id="cam-note" rows="2" placeholder="Note (optional)"></textarea>' +
      '<div class="actions"><button class="btn" data-a="discard">Discard</button><span class="spacer"></span>' + (opt.again ? '<button class="btn" data-a="again">Save + next photo</button>' : '') + '<button class="btn primary" data-a="save">Save</button></div></div>',
    function (el, close) {
      var thumb = el.querySelector('.cam-thumb'), img = thumb.querySelector('img');
      var paintPh = function () {
        thumb.classList.toggle('empty', !st.photos.length);
        if (st.photos.length) GC.photos.url(st.photos[0].id).then(function (u) { if (u) img.src = u; });
      };
      paintPh();
      thumb.querySelector('.cam-addph').onclick = function () { GC.photos.pick().then(function (more) { if (more.length) { st.photos = st.photos.concat(more); paintPh(); } }); };
      var loc = el.querySelector('#cam-loc');
      var paintLoc = function () {
        var p = where();
        loc.className = 'cam-loc ' + (p.src === 'gps' ? (p.acc <= 10 ? 'good' : p.acc <= 30 ? 'fair' : 'poor') : p.src === 'photo' ? 'fair' : p.src === 'centre' ? 'poor' : 'good');
        loc.textContent = p.src === 'drawn' ? gi.text : p.src === 'chosen' ? 'Pin where you pressed' : p.src === 'gps' ? 'Pin at your GPS position · ±' + Math.round(p.acc) + ' m' : p.src === 'photo' ? 'Pin where the photo was taken (its own location)' : 'Waiting for GPS… (if none comes, the pin goes at the map centre)';
      };
      paintLoc(); if (!gi && !opt.at) timer = setInterval(paintLoc, 800);
      var catBox = el.querySelector('#cam-cats');
      var bindCats = function () {
        [].forEach.call(catBox.querySelectorAll('[data-c]'), function (b) { b.onclick = function () { st.cat = b.getAttribute('data-c'); catBox.innerHTML = chipsHtml(cs, st.cat); bindCats(); }; });
        catBox.querySelector('[data-new]').onclick = function () {
          catBox.querySelector('[data-new]').outerHTML = '<span class="cam-new"><input type="text" placeholder="New category" maxlength="30"><button class="btn primary">Add</button></span>';
          var inp = catBox.querySelector('.cam-new input'), add = function () {
            var v = inp.value.trim(); if (!v) { catBox.innerHTML = chipsHtml(cs, st.cat); bindCats(); return; }
            var hit = cs.filter(function (c) { return c.name.toLowerCase() === v.toLowerCase(); })[0];
            if (!hit) { hit = { id: 'c' + global.Ink.uid().slice(0, 8), name: v }; cs.push(hit); }
            st.cat = hit.id; catBox.innerHTML = chipsHtml(cs, st.cat); bindCats();
          };
          inp.focus(); catBox.querySelector('.cam-new .btn').onclick = add; inp.onkeydown = function (e) { if (e.key === 'Enter') add(); };
        };
      };
      bindCats();
      var impBox = el.querySelector('#cam-imps');
      [].forEach.call(impBox.querySelectorAll('[data-i]'), function (b) { b.onclick = function () { st.imp = +b.getAttribute('data-i'); [].forEach.call(impBox.children, function (x) { x.classList.toggle('on', x === b); }); }; });
      el.querySelector('[data-a=discard]').onclick = function () { st.done = true; clearInterval(timer); close(); GC.toast((what === 'photo' ? 'Photo' : what === 'drawing' ? 'Drawing' : 'Action') + ' discarded.'); };
      el.querySelector('[data-a=save]').onclick = function () { save(el); close(); };
      if (opt.again) el.querySelector('[data-a=again]').onclick = function () { save(el); close(); capture(); };
    }, function () { clearInterval(timer); if (!st.done) save(null); if (opt.done) opt.done(); }); // tapped outside: keep it
  }
  /** Starts a new action without a camera shot: { at } a pin there, { geom } a drawn area or line, {} a pin at your GPS position. */
  function newAction(opt) { if (!GC.project) return; if (!opt || (!opt.at && !opt.geom)) { if (GC.gps) GC.gps.start(); } sheet(null, opt || {}); }
  /** Draw an action area or line on the map (the measuring tool with a Create action button). */
  function drawAction(mode) { if (GC.measure) GC.measure.drawAction(mode || 'area'); }

  // ---------- draw an action: pens, shapes, text and markers that become one action ----------
  var SK = null, bar = null;
  function plain(it) { var c = {}; for (var k in it) if (k !== '_g') c[k] = it[k]; return JSON.parse(JSON.stringify(c)); }
  function skLayer() { return SK && GC.layerById(SK.lid); }
  function skBar() {
    if (bar) return bar;
    bar = document.createElement('div'); bar.id = 'sk-bar'; bar.className = 'panel'; bar.hidden = true;
    bar.innerHTML = '<div class="sk-txt"><b id="sk-title"></b><small id="sk-n"></small></div><button class="ib" id="sk-undo" title="Undo" aria-label="Undo"><svg><use xlink:href="#i-undo"/></svg></button>' +
      '<button class="btn" id="sk-cancel">Cancel</button><button class="btn primary" id="sk-save">Save</button>';
    document.body.appendChild(bar);
    $('sk-undo').onclick = function () { GC.undo(); };
    $('sk-cancel').onclick = cancelSketch;
    $('sk-save').onclick = saveSketch;
    return bar;
  }
  function skPaint() {
    var l = skLayer(); if (!l) { stopSketch(); return; }
    var n = l.items.length;
    $('sk-n').textContent = n ? marks(n) + ' · tap Save when done' : 'Draw, write and mark up, then Save';
    $('sk-save').disabled = !n; $('sk-undo').disabled = !GC.history.undo.length;
  }
  /**
   * New action drawing: every pen, shape, text and marker tool draws on a scratch layer of its own (kept out of the team
   * sync); Save turns the drawing into one action (the action sheet opens). opt: { l, w } changes a drawn action's ink.
   */
  function sketch(opt) {
    if (!GC.project) return; opt = opt || {};
    if (SK) stopSketch();
    if (GC.measure && GC.measure.isOn()) GC.measure.close();
    if (GC.closeInspector) GC.closeInspector();
    var t = GC.newDrawingLayer(opt.w ? 'Editing ' + (opt.w.name || 'action') : 'Action drawing');
    if (opt.w) t.items = opt.w.sketch.map(plain);
    SK = { lid: t.id, l: opt.l, w: opt.w, prev: GC.project.activeLayer, fd: GC.settings.fingerDraw };
    GC.tempLayer = t.id;
    GC.insertLayer(t, true); GC.project.activeLayer = t.id;
    if (document.body.classList.contains('phone')) GC.settings.fingerDraw = true; // no Pencil on a phone: one finger draws, two move the map
    document.body.classList.add('sketching');
    skBar().hidden = false; $('sk-title').textContent = opt.w ? 'Editing “' + (opt.w.name || 'action') + '”' : 'New action drawing';
    GC.setMode('draw'); GC.refreshLayers();
    SK.timer = setInterval(skPaint, 300); skPaint();
    if (opt.w) { var b = sketchBounds(opt.w.sketch); if (b) map.fitBounds(b, { padding: [90, 90], maxZoom: 20, animate: false }); }
    GC.toast(opt.w ? 'Change the drawing, then tap Save.' : 'Draw, write and mark up with any tool, then tap Save to make it an action.', null, 6000);
  }
  /** Ends the drawing session and removes its scratch layer. */
  function stopSketch() {
    if (!SK) return;
    var s = SK; SK = null; clearInterval(s.timer); GC.tempLayer = null;
    document.body.classList.remove('sketching'); if (bar) bar.hidden = true;
    if (GC.settings.fingerDraw !== s.fd) { GC.settings.fingerDraw = s.fd; GC.saveSettings(); }
    if (GC.mode === 'draw') GC.setMode('nav');
    if (GC.layerById(s.lid)) GC.removeLayer(s.lid);
    if (GC.layerById(s.prev)) { GC.project.activeLayer = s.prev; GC.refreshLayers(); }
  }
  function saveSketch() {
    var l = skLayer(); if (!l) { stopSketch(); return; }
    var items = l.items.map(plain), s = SK;
    if (!items.length) { GC.toast('Draw something first, or tap Cancel.', 'warn'); return; }
    if (s.w) { // changing a drawn action: find it again (a sync may have replaced the objects meanwhile)
      stopSketch();
      var al = GC.layerById(s.l.id) || s.l, w = (al.waypoints || []).filter(function (x) { return x.time === s.w.time; })[0];
      if (!w) { GC.toast('That action was deleted meanwhile.', 'warn'); return; }
      var pin = sketchPin(items); w.sketch = items; if (pin) { w.lon = pin[0]; w.lat = pin[1]; }
      GC.renderLayer(al); GC.markDirty(al.id); GC.refreshLayers(true); GC.toast('Drawing updated.');
      GC.inspectWaypoint(al, w); return;
    }
    // the drawing stays on show under the action sheet; the scratch layer goes once the sheet closes
    clearInterval(s.timer); if (bar) bar.hidden = true; if (GC.mode === 'draw') GC.setMode('nav');
    sheet(null, { sketch: items, done: stopSketch });
  }
  function cancelSketch() {
    var l = skLayer(), n = l ? l.items.length : 0;
    if (SK && !SK.w && n) {
      GC.confirm('Discard this drawing?', 'Its ' + marks(n) + ' will be thrown away.', 'Discard', true).then(function (ok) { if (ok) { stopSketch(); GC.toast('Drawing discarded.'); } });
      return;
    }
    stopSketch();
  }
  // the toolbar's Done (✕) and Navigate save the drawing while one is open
  ['btn-done', 'mode-nav'].forEach(function (id) {
    var b = $(id), was = b.onclick;
    b.onclick = function (e) { if (SK && !bar.hidden) saveSketch(); else if (was) was.call(b, e); };
  });

  // ---------- on the tap card ----------
  /** Category and importance pickers for a photo point's card. */
  function cardBody(l, w, onChange) {
    var d = document.createElement('div'); d.className = 'cam-card';
    var ro = l.locked, ph = w.photos && w.photos[0];
    d.innerHTML = (ph ? '<button class="cam-hero" aria-label="Open the photo"><img alt=""></button>' : '') + '<label>Category<select data-k="cat"' + (ro ? ' disabled' : '') + '>' + cats(l).map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === (w.cat || 'gen') ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></label>' +
      '<label>Importance<select data-k="imp"' + (ro ? ' disabled' : '') + ' style="--ic:' + impOf(w).c + '">' + IMP.map(function (m, i) { return '<option value="' + i + '"' + (i === (w.imp | 0) ? ' selected' : '') + '>' + m.n + '</option>'; }).join('') + '</select></label>' +
      '<button class="cam-check' + (w.chk ? ' on' : '') + '"' + (ro ? ' disabled' : '') + '><i></i><span></span></button>';
    var ck = d.querySelector('.cam-check'), paintCk = function () { ck.classList.toggle('on', !!w.chk); ck.querySelector('span').textContent = w.chk ? checkedText(w) : 'Tick when checked'; };
    paintCk();
    ck.onclick = function () { setChecked(l, w, !w.chk); paintCk(); if (onChange) onChange(); };
    if (ph) {
      var hero = d.querySelector('.cam-hero');
      GC.photos.url(ph.id).then(function (u) { if (u) hero.firstChild.src = u; });
      hero.onclick = function () { GC.photos.view(w.photos, 0, null, { name: w.name, lat: w.lat, lon: w.lon, note: w.note }); };
    }
    [].forEach.call(d.querySelectorAll('select'), function (s) {
      s.onchange = function () {
        if (s.getAttribute('data-k') === 'cat') w.cat = s.value; else { w.imp = +s.value; s.style.setProperty('--ic', impOf(w).c); }
        GC.renderLayer(l); GC.markDirty(l.id); GC.refreshLayers(true); if (onChange) onChange();
      };
    });
    return d;
  }

  // ---------- layer options: filter and categories ----------
  function optionsHtml(l) {
    var count = {}; (l.waypoints || []).forEach(function (w) { var k = w.cat || 'gen'; count[k] = (count[k] || 0) + 1; });
    var hc = l.hideCats || {};
    var nChk = (l.waypoints || []).filter(function (w) { return w.chk; }).length;
    return '<div class="cam-opts"><button class="btn primary" id="cam-reg">Open the photo register (' + (l.waypoints || []).length + ')</button>' +
      '<label class="opt"><input type="checkbox" id="cam-hidechk"' + (l.hideChecked ? ' checked' : '') + '> Hide checked photos (' + nChk + ')</label><div class="cam-lbl">Show importance</div><select id="cam-min">' + IMP.map(function (m, i) { return '<option value="' + i + '"' + (i === (l.minImp | 0) ? ' selected' : '') + '>' + (i === 0 ? 'All' : i === 4 ? 'Critical only' : m.n + ' and above') + '</option>'; }).join('') + '</select>' +
      '<div class="cam-lbl">Categories <small>(untick to hide; rename by typing)</small></div><div id="cam-catlist">' +
      cats(l).map(function (c, i) {
        return '<div class="cam-crow"><input type="checkbox" data-show="' + i + '"' + (hc[c.id] ? '' : ' checked') + '><span class="cam-sym">' + pinSvg(IMP[0].c, c) + '</span>' +
          '<input type="text" data-name="' + i + '" value="' + esc(c.name) + '"' + (l.locked ? ' readonly' : '') + '><small>' + (count[c.id] || 0) + '</small>' +
          (count[c.id] || cats(l).length < 2 || l.locked ? '<span class="cam-nodel"></span>' : '<button class="ib" data-del="' + i + '" title="Delete category"><svg><use xlink:href="#i-close"/></svg></button>') + '</div>';
      }).join('') + '</div>' + (l.locked ? '' : '<button class="btn" id="cam-addcat">+ Add category</button>') +
      '<p class="hint">Pins are coloured by importance: ' + IMP.map(function (m) { return '<b style="color:' + m.c + '">' + m.n + '</b>'; }).join(' · ') + '.</p></div>';
  }
  function bindOptions(el, l, reopen) {
    var q = function (s) { return el.querySelector(s); }, apply = function () { GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id); GC.refreshLayers(true); };
    if (!l.cats) l.cats = CATS.map(function (c) { return Object.assign({}, c); });
    q('#cam-reg').onclick = function () { GC.closeModal(); if (GC.register) GC.register.open(); };
    q('#cam-hidechk').onchange = function () { if (q('#cam-hidechk').checked) l.hideChecked = true; else delete l.hideChecked; apply(); };
    q('#cam-min').onchange = function () { l.minImp = +q('#cam-min').value; if (!l.minImp) delete l.minImp; apply(); };
    [].forEach.call(el.querySelectorAll('[data-show]'), function (b) {
      b.onchange = function () { var c = l.cats[+b.getAttribute('data-show')]; l.hideCats = Object.assign({}, l.hideCats); if (b.checked) delete l.hideCats[c.id]; else l.hideCats[c.id] = 1; if (!Object.keys(l.hideCats).length) delete l.hideCats; apply(); };
    });
    [].forEach.call(el.querySelectorAll('[data-name]'), function (b) {
      b.onchange = function () { var v = b.value.trim(), i = +b.getAttribute('data-name'); if (!v) { b.value = l.cats[i].name; return; } l.cats = l.cats.slice(); l.cats[i] = Object.assign({}, l.cats[i], { name: v }); apply(); };
    });
    [].forEach.call(el.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function () { var i = +b.getAttribute('data-del'); l.cats = l.cats.filter(function (x, j) { return j !== i; }); apply(); reopen(); };
    });
    if (q('#cam-addcat')) q('#cam-addcat').onclick = function () {
      GC.prompt('New category', '', 'e.g. Fencing, Traffic control', 'Add').then(function (v) {
        if (v && v.trim()) { l.cats = l.cats.concat([{ id: 'c' + global.Ink.uid().slice(0, 8), name: v.trim() }]); apply(); }
        reopen();
      });
    };
  }

  $('btn-camera').onclick = function () { if (GC.ui) GC.ui.close(); capture(); };
  $('am-pin').onclick = function () { if (GC.ui) GC.ui.close(); newAction({}); };
  $('am-area').onclick = function () { if (GC.ui) GC.ui.close(); drawAction('area'); };
  $('am-line').onclick = function () { if (GC.ui) GC.ui.close(); drawAction('line'); };
  $('am-sketch').onclick = function () { if (GC.ui) GC.ui.close(); sketch(); };

  // Press and hold the map (finger or Pencil, or right-click) to drop an action pin right there.
  var hold = null;
  function holdOk(e) {
    if (GC.mode === 'draw' || SK || (GC.measure && GC.measure.isOn()) || GC.placeOnce || !GC.project) return false;
    var t = e.target; return map.getContainer().contains(t) && !(t.closest && t.closest('.leaflet-control, .leaflet-popup, .leaflet-marker-draggable'));
  }
  function dropAt(x, y) {
    var r = map.getContainer().getBoundingClientRect(), ll = map.containerPointToLatLng([x - r.left, y - r.top]);
    GC.suppressClickUntil = Date.now() + 700; // the lift that ends the hold is not a tap
    if (navigator.vibrate) navigator.vibrate(30);
    if (GC.closeInspector) GC.closeInspector();
    newAction({ at: [Math.round(ll.lng * 1e7) / 1e7, Math.round(ll.lat * 1e7) / 1e7] });
  }
  window.addEventListener('pointerdown', function (e) {
    if (hold) { clearTimeout(hold.t); hold = null; return; } // a second finger: a pinch, not a hold
    if (e.pointerType === 'mouse' || !holdOk(e)) return;
    var x = e.clientX, y = e.clientY;
    hold = { id: e.pointerId, x: x, y: y, t: setTimeout(function () { hold = null; dropAt(x, y); }, 650) };
  }, true);
  window.addEventListener('pointermove', function (e) { if (hold && e.pointerId === hold.id && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10) { clearTimeout(hold.t); hold = null; } }, true);
  ['pointerup', 'pointercancel'].forEach(function (t) { window.addEventListener(t, function (e) { if (hold && e.pointerId === hold.id) { clearTimeout(hold.t); hold = null; } }, true); });
  map.on('movestart zoomstart', function () { if (hold) { clearTimeout(hold.t); hold = null; } });
  map.getContainer().addEventListener('contextmenu', function (e) { e.preventDefault(); if (e.pointerType === 'touch' || !holdOk(e) || Date.now() < (GC.suppressClickUntil || 0)) return; dropAt(e.clientX, e.clientY); });

  GC.camera = { capture: capture, layer: layer, icon: icon, shown: shown, isPhotoPt: isPhotoPt, label: label, cardBody: cardBody, catOf: catOf, impOf: impOf,
    optionsHtml: optionsHtml, bindOptions: bindOptions, IMP: IMP, CATS: CATS, cats: cats, taken: taken, setChecked: setChecked, checkedText: checkedText, pinSvg: pinSvg,
    newAction: newAction, drawAction: drawAction, geomInfo: geomInfo, kindOf: kindOf, symbol: symbol,
    sketch: sketch, sketching: function () { return !!SK; }, inkEl: inkEl, drawInk: drawInk, sketchThumb: sketchThumb, sketchBounds: sketchBounds, shapeOf: shapeOf, marks: marks };
})(window);

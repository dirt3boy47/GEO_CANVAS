/* GeoCanvas web — Camera: quick photo points.
   Top-bar Camera → the iPad/iPhone camera opens straight away → the photo gets a pin at your GPS position, with a
   category (General, Defect, Safety…; the team can add their own) and an importance level (Info → Critical).
   Photo points are waypoints in a "Photo points" layer: they sync, search, export and get tap cards like any waypoint.
   Pins are coloured by importance and carry the category's symbol; the layer's options filter them. */
(function (global) {
  'use strict';
  var GC = global.GC, map = GC.map, $ = GC.$, esc = GC.esc;

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
  function catOf(l, w) { return cats(l).filter(function (c) { return c.id === w.cat; })[0] || null; }
  function isPhotoPt(l, w) { return !!(l && l.photoPts) || w.cat != null || w.imp != null; }
  function impOf(w) { return IMP[Math.max(0, Math.min(4, w.imp | 0))]; }
  function symbol(c, x, y, s) {
    if (c && GLYPH[c.icon]) return '<g transform="translate(' + x + ' ' + y + ') scale(' + s + ')">' + GLYPH[c.icon] + '</g>';
    var ch = c ? c.name.trim().charAt(0).toUpperCase() : '?';
    return '<text x="' + (x + 12 * s) + '" y="' + (y + 16.5 * s) + '" text-anchor="middle" font-size="' + 14 * s + '" font-weight="700" font-family="-apple-system,Segoe UI,Roboto,sans-serif" fill="#fff">' + esc(ch) + '</text>';
  }
  function pinSvg(color, c) {
    return '<svg width="30" height="40" viewBox="0 0 30 40"><path d="M15 38.5S3 26.6 3 15a12 12 0 0 1 24 0c0 11.6-12 23.5-12 23.5z" fill="' + color + '" stroke="#fff" stroke-width="2.2"/>' + symbol(c, 6.6, 6.6, 0.7) + '</svg>';
  }
  /** Map pin for a photo point: importance colour, category symbol. */
  function icon(l, w) { return L.divIcon({ className: 'gc-ppin', html: pinSvg(impOf(w).c, catOf(l, w)), iconSize: [30, 40], iconAnchor: [15, 38] }); }
  /** Whether the layer's filter shows this point. */
  function shown(l, w) {
    if (!l.photoPts) return true;
    if (l.hideCats && l.hideCats[w.cat || 'gen']) return false;
    return (w.imp | 0) >= (l.minImp | 0);
  }
  function label(l, w) { var c = catOf(l, w); return (c ? c.name + ' · ' : '') + impOf(w).n; }

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
      GC.photos.ingest([fs[0]]).then(function (refs) { GC.busy(null); sheet(refs[0]); }, function (e) { GC.busy(null); GC.toast(e.message, 'err'); });
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
  /** The quick sheet after a photo: name, category, importance, note. Closing it any other way than Discard saves. */
  function sheet(ref) {
    var l0 = layer(false), cs = cats(l0).map(function (c) { return Object.assign({}, c); }), last = null;
    try { last = localStorage.getItem(LAST); } catch (e) { /* private mode */ }
    var st = { cat: cs.some(function (c) { return c.id === last; }) ? last : cs[0].id, imp: 0, done: false };
    var timer = null;
    var save = function (el) {
      if (st.done) return null; st.done = true; clearInterval(timer);
      var l = layer(true), p = position(ref), c = cs.filter(function (x) { return x.id === st.cat; })[0];
      l.cats = cs;
      var n = l.waypoints.filter(function (w) { return w.cat === st.cat; }).length + 1;
      var name = el && el.querySelector('#cam-name').value.trim() || (c ? c.name : 'Photo') + ' ' + pad(n);
      var w = { lat: p.lat, lon: p.lon, ele: p.ele, acc: p.acc, time: Date.now(), name: name, note: el ? el.querySelector('#cam-note').value.trim() : '', photos: [ref], cat: st.cat, imp: st.imp };
      l.waypoints.push(w);
      try { localStorage.setItem(LAST, st.cat); } catch (e) { /* private mode */ }
      if (!l.visible) l.visible = true;
      GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id, true); GC.refreshLayers();
      if (!shown(l, w)) GC.toast('Saved, but the layer’s filter hides ' + label(l, w) + ' photos.', 'warn');
      else if (p.src === 'gps') GC.toast('“' + name + '” pinned at your GPS position (±' + Math.round(p.acc) + ' m).');
      else if (p.src === 'photo') GC.toast('“' + name + '” pinned where the photo was taken.');
      else GC.toast('No GPS fix yet, so “' + name + '” is at the map centre. Tap it › More › Move pin to put it in the right spot.', 'warn', 8000);
      return { l: l, w: w };
    };
    GC.modal('<div class="cam-sheet"><div class="cam-top"><div class="cam-thumb"><img alt=""></div><div class="cam-meta">' +
      '<input type="text" id="cam-name" placeholder="Name (automatic)" autocomplete="off"><div class="cam-loc" id="cam-loc"></div></div></div>' +
      '<div class="cam-lbl">Category</div><div class="cam-chips" id="cam-cats">' + chipsHtml(cs, st.cat) + '</div>' +
      '<div class="cam-lbl">Importance</div><div class="cam-imps" id="cam-imps">' + impHtml(st.imp) + '</div>' +
      '<textarea id="cam-note" rows="2" placeholder="Note (optional)"></textarea>' +
      '<div class="actions"><button class="btn" data-a="discard">Discard</button><span class="spacer"></span><button class="btn" data-a="again">Save + next photo</button><button class="btn primary" data-a="save">Save</button></div></div>',
    function (el, close) {
      GC.photos.url(ref.id).then(function (u) { if (u) el.querySelector('.cam-thumb img').src = u; });
      var loc = el.querySelector('#cam-loc');
      var paintLoc = function () {
        var p = position(ref);
        loc.className = 'cam-loc ' + (p.src === 'gps' ? (p.acc <= 10 ? 'good' : p.acc <= 30 ? 'fair' : 'poor') : p.src === 'photo' ? 'fair' : 'poor');
        loc.textContent = p.src === 'gps' ? 'Pin at your GPS position · ±' + Math.round(p.acc) + ' m' : p.src === 'photo' ? 'Pin where the photo was taken (its own location)' : 'Waiting for GPS… (if none comes, the pin goes at the map centre)';
      };
      paintLoc(); timer = setInterval(paintLoc, 800);
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
      el.querySelector('[data-a=discard]').onclick = function () { st.done = true; clearInterval(timer); close(); GC.toast('Photo discarded.'); };
      el.querySelector('[data-a=save]').onclick = function () { save(el); close(); };
      el.querySelector('[data-a=again]').onclick = function () { save(el); close(); capture(); };
    }, function () { clearInterval(timer); if (!st.done) save(null); }); // tapped outside: keep the photo
  }

  // ---------- on the tap card ----------
  /** Category and importance pickers for a photo point's card. */
  function cardBody(l, w, onChange) {
    var d = document.createElement('div'); d.className = 'cam-card';
    var ro = l.locked;
    d.innerHTML = '<label>Category<select data-k="cat"' + (ro ? ' disabled' : '') + '>' + cats(l).map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === (w.cat || 'gen') ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></label>' +
      '<label>Importance<select data-k="imp"' + (ro ? ' disabled' : '') + ' style="--ic:' + impOf(w).c + '">' + IMP.map(function (m, i) { return '<option value="' + i + '"' + (i === (w.imp | 0) ? ' selected' : '') + '>' + m.n + '</option>'; }).join('') + '</select></label>';
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
    return '<div class="cam-opts"><div class="cam-lbl">Show importance</div><select id="cam-min">' + IMP.map(function (m, i) { return '<option value="' + i + '"' + (i === (l.minImp | 0) ? ' selected' : '') + '>' + (i === 0 ? 'All' : i === 4 ? 'Critical only' : m.n + ' and above') + '</option>'; }).join('') + '</select>' +
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

  GC.camera = { capture: capture, layer: layer, icon: icon, shown: shown, isPhotoPt: isPhotoPt, label: label, cardBody: cardBody, catOf: catOf, impOf: impOf,
    optionsHtml: optionsHtml, bindOptions: bindOptions, IMP: IMP, CATS: CATS };
})(window);

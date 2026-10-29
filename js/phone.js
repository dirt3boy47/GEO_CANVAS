/* GeoCanvas web — iPhone layout, photos first.
   On narrow screens (phones, or an iPad app squeezed in Split View) the app switches to body.phone:
   a slim top bar, a bottom tab bar within thumb reach (Map · Photos · Camera · Layers · More), a "find me" button,
   and sheets that slide up from the bottom: the Photos list, Layers, More, tap cards, GPS, Measure and the Map panel.
   The Photos tab lists every photo point (biggest thumbnails first) sorted by importance, newest or nearest. */
(function (global) {
  'use strict';
  var GC = global.GC, map = GC.map, $ = GC.$, esc = GC.esc;
  var body = document.body, PHONE_W = 640;

  // ---------- markup ----------
  var bar = document.createElement('nav'); bar.id = 'phone-bar'; bar.className = 'panel';
  bar.innerHTML =
    '<button data-t="map" class="on"><svg><use xlink:href="#i-gps"/></svg><span>Map</span></button>' +
    '<button data-t="photos"><svg><use xlink:href="#i-photos"/></svg><span>Photos</span><i class="pb-n" hidden></i></button>' +
    '<button data-t="camera" class="pb-cam" aria-label="Take a photo"><svg><use xlink:href="#i-camera"/></svg></button>' +
    '<button data-t="layers"><svg><use xlink:href="#i-layers"/></svg><span>Layers</span></button>' +
    '<button data-t="more"><svg><use xlink:href="#i-more"/></svg><span>More</span></button>';
  document.body.appendChild(bar);
  var locate = document.createElement('button'); locate.id = 'phone-locate'; locate.className = 'panel'; locate.setAttribute('aria-label', 'Show my position');
  locate.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  document.body.appendChild(locate);
  var photos = document.createElement('section'); photos.id = 'phone-photos'; photos.className = 'phone-sheet'; photos.hidden = true;
  photos.innerHTML = '<div class="cs-grab"></div><div class="pp-head"><h2>Photos <small id="pp-count"></small></h2><button class="btn" id="pp-reg">Register</button><div class="seg small" id="pp-sort"><button data-s="imp" class="on">Importance</button><button data-s="new">Newest</button><button data-s="near">Nearest</button></div></div>' +
    '<div class="pp-chips" id="pp-filter"></div><div class="pp-grid" id="pp-grid"></div>';
  document.body.appendChild(photos);
  var more = document.createElement('section'); more.id = 'phone-more'; more.className = 'phone-sheet'; more.hidden = true;
  var M = [['import', 'i-import', 'Import a file'], ['mymaps', 'i-folder-open', 'My maps'], ['online', 'i-globe', 'Online maps'], ['map', 'i-layers', 'Background & offline'],
    ['measure', 'i-ruler', 'Measure'], ['gps', 'i-gps', 'GPS, tracks & waypoints'], ['search', 'i-search', 'Search'], ['export', 'i-export', 'Share / export'],
    ['projects', 'i-folder', 'Projects'], ['cloud', 'i-cloud', 'Team & cloud'], ['help', 'i-help', 'Help'], ['settings', 'i-gear', 'Settings']];
  more.innerHTML = '<div class="cs-grab"></div><h2>More</h2><div class="pm-grid">' + M.map(function (m) { return '<button data-m="' + m[0] + '"><svg><use xlink:href="#' + m[1] + '"/></svg><span>' + m[2] + '</span></button>'; }).join('') + '</div>';
  document.body.appendChild(more);

  // ---------- phone or not ----------
  function isPhone() { return global.innerWidth <= PHONE_W; }
  function apply() {
    var on = isPhone();
    if (on === body.classList.contains('phone')) return;
    body.classList.toggle('phone', on);
    if (on) { if (GC.mode === 'draw' && GC.setMode) GC.setMode('nav'); body.classList.add('no-sidebar'); }
    tab('map');
    if (GC.closeInspector) GC.closeInspector();
    setTimeout(function () { map.invalidateSize(); }, 50);
  }
  global.addEventListener('resize', apply);

  // ---------- tabs ----------
  var cur = 'map';
  function closeSheets(except) {
    if (except !== 'photos') photos.hidden = true;
    if (except !== 'more') more.hidden = true;
    if (except !== 'layers') body.classList.add('no-sidebar');
    if (GC.ui) GC.ui.close();
    ['gps-panel'].forEach(function (id) { if ($(id) && except !== id) $(id).hidden = true; });
  }
  function tab(t) {
    if (t === cur && t !== 'map') t = 'map'; // tapping the open tab again closes it
    cur = t; closeSheets(t);
    if (t !== 'map' && GC.closeInspector) GC.closeInspector();
    if (t === 'photos') { photos.hidden = false; paint(); }
    else if (t === 'more') more.hidden = false;
    else if (t === 'layers') body.classList.remove('no-sidebar');
    [].forEach.call(bar.querySelectorAll('[data-t]'), function (b) { b.classList.toggle('on', b.getAttribute('data-t') === t); });
  }
  bar.addEventListener('click', function (e) {
    var b = e.target.closest('[data-t]'); if (!b) return;
    var t = b.getAttribute('data-t');
    if (t === 'camera') { tab('map'); if (GC.camera) GC.camera.capture(); return; } // straight to the camera, inside the tap
    tab(t);
  });
  // a card, the GPS panel or measuring opening on the map means we are back on the Map tab
  document.addEventListener('click', function (e) {
    if (!body.classList.contains('phone')) return;
    if (e.target.closest && e.target.closest('#map') && cur !== 'map') tab('map');
  }, true);

  // ---------- More ----------
  more.addEventListener('click', function (e) {
    var b = e.target.closest('[data-m]'); if (!b) return;
    var m = b.getAttribute('data-m'); tab('map');
    var click = function (id) { var el = $(id); if (el) el.click(); };
    if (m === 'import') click('btn-import');
    else if (m === 'mymaps') click('am-mymaps');
    else if (m === 'online') click('am-online');
    else if (m === 'map') { if (GC.ui) GC.ui.openMap(); }
    else click({ measure: 'btn-measure', gps: 'btn-gps', search: 'btn-search', export: 'btn-export', projects: 'btn-projects', cloud: 'btn-cloud', help: 'btn-help', settings: 'btn-settings' }[m]);
  });

  // ---------- find me ----------
  var finding = null;
  locate.onclick = function () {
    if (!GC.gps) return;
    GC.gps.start();
    var go = function (f) { map.setView([f.lat, f.lon], Math.max(map.getZoom(), 17)); };
    var f = GC.gps.fix();
    if (f && Date.now() - f.t < 30000) { go(f); return; }
    GC.toast('Finding your position…');
    clearInterval(finding); var t0 = Date.now();
    finding = setInterval(function () {
      var g = GC.gps.fix();
      if (g && g.t > t0 - 5000) { clearInterval(finding); go(g); }
      else if (Date.now() - t0 > 20000) { clearInterval(finding); GC.toast('No GPS position yet. Check that Location is allowed for Safari, and go outside.', 'warn', 7000); }
    }, 500);
  };

  // ---------- Photos tab ----------
  var sort = 'imp', filt = { min: 0, cat: null, todo: false };
  function all() {
    var out = [];
    if (!GC.project) return out;
    GC.project.layers.forEach(function (l) {
      if (l.kind !== 'waypoints') return;
      (l.waypoints || []).forEach(function (w) { if ((w.photos && w.photos.length) || (GC.camera && GC.camera.isPhotoPt(l, w))) out.push({ l: l, w: w }); });
    });
    return out;
  }
  function ago(t) {
    var s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
    return new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  }
  function paintCount() {
    var n = all().length, badge = bar.querySelector('.pb-n');
    badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n);
  }
  function paint() {
    var items = all(), cam = GC.camera, fix = GC.gps && GC.gps.fix();
    var me = fix && Date.now() - fix.t < 120000 ? [fix.lon, fix.lat] : null;
    // filter chips: importance, then the categories in use
    var cats = {}; items.forEach(function (x) { var c = cam && cam.catOf(x.l, x.w); if (c) cats[c.id] = c; });
    var chips = [[0, 'All'], [3, 'High +'], [4, 'Critical']].map(function (m) { return '<button data-min="' + m[0] + '" class="' + (filt.min === m[0] && !filt.cat && !filt.todo ? 'on' : '') + '">' + m[1] + '</button>'; }).join('') +
      '<button data-todo class="' + (filt.todo ? 'on' : '') + '">To check</button>' +
      Object.keys(cats).map(function (k) { return '<button data-cat="' + esc(k) + '" class="' + (filt.cat === k ? 'on' : '') + '">' + esc(cats[k].name) + '</button>'; }).join('');
    $('pp-filter').innerHTML = chips;
    var shown = items.filter(function (x) {
      if (filt.todo) return !x.w.chk;
      if (filt.cat) return (x.w.cat || 'gen') === filt.cat;
      return (x.w.imp | 0) >= filt.min;
    });
    shown.forEach(function (x) { x.d = me ? Geo.haversine(me, [x.w.lon, x.w.lat]) : null; });
    shown.sort(function (a, b) {
      if (sort === 'near' && me) return a.d - b.d;
      if (sort === 'imp') return ((b.w.imp | 0) - (a.w.imp | 0)) || (b.w.time - a.w.time);
      return b.w.time - a.w.time;
    });
    $('pp-count').textContent = shown.length === items.length ? String(items.length) : shown.length + ' of ' + items.length;
    var grid = $('pp-grid');
    if (!items.length) { grid.innerHTML = '<div class="pp-empty"><svg><use xlink:href="#i-camera"/></svg><b>No photos yet</b><span>Tap the camera button: the photo is pinned where you stand.</span></div>'; return; }
    if (!shown.length) { grid.innerHTML = '<div class="pp-empty"><b>Nothing matches</b><span>Tap “All” to see every photo.</span></div>'; return; }
    grid.innerHTML = shown.map(function (x, i) {
      var imp = cam ? cam.impOf(x.w) : { n: '', c: '#6b7280' }, c = cam && cam.catOf(x.l, x.w), photo = x.w.photos && x.w.photos[0];
      return '<button class="pp-tile" data-i="' + i + '" style="--ic:' + imp.c + '"><div class="pp-img">' + (photo ? '<img data-ph="' + esc(photo.id) + '" alt="">' : '') +
        (cam && cam.isPhotoPt(x.l, x.w) ? '<span class="pp-imp">' + esc(imp.n) + '</span>' : '') + (x.w.photos && x.w.photos.length > 1 ? '<span class="pp-more">' + x.w.photos.length + '</span>' : '') + (x.w.chk ? '<span class="pp-chk" title="' + esc(cam.checkedText(x.w)) + '">✓</span>' : '') + '</div>' +
        '<b>' + esc(x.w.name || 'Photo') + '</b><small>' + esc((c ? c.name + ' · ' : '') + ago(x.w.time) + (x.d != null ? ' · ' + (x.d < 3 ? 'here' : GC.fmtDist(x.d)) : '')) + '</small></button>';
    }).join('');
    [].forEach.call(grid.querySelectorAll('img[data-ph]'), function (im) { GC.photos.url(im.getAttribute('data-ph')).then(function (u) { if (u) im.src = u; }); });
    [].forEach.call(grid.querySelectorAll('.pp-tile'), function (t) {
      t.onclick = function () {
        var x = shown[+t.getAttribute('data-i')]; tab('map');
        map.setView([x.w.lat, x.w.lon], Math.max(map.getZoom(), 18), { animate: false });
        GC.inspectWaypoint(x.l, x.w);
      };
    });
  }
  $('pp-reg').onclick = function () { tab('map'); if (GC.register) GC.register.open(); };
  $('pp-sort').addEventListener('click', function (e) {
    var b = e.target.closest('[data-s]'); if (!b) return;
    sort = b.getAttribute('data-s');
    if (sort === 'near' && !(GC.gps && GC.gps.fix())) { if (GC.gps) GC.gps.start(); GC.toast('Finding your position to sort by distance…'); setTimeout(paint, 3000); }
    [].forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); });
    paint();
  });
  $('pp-filter').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-todo')) { filt.todo = !filt.todo; filt.cat = null; filt.min = 0; }
    else if (b.hasAttribute('data-cat')) { var k = b.getAttribute('data-cat'); filt.cat = filt.cat === k ? null : k; filt.min = 0; filt.todo = false; }
    else { filt.min = +b.getAttribute('data-min'); filt.cat = null; filt.todo = false; }
    paint();
  });
  // keep the list and badge current as photos are added, edited or synced
  var origRender = GC.renderLayer;
  GC.renderLayer = function (l) {
    var r = origRender.apply(this, arguments);
    if (l && l.kind === 'waypoints') { paintCount(); if (!photos.hidden) paint(); }
    return r;
  };
  var origRefresh = GC.refreshLayers;
  GC.refreshLayers = function () { var r = origRefresh.apply(this, arguments); paintCount(); return r; };

  // swipe a sheet down to close it
  [photos, more].forEach(function (s) {
    var y0 = null;
    s.addEventListener('touchstart', function (e) { y0 = s.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    s.addEventListener('touchend', function (e) { if (y0 != null && e.changedTouches[0].clientY - y0 > 70) tab('map'); y0 = null; }, { passive: true });
  });

  apply();
  GC.phone = { isOn: function () { return body.classList.contains('phone'); }, tab: tab, paint: paint };
})(window);

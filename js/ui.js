/* GeoCanvas web — top bar menus and Help: the Add menu (import, My maps, online maps, new drawing layer), the Map panel
   (background map, lot boundaries, darken imagery, offline maps), the Help sheet with the offline/online flow chart,
   and the welcome screen. The features themselves live in their own modules; this only arranges how they are reached. */
(function (global) {
  'use strict';
  var GC = global.GC, $ = GC.$, esc = GC.esc;

  // ---------- popovers anchored to top-bar buttons ----------
  var open = null;
  function show(panel, btn) {
    if (open && open.panel === panel) { hide(); return; }
    hide();
    if (GC.closePops) GC.closePops();
    panel.hidden = false; btn.classList.add('on'); btn.setAttribute('aria-expanded', 'true');
    var r = btn.getBoundingClientRect(), w = panel.offsetWidth;
    panel.style.top = (r.bottom + 10) + 'px';
    panel.style.left = Math.max(10, Math.min(global.innerWidth - w - 10, r.right - w)) + 'px';
    open = { panel: panel, btn: btn };
  }
  function hide() {
    if (!open) return;
    open.panel.hidden = true; open.btn.classList.remove('on'); open.btn.setAttribute('aria-expanded', 'false'); open = null;
  }
  document.addEventListener('pointerdown', function (e) {
    if (open && !open.panel.contains(e.target) && !open.btn.contains(e.target)) hide();
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  global.addEventListener('resize', hide);

  // ---------- Add ----------
  var add = $('add-menu');
  $('btn-add').onclick = function () { show(add, $('btn-add')); };
  [].forEach.call(add.querySelectorAll('.menu-row'), function (b) { b.addEventListener('click', hide); });
  $('am-mymaps').onclick = function () { if (GC.mymaps) GC.mymaps.open(); };
  $('am-online').onclick = function () { if (GC.library) GC.library.open(); };
  $('am-layer').onclick = function () { $('btn-add-layer').click(); };

  // ---------- Map ----------
  var mp = $('map-panel');
  var LOOKS = { qld: 'aerial', qldroads: 'aerial roads', esri: 'aerial dark', esriroads: 'aerial dark roads', osm: 'street', topo: 'topo', none: 'none' };
  var SHORT = { qld: 'QLD aerial', qldroads: 'QLD aerial + roads', esri: 'World imagery', esriroads: 'World imagery + roads', osm: 'Street map', topo: 'Topographic', none: 'None' };
  function renderCards() {
    var cur = $('basemap').value;
    $('bm-grid').innerHTML = Object.keys(GC.BASEMAPS).map(function (k) {
      return '<button class="bm-card' + (k === cur ? ' on' : '') + '" data-k="' + esc(k) + '" aria-pressed="' + (k === cur) + '"><i class="bm-pv ' + esc(LOOKS[k] || '') + '"></i><span>' + esc(SHORT[k] || GC.BASEMAPS[k].label) + '</span>' +
        (/^qld/.test(k) ? '<em>saves offline</em>' : '') + '</button>';
    }).join('');
    [].forEach.call($('bm-grid').querySelectorAll('.bm-card'), function (b) { b.onclick = function () { GC.setBasemap(b.getAttribute('data-k')); renderCards(); }; });
  }
  var origSet = GC.setBasemap;
  GC.setBasemap = function (key, opts) { origSet(key, opts); if (!mp.hidden) renderCards(); };
  function mb(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB'; }
  function refreshMap() {
    renderCards();
    $('mp-dim').checked = !!GC.settings.dimImagery;
    var areas = GC.offline ? GC.offline.areas() : [], bytes = 0;
    areas.forEach(function (a) { bytes += a.bytes || 0; });
    $('mp-off-status').textContent = areas.length ? areas.length + (areas.length === 1 ? ' area' : ' areas') + ' saved on this device · ' + mb(bytes) : 'Save areas of imagery to use without signal';
  }
  $('btn-map').onclick = function () { refreshMap(); show(mp, $('btn-map')); };
  $('mp-close').onclick = hide;
  $('mp-dim').onchange = function () { GC.settings.dimImagery = $('mp-dim').checked; GC.saveSettings(); GC.applyDim(); };
  $('btn-offline').addEventListener('click', hide);

  // ---------- Help ----------
  var FLOW = '' +
    '<div class="hf-legend"><span><i class="hf-sw dev"></i>On the iPad</span><span><i class="hf-sw cld"></i>In the team cloud</span><span><i class="hf-sw wrn"></i>Needs attention</span></div>' +
    flow('Your edits', 'Drawings, placemarks, notes, measurements, GPS tracks and photos.', [
      ['start', 'You change something'], ['dev', 'Saved on the iPad straight away', 'Nothing is lost if the signal drops or the app closes'],
      ['q', 'Internet?', [
        ['Yes', [['cld', 'Sent to the cloud about 2 seconds later', '☁ green dot: Saved'], ['cld', 'Other devices pick it up', 'Within about 15 seconds while the project is open']]],
        ['No', [['wrn', 'Kept on the iPad, marked Offline', '☁ orange dot: changes waiting'], ['dev', 'Signal comes back', 'Uploads by itself, nothing to press'], ['cld', 'Merged with the team’s changes', 'Everyone’s edits are kept']]]
      ]]
    ], 'Two people editing the same project offline is fine: GeoCanvas merges the work item by item instead of overwriting one copy with the other.') +
    flow('Map sheets in My maps', 'GeoPDF topo sheets, placed plans, GeoTIFFs and online maps.', [
      ['start', 'Someone adds a map'], ['dev', 'Kept on their iPad'], ['cld', 'Uploaded to the team cloud once', 'Every device now lists it in My maps'],
      ['q', 'Downloaded on this iPad?', [
        ['Yes · 📱', [['dev', 'Shows anywhere, signal or not'], ['dev', 'Remove from this device when done', 'The cloud copy stays']]],
        ['No · ☁', [['q', 'Internet?', [
          ['Yes', [['cld', 'Shown from the cloud', 'Overview zoomed out; only the parts on screen zoomed in']]],
          ['No', [['wrn', 'Can’t be shown', 'A message suggests downloading it']]]
        ]]]]
      ]]
    ], 'Download one map with ⬇ on its row in My maps, or a whole folder with its ⋯ › Download all.') +
    flow('Background imagery', 'The aerial photo and lot boundaries under everything. They stream from Queensland Government servers.', [
      ['start', 'The map is moved or zoomed'],
      ['q', 'Inside a saved Offline maps area?', [
        ['Yes', [['dev', 'Drawn from the iPad', 'QLD imagery, lot boundaries and any online maps you included'], ['dev', 'Zoomed past the saved detail?', 'The saved imagery is enlarged instead of going blank']]],
        ['No', [['q', 'Internet?', [
          ['Yes', [['cld', 'Loaded from the internet']]],
          ['No', [['wrn', 'Blank background', 'Your project and downloaded sheets still show']]]
        ]]]]
      ]]
    ], 'With no signal the background switches to your saved QLD imagery by itself, and back when you’re online. Esri and street maps can’t be saved offline.') +
    '<div class="hp-card"><h3>Before heading out of coverage</h3><ol class="hp-steps">' +
    '<li><b>Add GeoCanvas to the Home Screen</b><small>Share › Add to Home Screen. iOS can clear saved data for websites left unused for a while.</small></li>' +
    '<li><b>Open the project you’ll work in</b><small>Check the ☁ button has a green dot.</small></li>' +
    '<li><b>Download the map sheets you need</b><small>My maps › ⬇ on each sheet, or a folder’s ⋯ › Download all. Look for 📱 On this device.</small></li>' +
    '<li><b>Save the area’s imagery</b><small>Map › Offline maps › Select an area: drag a box, or draw freehand along the corridor.</small></li>' +
    '<li><b>Work as normal on site</b><small>Everything saves on the iPad and uploads when you’re back in signal.</small></li></ol></div>';
  function node(n) {
    if (n[0] === 'q') return '<div class="hf-q"><span>' + esc(n[1]) + '</span></div>' + branches(n[2]);
    return '<div class="hf-n ' + n[0] + '">' + esc(n[1]) + (n[2] ? '<small>' + esc(n[2]) + '</small>' : '') + '</div>';
  }
  function chain(list) { return list.map(node).join('<div class="hf-a"></div>'); }
  function branches(bs) { return '<div class="hf-br">' + bs.map(function (b) { return '<div class="hf-b"><span class="hf-tag">' + esc(b[0]) + '</span><div class="hf-a"></div>' + chain(b[1]) + '</div>'; }).join('') + '</div>'; }
  function flow(title, sub, list, note) { return '<div class="hp-card"><h3>' + esc(title) + '</h3><p class="hint">' + esc(sub) + '</p><div class="hf">' + chain(list) + '</div>' + (note ? '<p class="hint hf-note">' + esc(note) + '</p>' : '') + '</div>'; }

  function tool(icon, name, text) { return '<div class="hp-tool"><span class="hp-ico"><svg><use xlink:href="#' + icon + '"/></svg></span><div><b>' + name + '</b><span>' + text + '</span></div></div>'; }
  var TOOLS = '<div class="hp-tools">' +
    tool('i-sidebar', 'Layers', 'Show or hide the layers panel. ⋯ on a layer opens its options (opacity, look over the imagery, legend); drag ⠿ to reorder; ▸ opens folders; double-tap a layer or folder to zoom to it; tap a placemark for its details.') +
    tool('i-folder', 'Workspaces', 'In a team: the one shared team workspace (live: everyone’s changes appear as they happen) and your private jobs (offline, on this device, not live). Send to team merges a job into the team workspace. Not in a team: your projects on this device.') +
    tool('i-hand', 'Navigate / Draw', 'Navigate: drag and pinch with your fingers to move the map, tap things to see their details. Apple Pencil never moves the map, it only taps and draws. Draw: Apple Pencil writes, fingers still move the map; tools along the bottom.') +
    tool('i-plus', 'Add', 'Import a file (KML/KMZ, GeoPDF, shapefile, DXF, GeoTIFF, GPX, GeoJSON, PDF or photo plans), open My maps or Online maps, or start a new drawing layer.') +
    tool('i-layers', 'Map', 'Choose the background, turn on lot boundaries, darken the imagery, and save areas for offline use.') +
    tool('i-camera', 'Camera', 'Opens the camera; the photo is pinned at your GPS position. Pick a category (Defect, Safety… or your own) and an importance: pins are coloured Info → Critical. Filter them in the Photo points layer’s ⋯ options.') +
    tool('i-photos', 'Actions', 'The actions register: every photo, pin, waypoint and drawn area or line in one table with its category, importance, time and a ✓ to tick once it has been checked (who and when is recorded). Sort, filter (To check / Checked), edit in place; tick the first column to choose actions for a PDF photo report, a photo export or a CSV for Excel. + New action: photo, pin, area or line; or press and hold the map to pin a spot.') +
    tool('i-ruler', 'Measure', 'Lengths, areas and bearings; freehand traces a winding line. Points snap to lot corners and drawing corners.') +
    tool('i-search', 'Search', 'Your own data first (“PHW-AV-002”, “thrust block 13”) with a Go button, then places, coordinates (decimal, DMS or MGA) and lots (“3RP123456”).') +
    tool('i-gps', 'GPS', 'Your position, track recording and waypoints with photos.') +
    tool('i-export', 'Share', 'Export KML/KMZ, GeoJSON, GPX, GeoTIFF, PNG or a print view, or back up the project.') +
    tool('i-cloud', 'Account & teams', 'Sign in once on each device (iPad, iPhone, laptop): your teams and private jobs follow you. Join or create teams, switch between them, add a device with a 6-digit code. Owners and admins manage members. Green dot: saved. Blue: saving. Orange: offline with changes waiting. Red: a problem (tap for details).') +
    '</div>';
  var START = '<ol class="hp-steps hp-start">' +
    '<li><b>Move around and look</b><small>In <b>Navigate</b>, drag and pinch. Tap a pipe, valve or lot for its card: <b>Go</b> guides you there from your GPS position, plus Measure, Photo, Note and Copy coordinates.</small></li>' +
    '<li><b>Bring in your maps and data</b><small><b>Add</b> imports KMZ, shapefiles, GeoPDF topo sheets, DXF and plans. Topo sheets go into <b>My maps</b>, shared with the team.</small></li>' +
    '<li><b>Photograph what you find</b><small>Tap <b>Camera</b>, take the photo, pick a category and importance: it is pinned where you stand, coloured by importance. On an iPhone the big camera button sits in the middle of the bottom bar, and <b>Photos</b> lists them all.</small></li>' +
    '<li><b>Mark up the ground</b><small>Switch to <b>Draw</b> and write with Apple Pencil: notes stay pinned to the place. <b>Measure</b> gives lengths and areas.</small></li>' +
    '<li><b>Work with the team</b><small>Tap ☁ to join your team: projects and maps then save to the cloud by themselves and open on every device.</small></li>' +
    '<li><b>Going out of coverage?</b><small>Download your sheets in My maps and save the area under <b>Map › Offline maps</b>. See “Offline & online”.</small></li></ol>';
  var TABS = [['start', 'Quick start', START], ['offline', 'Offline & online', FLOW], ['tools', 'Tools', TOOLS]];
  function help(tab) {
    hide();
    tab = tab || 'start';
    GC.modal('<h2>Help</h2><div class="seg hp-tabs" role="tablist">' + TABS.map(function (t) { return '<button role="tab" data-t="' + t[0] + '"' + (t[0] === tab ? ' class="on"' : '') + '>' + t[1] + '</button>'; }).join('') + '</div>' +
      '<div class="hp-body" id="hp-body"></div><div class="actions"><button class="btn primary" data-a="done">Done</button></div>',
      function (el, close) {
        el.classList.add('wide');
        var body = el.querySelector('#hp-body');
        var go = function (t) { var x = TABS.filter(function (y) { return y[0] === t; })[0] || TABS[0]; body.innerHTML = x[2]; body.scrollTop = 0; [].forEach.call(el.querySelectorAll('.hp-tabs button'), function (b) { b.classList.toggle('on', b.getAttribute('data-t') === x[0]); }); };
        [].forEach.call(el.querySelectorAll('.hp-tabs button'), function (b) { b.onclick = function () { go(b.getAttribute('data-t')); }; });
        el.querySelector('[data-a=done]').onclick = close;
        go(tab);
      }, function () { $('modal').classList.remove('wide'); });
  }
  function welcome() {
    GC.modal('<h2>Welcome to GeoCanvas</h2><p class="sub">A field map for your iPad: your project data, topo sheets and Pencil notes on the ground, shared with the team and usable without signal.</p>' + START +
      '<div class="actions"><button class="btn" data-a="help">Open Help</button><button class="btn primary" data-a="ok">Start</button></div>',
      function (el, close) {
        el.querySelector('[data-a=ok]').onclick = close;
        el.querySelector('[data-a=help]').onclick = function () { close(); help('start'); };
      });
  }
  $('btn-help').onclick = function () { help(); };
  $('layers-help').onclick = function (e) { e.preventDefault(); help('tools'); };

  GC.help = { open: help, welcome: welcome };
  GC.ui = { openAdd: function () { show(add, $('btn-add')); }, openMap: function () { refreshMap(); show(mp, $('btn-map')); }, close: hide };
})(window);

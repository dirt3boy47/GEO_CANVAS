/* GeoCanvas web — Map library: browse and search the public map services of Geoscience Australia and the Queensland
   Government (geology, topography, mineral tenements…), add one to the project as a layer (with legend and tap-to-identify),
   and save it for offline use with Offline maps. Any other ArcGIS server works too: paste its address (a MapServer,
   one of its layers, a FeatureServer, a folder or the whole server) into the search box. A service layer's features
   in view can be copied into a GIS layer (tappable, offline, exportable). The catalogues are read live from the agencies' ArcGIS servers, so
   new maps appear by themselves. Services are licensed by their publishers (mostly CC BY 4.0); see each map's details. */
(function (global) {
  'use strict';
  var GC = global.GC, map = GC.map, $ = GC.$, esc = GC.esc;
  var ROOTS = [
    { id: 'ga', name: 'Geoscience Australia', url: 'https://services.ga.gov.au/gis/rest/services' },
    { id: 'qld', name: 'Queensland Government', url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services', start: 'GeoscientificInformation' }
  ];
  var FEATURED = [
    { url: 'https://services.ga.gov.au/gis/rest/services/GA_Surface_Geology/MapServer', title: 'Surface geology of Australia', note: 'Geoscience Australia · bedrock and surficial geology, 1:1M and 1:2.5M' },
    { url: 'https://services.ga.gov.au/gis/rest/services/Topographic_Base_Map/MapServer', title: 'Topographic base map', note: 'Geoscience Australia · national topographic map (250K specification)' },
    { url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/GeoscientificInformation/GeologyDetailed/MapServer', title: 'Queensland detailed geology', note: 'Geological Survey of Queensland · 1:100K mapping and field sites' },
    { url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/GeoscientificInformation/GeologyRegional/MapServer', title: 'Queensland regional geology', note: 'Geological Survey of Queensland · 1:500K and 1:1M' },
    { url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/GeoscientificInformation/GeologyState/MapServer', title: 'Queensland geology, whole of state', note: 'Geological Survey of Queensland · 1:2M, faults and folds' },
    { url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Economy/MineralTenement/MapServer', title: 'Queensland mineral tenements', note: 'Geological Survey of Queensland · permits and applications' }
  ];
  var EXPORT_MAX = 17;   // drawn-on-request services: enlarged beyond this zoom (keeps offline downloads small)
  var IDX_KEY = 'gc.libindex', IDX_DAYS = 7;

  // ---------- talking to ArcGIS servers (fetch; JSONP when the browser blocks it) ----------
  function jsonp(url) {
    return new Promise(function (res, rej) {
      var cb = 'gcLib' + Math.random().toString(36).slice(2), s = document.createElement('script');
      var done = function () { clearTimeout(t); try { delete global[cb]; } catch (e) { global[cb] = undefined; } if (s.parentNode) s.parentNode.removeChild(s); };
      var t = setTimeout(function () { done(); rej(new Error('The map server did not answer.')); }, 20000);
      global[cb] = function (d) { done(); res(d); };
      s.onerror = function () { done(); rej(new Error('The map server could not be reached.')); };
      s.src = url + (url.indexOf('?') < 0 ? '?' : '&') + 'callback=' + cb; document.head.appendChild(s);
    });
  }
  var cache = {};
  function getJSON(url) {
    url += (url.indexOf('?') < 0 ? '?' : '&') + 'f=json';
    if (cache[url]) return cache[url];
    var p = fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).catch(function () { return jsonp(url); })
      .then(function (d) { if (d && d.error) throw new Error(d.error.message || 'The map server returned an error.'); return d; });
    cache[url] = p; p.catch(function () { delete cache[url]; });
    return p;
  }
  function pretty(name) { return String(name).split('/').pop().replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'); }
  function rootOf(url) { return ROOTS.filter(function (r) { return url.indexOf(r.url) === 0; })[0] || { name: (url.match(/^https?:\/\/([^/]+)/) || [])[1] || 'Map server' }; }

  // ---------- a service as a project layer ----------
  var WEB = { 102100: 1, 102113: 1, 3857: 1, 900913: 1 };
  function webTiles(info) {
    var t = info.tileInfo; if (!info.singleFusedMapCache || !t || !t.lods || !t.lods.length) return null;
    var sr = t.spatialReference || {}; if (!WEB[sr.latestWkid] && !WEB[sr.wkid]) return null;
    var ok = t.lods.every(function (l) { return Math.abs(Math.log(156543.03392804097 / l.resolution) / Math.LN2 - l.level) < 0.02; });
    return ok && (t.rows || 256) === 256 ? t.lods[t.lods.length - 1].level : null;
  }
  function boundsOf(info) {
    var e = info.fullExtent || info.extent || info.initialExtent; if (!e || !isFinite(e.xmin)) return null;
    var sr = e.spatialReference || {}, w = sr.latestWkid || sr.wkid, a, b;
    if (WEB[w]) { a = L.CRS.EPSG3857.unproject(L.point(e.xmin, e.ymin)); b = L.CRS.EPSG3857.unproject(L.point(e.xmax, e.ymax)); }
    else if (w === 4326 || w === 4283 || w === 7844 || w === 4202) { a = L.latLng(e.ymin, e.xmin); b = L.latLng(e.ymax, e.xmax); }
    else if (global.Geo && Geo.CRS[w]) { // a projected service (council maps are often in MGA): convert its corners
      try { var p1 = Geo.toWGS84(w, [e.xmin, e.ymin]), p2 = Geo.toWGS84(w, [e.xmax, e.ymax]); a = L.latLng(p1[1], p1[0]); b = L.latLng(p2[1], p2[0]); } catch (er) { return null; }
      if (!isFinite(a.lat) || !isFinite(b.lat)) return null;
    }
    else return null;
    return [[+a.lat.toFixed(5), +a.lng.toFixed(5)], [+b.lat.toFixed(5), +b.lng.toFixed(5)]];
  }
  function strip(html) { var d = document.createElement('div'); d.innerHTML = String(html || ''); return (d.textContent || '').replace(/\s+/g, ' ').trim(); }
  /** Builds the project layer for a service from its JSON description. */
  function layerFor(url, info, title) {
    var image = /\/ImageServer$/.test(url), z = webTiles(info);
    var subs = (info.layers || []).slice(0, 300).map(function (s) { var o = { id: s.id, name: s.name, parent: s.parentLayerId == null ? -1 : s.parentLayerId, group: !!(s.subLayerIds && s.subLayerIds.length), on: s.defaultVisibility !== false }; if (s.type && !/feature/i.test(s.type)) o.raster = true; return o; });
    return { id: global.Ink.uid(), name: title || (info.documentInfo && info.documentInfo.Title) || info.mapName || pretty(url.replace(/\/(Map|Image)Server$/, '')),
      kind: 'service', visible: true, opacity: 0.75, locked: true, format: image ? 'Image service' : 'Map service',
      service: { url: url, image: image, tiled: z != null, maxNative: z != null ? z : EXPORT_MAX, show: null, subs: subs,
        source: rootOf(url).name, copyright: strip(info.copyrightText).slice(0, 300), about: strip(info.serviceDescription || info.description).slice(0, 600) },
      identify: !image && z == null, bounds: boundsOf(info), created: Date.now() };
  }
  /** The tile URL for a service descriptor at z/x/y (the same string when viewing and when saving offline). */
  function tileUrl(s, z, x, y) {
    if (s.tiled) return s.url + '/tile/' + z + '/' + y + '/' + x;
    var half = 20037508.342789244, size = 2 * half / Math.pow(2, z);
    var bbox = [-half + x * size, half - (y + 1) * size, -half + (x + 1) * size, half - y * size].map(function (v) { return v.toFixed(2); }).join(',');
    return s.url + (s.image ? '/exportImage?bbox=' + bbox + '&bboxSR=3857&imageSR=3857&size=512,512&format=png&f=image'
      : '/export?bbox=' + bbox + '&bboxSR=3857&imageSR=3857&size=512,512&dpi=192&format=png32&transparent=true' + (s.show ? '&layers=show:' + s.show.join(',') : '') + '&f=image');
  }
  var Tiles = L.TileLayer.extend({ getTileUrl: function (c) { return tileUrl(this._gcService, c.z, c.x, c.y); } });
  function tileLayer(l, pane) {
    var t = new Tiles('', { pane: pane, tileSize: 256, maxZoom: 22, maxNativeZoom: l.service.maxNative, minZoom: 3, keepBuffer: 2, updateWhenZooming: false,
      attribution: esc(l.service.copyright || l.service.source) });
    t._gcService = l.service;
    t.on('tileerror', function (e) { whyNot(l, e.tile && e.tile.src); });
    return t;
  }
  /** A map service's images did not load: ask the server why (once a minute at most) and say so. */
  var told = {};
  function whyNot(l, src) {
    if (!src || navigator.onLine === false || Date.now() - (told[l.id] || 0) < 60000) return;
    told[l.id] = Date.now();
    var many = l.service.show && l.service.show.length > 40;
    var say = function (why) { GC.toast('“' + l.name + '” did not draw: ' + why + (many ? ' ' + l.service.show.length + ' of its layers are switched on: switch some off, or ⋯ › Default layers.' : ' ⋯ › Default layers puts it back as published.'), 'warn', 10000); };
    getJSON(src.replace(/&f=image$/, '')).then(function (d) { if (!d || !d.href) say('its server sent no map image.'); }, function (e) { say(/could not be reached|did not answer/.test(e.message) ? 'its server is not answering (it may be busy or down).' : 'its server says “' + e.message + '”.'); });
  }
  /** The project's visible service layers, as descriptors for Offline maps. */
  function visibleServices() {
    return (GC.project ? GC.project.layers : []).filter(function (l) { return l.kind === 'service' && l.visible; })
      .map(function (l) { return { name: l.name, url: l.service.url, image: l.service.image, tiled: l.service.tiled, maxNative: l.service.maxNative, show: l.service.show }; });
  }

  // ---------- tap the map: what is here? ----------
  var hl = null;
  function identify(ll) {
    var ls = (GC.project ? GC.project.layers : []).filter(function (l) { return l.kind === 'service' && l.visible && l.identify && !l.service.image; });
    if (!ls.length) return false;
    var b = map.getBounds(), sz = map.getSize();
    var q = '/identify?geometry=' + ll.lng.toFixed(7) + ',' + ll.lat.toFixed(7) + '&geometryType=esriGeometryPoint&sr=4326&tolerance=4&returnGeometry=false' +
      '&mapExtent=' + [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(function (v) { return v.toFixed(6); }).join(',') + '&imageDisplay=' + sz.x + ',' + sz.y + ',96';
    var card = GC.card.open({ ll: ll, title: 'What’s here', sub: ls.map(function (l) { return l.name; }).join(' · '), body: '<p class="lib-sub">Looking it up…</p>', at: [ll.lng, ll.lat] });
    Promise.all(ls.map(function (l) {
      var s = l.service, which = s.show ? 'visible:' + s.show.join(',') : 'visible';
      return getJSON(s.url + q + '&layers=' + which).then(function (d) { return { l: l, r: (d.results || []).slice(0, 6) }; }, function () { return { l: l, r: [], err: true }; });
    })).then(function (all) {
      var skip = /^(objectid|fid|shape.*|st_area.*|st_length.*|globalid|se_anno.*)$/i, html = '', n = 0;
      all.forEach(function (a) {
        a.r.forEach(function (r) {
          n++;
          var at = r.attributes || {}, rows = Object.keys(at).filter(function (k) { return !skip.test(k) && at[k] != null && at[k] !== '' && at[k] !== 'Null' && at[k] !== ' '; });
          html += '<div class="gb-title">' + esc(r.value != null && r.value !== '' ? r.value : r.layerName) + '</div><div class="lib-sub">' + esc(r.layerName) + ' · ' + esc(a.l.name) + '</div>' +
            '<table class="gb-data">' + rows.slice(0, 24).map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + esc(String(at[k])) + '</td></tr>'; }).join('') + '</table>';
        });
      });
      if (!n) {
        if (GC.cadastre && GC.cadastre.on()) { GC.card.close(); GC.cadastre.identify(ll); return; }
        html = '<div class="gb-title">Nothing mapped here</div><p class="lib-sub">' + (all.some(function (a) { return a.err; }) ? 'The map service could not be reached (it needs an internet connection).' : 'No features of the visible map services at this spot.') + '</p>';
      }
      if (GC.card.current() !== card) return; // closed or replaced meanwhile
      var first = null; all.some(function (x) { if (x.r.length) { first = x.r[0]; return true; } return false; });
      if (first) card.spec.name = String(first.value != null && first.value !== '' ? first.value : first.layerName);
      card.root.querySelector('.gc-body').innerHTML = '<div class="lib-ident">' + html + '</div>'; card.refit();
    });
    return true;
  }

  // ---------- legend and layer options ----------
  /** "Planning Scheme › Zones › Zone": a sublayer with the groups it sits in. */
  function pathOf(s, x) { var names = [x.name], p = x.parent, d = 0; while (p !== -1 && d++ < 8) { var q = byId(s, p); if (!q) break; names.unshift(q.name); p = q.parent; } return names.join(' › '); }
  function byId(s, id) { for (var i = 0; i < s.subs.length; i++) if (s.subs[i].id === id) return s.subs[i]; return null; }
  /** The layers the server draws by itself: on by default, and so is every group they are in. */
  function defaults(s) {
    return s.subs.filter(function (x) { if (x.group || !x.on) return false; var p = x.parent, d = 0; while (p !== -1 && d++ < 10) { var g = byId(s, p); if (!g) break; if (!g.on) return false; p = g.parent; } return true; }).map(function (x) { return x.id; });
  }
  function leaves(s) { return (s.subs || []).filter(function (x) { return !x.group && !x.raster; }); }
  var copyPick = null;
  function optionsHtml(l) {
    copyPick = null;
    var s = l.service, shown = s.show ? s.show : s.subs.filter(function (x) { return x.on && !x.group; }).map(function (x) { return x.id; });
    var many = s.subs.length > 8;
    return (s.about ? '<p class="hint">' + esc(s.about) + '</p>' : '') +
      (!s.image && s.subs.length ? '<div class="pop-title small">Layers in this map <small id="st-count"></small></div>' +
        '<div class="st-tools">' + (many ? '<input type="search" id="st-q" placeholder="Find a layer…" autocomplete="off"><button class="btn" id="st-on">On only</button><button class="btn" id="st-none">All off</button>' : '') + '<button class="btn" id="st-def" title="The layers the map shows as published">Default layers</button></div>' +
        '<div class="lib-subs st-tree" id="st-tree"></div>' : '') +
      (s.image ? '' : '<label class="opt"><input type="checkbox" id="lo-ident"' + (l.identify ? ' checked' : '') + '> Tap the map to see what’s here (zone, overlay, rock unit, tenement…)</label>') +
      (s.image || !leaves(s).length ? '' : '<div class="pop-title small">Copy features to a GIS layer</div><div class="lib-copy"><select id="lib-fl">' + leaves(s).map(function (x) { return '<option value="' + x.id + '"' + (shown.indexOf(x.id) >= 0 && !copyPick ? (copyPick = ' selected') : '') + '>' + esc(pathOf(s, x)) + '</option>'; }).join('') + '</select>' +
        '<button class="btn" id="lib-copy">Copy features in view</button></div><p class="hint">Makes a GIS layer of that layer’s features on screen now: tap them, use them offline, export them or run Parcels along.</p>') +
      '<div class="pop-title small">Legend</div><div id="lo-legend" class="lib-legend"><p class="hint">Loading…</p></div>' +
      '<p class="hint">Source: ' + esc(s.source) + (s.copyright ? ' · ' + esc(s.copyright) : '') + '<br><a href="' + esc(s.url) + '" target="_blank" rel="noopener">Service details</a></p>';
  }
  /** The service's layers as a tree like ArcGIS's layer list: groups fold, a group's box switches everything in it. */
  function tree(l, el) {
    var s = l.service, box = el.querySelector('#st-tree'); if (!box) return;
    var kids = {}, on = {}, leafSet = {};
    s.subs.forEach(function (x) { (kids[x.parent] = kids[x.parent] || []).push(x); });
    var roots = kids[-1] || s.subs.filter(function (x) { return !byId(s, x.parent); });
    var under = {}; // group id → its leaf ids
    var leavesOf = function (x) { if (under[x.id]) return under[x.id]; var r = []; (kids[x.id] || []).forEach(function (k) { if (k.group) r = r.concat(leavesOf(k)); else r.push(k.id); }); return (under[x.id] = r); };
    s.subs.forEach(function (x) { if (!x.group) leafSet[x.id] = 1; });
    (s.show ? s.show : defaults(s)).forEach(function (id) { on[id] = 1; });
    var key = function (x) { return 'svc:' + s.url + ':' + x.id; };
    var node = function (x, d) {
      var g = x.group, open = g && GC.isOpen(key(x), d === 0 && roots.length < 6);
      var h = '<div class="st-node' + (g ? ' st-g' : '') + '" data-id="' + x.id + '" data-d="' + d + '"><div class="st-row" style="--d:' + d + '">' +
        (g ? '<button class="st-tw' + (open ? ' open' : '') + '" data-tw aria-label="Open or fold">' + GC.icon('caret') + '</button>' : '<span class="st-sp"></span>') +
        '<label><input type="checkbox" data-sub="' + x.id + '"><span>' + esc(x.name) + '</span></label>' + (g ? '<small class="st-n"></small>' : '') + '</div>';
      if (g) h += '<div class="st-kids"' + (open ? '' : ' hidden') + '>' + (kids[x.id] || []).map(function (k) { return node(k, d + 1); }).join('') + '</div>';
      return h + '</div>';
    };
    box.innerHTML = roots.map(function (x) { return node(x, 0); }).join('');
    var sync = function () {
      var n = 0, tot = 0;
      [].forEach.call(box.querySelectorAll('input[data-sub]'), function (c) {
        var x = byId(s, +c.getAttribute('data-sub'));
        if (!x.group) { c.checked = !!on[x.id]; c.indeterminate = false; return; }
        var ls = leavesOf(x), k = ls.filter(function (id) { return on[id]; }).length;
        c.checked = ls.length > 0 && k === ls.length; c.indeterminate = k > 0 && k < ls.length;
        var sm = c.closest('.st-row').querySelector('.st-n'); if (sm) sm.textContent = k ? k + ' of ' + ls.length + ' on' : ls.length + ' layer' + (ls.length === 1 ? '' : 's');
      });
      Object.keys(leafSet).forEach(function (id) { tot++; if (on[id]) n++; });
      var cnt = el.querySelector('#st-count'); if (cnt) cnt.textContent = '· ' + n + ' of ' + tot + ' on';
    };
    var apply = function (reset) {
      s.show = s.subs.filter(function (x) { return !x.group && on[x.id]; }).map(function (x) { return x.id; });
      var def = defaults(s); if (reset || (s.show.length === def.length && s.show.every(function (id, i) { return id === def[i]; }))) s.show = null; // as published: let the server decide
      sync(); GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id); legend(l, el.querySelector('#lo-legend'));
    };
    box.addEventListener('change', function (e) {
      var c = e.target.closest('input[data-sub]'); if (!c) return;
      var x = byId(s, +c.getAttribute('data-sub'));
      if (x.group) { var ls = leavesOf(x), all = ls.every(function (id) { return on[id]; }); ls.forEach(function (id) { if (all) delete on[id]; else on[id] = 1; }); }
      else if (c.checked) on[x.id] = 1; else delete on[x.id];
      apply();
    });
    box.addEventListener('click', function (e) {
      var t = e.target.closest('[data-tw]'); if (!t) return;
      var nd = t.closest('.st-node'), k = nd.querySelector(':scope > .st-kids'), x = byId(s, +nd.getAttribute('data-id')), open = k.hidden;
      k.hidden = !open; t.classList.toggle('open', open); GC.setOpen(key(x), open);
    });
    var q = el.querySelector('#st-q'), onlyOn = false;
    var filter = function () {
      var t = q ? q.value.trim().toLowerCase() : '';
      var walk = function (nd, pm) { // pm: a group above matched the search. → whether this node shows
        var x = byId(s, +nd.getAttribute('data-id')), me = !!t && x.name.toLowerCase().indexOf(t) >= 0, kb = nd.querySelector(':scope > .st-kids'), any = false;
        if (kb) [].forEach.call(kb.children, function (k) { if (walk(k, pm || me)) any = true; });
        var show = !t && !onlyOn ? true : x.group ? any : (!t || me || pm) && (!onlyOn || !!on[x.id]);
        nd.hidden = !show;
        if (kb) {
          var open = t || onlyOn ? any : GC.isOpen(key(x), +nd.getAttribute('data-d') === 0 && roots.length < 6);
          kb.hidden = !open; nd.querySelector(':scope > .st-row [data-tw]').classList.toggle('open', open);
        }
        return show;
      };
      [].forEach.call(box.children, function (nd) { walk(nd, false); });
    };
    if (q) q.oninput = filter;
    var bOn = el.querySelector('#st-on'); if (bOn) bOn.onclick = function () { onlyOn = !onlyOn; bOn.classList.toggle('primary', onlyOn); filter(); };
    var bNone = el.querySelector('#st-none'); if (bNone) bNone.onclick = function () { on = {}; apply(); if (onlyOn) filter(); };
    var bDef = el.querySelector('#st-def'); if (bDef) bDef.onclick = function () { on = {}; defaults(s).forEach(function (id) { on[id] = 1; }); apply(true); filter(); GC.toast('Back to the layers “' + l.name + '” shows as published.'); };
    sync();
  }
  function bindOptions(l, el) {
    var s = l.service;
    tree(l, el);
    var id = el.querySelector('#lo-ident'); if (id) id.onchange = function () { l.identify = id.checked; GC.markDirty(l.id); };
    var cp = el.querySelector('#lib-copy'); if (cp) cp.onclick = function () { var sub = +el.querySelector('#lib-fl').value; GC.closeModal(); copyFeatures(l, sub); };
    legend(l, el.querySelector('#lo-legend'));
  }
  function legend(l, box) {
    var s = l.service;
    getJSON(s.url + '/legend').then(function (d) {
      var def = s.subs.filter(function (x) { return x.on && !x.group; }).map(function (x) { return x.id; });
      var shown = s.show || (def.length ? def : null), html = (d.layers || []).filter(function (x) { return !shown || shown.indexOf(x.layerId) >= 0; }).slice(0, 40).map(function (x) {
        return '<div class="lib-lgl">' + esc(x.layerName) + '</div>' + (x.legend || []).slice(0, 60).map(function (g) {
          return '<div class="lib-lg"><img alt="" src="data:' + esc(g.contentType || 'image/png') + ';base64,' + g.imageData + '"><span>' + esc(g.label || '') + '</span></div>';
        }).join('');
      }).join('');
      box.innerHTML = html || '<p class="hint">This map has no legend.</p>';
    }, function () { box.innerHTML = '<p class="hint">The legend needs an internet connection.</p>'; });
  }

  // ---------- a service layer's features → a GIS layer ----------
  /** Esri JSON features (points, multipoints, polylines, polygons) → GeoJSON. */
  function esriToGeoJSON(fs) {
    var polys = GC.cadastre ? GC.cadastre.esriToGeoJSON : null;
    return { type: 'FeatureCollection', features: (fs || []).map(function (f) {
      var g = f.geometry || {}, geom = null;
      if (g.x != null) geom = { type: 'Point', coordinates: [g.x, g.y] };
      else if (g.points) geom = { type: 'MultiPoint', coordinates: g.points };
      else if (g.paths) geom = g.paths.length === 1 ? { type: 'LineString', coordinates: g.paths[0] } : { type: 'MultiLineString', coordinates: g.paths };
      else if (g.rings && polys) geom = polys([f]).features[0].geometry;
      return { type: 'Feature', properties: f.attributes || {}, geometry: geom };
    }).filter(function (f) { return f.geometry; }) };
  }
  function queryLayer(url, params) {
    var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&'), base = url + '/query?' + qs;
    var viaJsonp = function () { return jsonp(base + '&f=json').then(function (d) { if (d.error) throw new Error(d.error.message || 'The query failed.'); var g = esriToGeoJSON(d.features); g.exceeded = !!d.exceededTransferLimit; return g; }); };
    return fetch(base + '&f=geojson').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (g) {
      if (g.error || !g.features) throw new Error('no GeoJSON');
      g.exceeded = !!(g.exceededTransferLimit || (g.properties && g.properties.exceededTransferLimit)); return g;
    }).catch(viaJsonp);
  }
  var NAMEY = /^(name|label|title|zone|zone_name|zone_desc|description|desc|precinct|overlay|category|class|type)$/i;
  /** Copies the features of one of a service's layers that are in view into a GIS layer of the project. */
  function copyFeatures(l, subId) {
    var s = l.service, sub = s.subs.filter(function (x) { return x.id === subId; })[0] || { name: 'Layer ' + subId }, b = map.getBounds();
    GC.busy('Copying “' + sub.name + '”…');
    return queryLayer(s.url + '/' + subId, { where: '1=1', geometry: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(function (v) { return v.toFixed(6); }).join(','), geometryType: 'esriGeometryEnvelope', inSR: 4326,
      spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: true, outSR: 4326, geometryPrecision: 7 }).then(function (g) {
      GC.busy(null);
      var fs = (g.features || []).filter(function (f) { return f.geometry; });
      if (!fs.length) { GC.toast('No features of “' + sub.name + '” in view. Move the map to where they are, or zoom out a little.', 'warn', 7000); return null; }
      var keys = Object.keys(fs[0].properties || {}), lab = keys.filter(function (k) { return NAMEY.test(k); })[0] || keys.filter(function (k) { return typeof fs[0].properties[k] === 'string' && !/^(objectid|globalid|shape)/i.test(k); })[0] || null;
      var nl = { id: global.Ink.uid(), name: sub.name + ' (' + l.name + ')', kind: 'vector', visible: true, opacity: 1, locked: true,
        geojson: { type: 'FeatureCollection', features: fs.map(function (f) { return { type: 'Feature', properties: f.properties || {}, geometry: f.geometry }; }) }, crs: 4326, format: 'ArcGIS',
        warnings: ['Copied from ' + s.source + ' (' + s.url + '/' + subId + ') on ' + new Date().toLocaleDateString('en-AU') + (s.copyright ? '. ' + s.copyright : '') + '.' + (g.exceeded ? ' The server returned only part of the features in view: zoom in and copy again for the rest.' : '')],
        style: { color: '#ff6d00', width: 2, fillOpacity: 0.2, useFileStyle: true }, labelField: lab, created: Date.now() };
      GC.insertLayer(nl, true);
      GC.toast('Copied ' + fs.length + ' feature' + (fs.length === 1 ? '' : 's') + ' of “' + sub.name + '” into the layer “' + nl.name + '”.' + (g.exceeded ? ' The server sent only part of them: zoom in and copy again for the rest.' : ''), g.exceeded ? 'warn' : null, 8000);
      return nl;
    }, function (e) { GC.busy(null); GC.toast('Could not copy the features: ' + e.message, 'err', 8000); return null; });
  }

  // ---------- any ArcGIS server, by its address ----------
  /** Reads a pasted ArcGIS address: { svc (MapServer/ImageServer url), sub (layer id) } or { rest (…/rest/services), path (folder) }. */
  function parseUrl(text) {
    var t = String(text || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!/^https?:\/\/\S+\/rest\/services/i.test(t)) return null;
    var rest = /^(.*?\/rest\/services)(?:\/|$)/i.exec(t)[1], tail = t.slice(rest.length).replace(/^\//, '');
    var m = /^(.+?)\/(MapServer|ImageServer|FeatureServer)(?:\/(\d+))?(?:\/|$)/i.exec(tail);
    if (m) return { svc: rest + '/' + m[1] + '/' + (/image/i.test(m[2]) ? 'ImageServer' : 'MapServer'), sub: m[3] != null ? +m[3] : null, feature: /feature/i.test(m[2]) };
    return { rest: rest, path: tail };
  }
  function hostOf(url) { return (url.match(/^https?:\/\/([^/]+)/) || [])[1] || 'Map server'; }

  // ---------- the library: featured, browse, search ----------
  var target = '';
  function addService(url, title, opt) {
    GC.busy('Adding the map…');
    return getJSON(url).then(function (info) {
      var l = layerFor(url, info, title);
      if (opt && opt.sub != null) { // one layer of the service: just that layer (and what is under it, for a group)
        var want = [opt.sub], grow = true;
        while (grow) { grow = false; l.service.subs.forEach(function (x) { if (want.indexOf(x.parent) >= 0 && want.indexOf(x.id) < 0) { want.push(x.id); grow = true; } }); }
        var lv = l.service.subs.filter(function (x) { return want.indexOf(x.id) >= 0 && !x.group; }).map(function (x) { return x.id; });
        if (lv.length) l.service.show = lv;
      }
      // saved in My maps (in the folder the library was opened from) and shown in this project
      return (GC.mymaps ? GC.mymaps.addMap(l, { folder: target }).then(function (r) { return r.layer; }) : Promise.resolve(GC.insertLayer(l, true)).then(function () { return l; })).then(function (pl) {
        GC.busy(null);
        if (pl && pl.bounds && !map.getBounds().intersects(L.latLngBounds(pl.bounds))) GC.zoomToLayer(pl);
        GC.toast('Added “' + l.name + '” to My maps' + (target ? ' › ' + target.replace(/\//g, ' › ') : '') + ' and this project.' + (l.identify ? ' Tap the map to see what’s there.' : ''), null, 6000);
      });
    }, function (e) { GC.busy(null); GC.toast('Could not open that map: ' + e.message, 'err', 8000); });
  }
  /** All services of both catalogues (names only), cached for a week. */
  function index() {
    try { var c = JSON.parse(localStorage.getItem(IDX_KEY)); if (c && Date.now() - c.t < IDX_DAYS * 864e5 && c.items.length) return Promise.resolve(c.items); } catch (e) { /* rebuild */ }
    var items = [];
    var take = function (root, d) { (d.services || []).forEach(function (s) { if (s.type === 'MapServer' || s.type === 'ImageServer') items.push({ r: root.id, n: s.name, t: s.type }); }); };
    return Promise.all(ROOTS.map(function (root) {
      return getJSON(root.url).then(function (d) {
        take(root, d);
        var folders = (d.folders || []).filter(function (f) { return !/^(Utilities|System)$/i.test(f); }), k = 0;
        var next = function () { if (k >= folders.length) return Promise.resolve(); var f = folders[k++]; return getJSON(root.url + '/' + f).then(function (fd) { take(root, fd); }, function () {}).then(next); };
        return Promise.all([next(), next(), next(), next()]);
      }, function () { /* that catalogue is unreachable: search the other */ });
    })).then(function () {
      if (items.length) try { localStorage.setItem(IDX_KEY, JSON.stringify({ t: Date.now(), items: items })); } catch (e) { /* full */ }
      return items;
    });
  }
  function serviceUrl(rootId, name, type) { var r = ROOTS.filter(function (x) { return x.id === rootId; })[0]; return r.url + '/' + name + '/' + type; }
  function row(url, title, note, added) {
    return '<div class="lib-row" data-url="' + esc(url) + '" data-title="' + esc(title) + '"><div class="lib-txt"><b>' + esc(title) + '</b><small>' + esc(note) + '</small></div>' +
      '<button class="btn' + (added ? '' : ' primary') + '" data-a="add"' + (added ? ' disabled' : '') + '>' + (added ? 'Added' : 'Add') + '</button></div>';
  }
  function inProject(url) { return (GC.project ? GC.project.layers : []).some(function (l) { return l.kind === 'service' && l.service.url === url; }); }

  function open(opts) {
    target = opts && opts.folder != null ? opts.folder : '';
    GC.modal('<h2>Online maps</h2><p class="sub">Free maps from Geoscience Australia and the Queensland Government: geology, topography, tenements and more, or paste the address of any ArcGIS map server (a council’s planning scheme, for example). <b>Add</b> saves the map in My maps' + (target ? ' › ' + esc(target.replace(/\//g, ' › ')) : '') + ' and shows it in this project.</p>' +
      '<input type="search" id="lib-q" placeholder="Search maps, or paste a map server address (…/MapServer)" autocomplete="off">' +
      '<div class="seg lib-tabs"><button data-t="featured" class="on">Featured</button><button data-t="ga">Geoscience Australia</button><button data-t="qld">Queensland</button></div>' +
      '<div id="lib-body" class="lib-body"></div>' +
      '<div class="actions"><button class="btn" data-a="back">‹ My maps</button><button class="btn primary" data-a="close">Done</button></div>',
      function (el, close) {
        var body = el.querySelector('#lib-body'), qbox = el.querySelector('#lib-q'), tab = 'featured', path = '';
        var wire = function () {
          [].forEach.call(body.querySelectorAll('.lib-row [data-a=add]'), function (b) {
            b.onclick = function () { var r = b.closest('.lib-row'); b.disabled = true; b.textContent = 'Adding…'; addService(r.getAttribute('data-url'), r.getAttribute('data-title')).then(function () { b.textContent = inProject(r.getAttribute('data-url')) ? 'Added' : 'Add'; b.disabled = inProject(r.getAttribute('data-url')); b.classList.remove('primary'); }); };
          });
          [].forEach.call(body.querySelectorAll('[data-folder]'), function (f) { f.onclick = function () { path = f.getAttribute('data-folder'); browse(); }; });
        };
        var featured = function () { body.innerHTML = '<div class="list">' + FEATURED.map(function (f) { return row(f.url, f.title, f.note, inProject(f.url)); }).join('') + '</div>'; wire(); };
        var browse = function () {
          var root = tab === 'url' ? other : ROOTS.filter(function (r) { return r.id === tab; })[0];
          body.innerHTML = '<p class="hint">Loading ' + esc(root.name) + '…</p>';
          getJSON(root.url + (path ? '/' + path : '')).then(function (d) {
            var crumbs = '<div class="lib-crumbs"><a data-folder="">' + esc(root.name) + '</a>' + (path ? ' › ' + esc(pretty(path)) : '') + '</div>';
            var folders = (d.folders || []).filter(function (f) { return !/^(Utilities|System)$/i.test(f); });
            var svcs = (d.services || []).filter(function (s) { return s.type === 'MapServer' || s.type === 'ImageServer'; });
            body.innerHTML = crumbs + '<div class="list">' + folders.map(function (f) { return '<div class="lib-row lib-folder" data-folder="' + esc(f) + '"><div class="lib-txt"><b>' + esc(pretty(f)) + '</b><small>Folder</small></div><span class="lib-go">›</span></div>'; }).join('') +
              svcs.map(function (s) { var u = root.url + '/' + s.name + '/' + s.type; return row(u, pretty(s.name), (s.type === 'ImageServer' ? 'Image service' : 'Map service') + (path ? '' : ''), inProject(u)); }).join('') + '</div>' +
              (!folders.length && !svcs.length ? '<p class="hint">No maps in this folder.</p>' : '');
            wire();
          }, function (e) { body.innerHTML = '<p class="hint fail">' + esc(root.name) + ' could not be reached (' + esc(e.message) + '). The library needs an internet connection.</p>'; });
        };
        var other = null; // another server, opened from a pasted address
        var byUrl = function (u) {
          if (u.svc) {
            body.innerHTML = '<p class="hint">Opening ' + esc(hostOf(u.svc)) + '…</p>';
            getJSON(u.svc).then(function (info) {
              var sub = u.sub != null ? (info.layers || []).filter(function (x) { return x.id === u.sub; })[0] : null;
              var title = (info.documentInfo && info.documentInfo.Title) || info.mapName || pretty(u.svc.replace(/\/(Map|Image)Server$/, ''));
              var n = (info.layers || []).length, rid = 'u' + Math.random().toString(36).slice(2, 7);
              body.innerHTML = '<div class="list">' + row(u.svc, sub ? sub.name + ' — ' + title : title, hostOf(u.svc) + ' · ' + (/ImageServer$/.test(u.svc) ? 'image service' : 'map service · ' + n + ' layer' + (n === 1 ? '' : 's')) + (sub ? ' · just this layer' : ''), inProject(u.svc) && !sub).replace('class="lib-row"', 'class="lib-row" id="' + rid + '"') + '</div>' +
                (u.feature ? '<p class="hint">That was a feature service: its map service at the same address is used.</p>' : '') +
                (strip(info.serviceDescription || info.description) ? '<p class="hint">' + esc(strip(info.serviceDescription || info.description).slice(0, 300)) + '</p>' : '');
              var b = body.querySelector('#' + rid + ' [data-a=add]');
              if (b) b.onclick = function () { b.disabled = true; b.textContent = 'Adding…'; addService(u.svc, sub ? sub.name + ' — ' + title : null, { sub: u.sub }).then(function () { b.textContent = 'Added'; b.classList.remove('primary'); }); };
            }, function (e) { body.innerHTML = '<p class="hint fail">Could not open ' + esc(u.svc) + ' (' + esc(e.message) + '). Check the address, and that you are online.</p>'; });
            return;
          }
          other = { id: 'url', name: hostOf(u.rest), url: u.rest }; tab = 'url'; path = u.path;
          [].forEach.call(el.querySelectorAll('.lib-tabs button'), function (x) { x.classList.remove('on'); });
          browse();
        };
        var search = function (text) {
          var pu = parseUrl(text); if (pu) { byUrl(pu); return; }
          if (/^https?:/i.test(text)) { body.innerHTML = '<p class="hint">Paste the address of an ArcGIS map service, e.g. <code>https://…/arcgis/rest/services/…/MapServer</code> (a layer like …/MapServer/12, a folder or the whole …/rest/services works too).</p>'; return; }
          var words = text.toLowerCase().split(/\s+/).filter(Boolean);
          if (!words.length) { show(); return; }
          var match = function (s) { s = s.toLowerCase().replace(/_/g, ' '); return words.every(function (w) { return s.indexOf(w) >= 0; }); };
          var feat = FEATURED.filter(function (f) { return match(f.title + ' ' + f.note + ' ' + f.url); });
          body.innerHTML = (feat.length ? '<div class="list">' + feat.map(function (f) { return row(f.url, f.title, f.note, inProject(f.url)); }).join('') + '</div>' : '') + '<p class="hint" id="lib-more">Searching all maps…</p>';
          wire();
          index().then(function (items) {
            if (qbox.value !== text) return;
            var seen = {}; feat.forEach(function (f) { seen[f.url] = 1; });
            var hits = items.filter(function (it) { return match(it.n) && !seen[serviceUrl(it.r, it.n, it.t)]; }).slice(0, 60);
            var more = body.querySelector('#lib-more'); if (!more) return;
            more.outerHTML = hits.length ? '<div class="list">' + hits.map(function (it) {
              var u = serviceUrl(it.r, it.n, it.t), r = ROOTS.filter(function (x) { return x.id === it.r; })[0];
              return row(u, pretty(it.n), r.name + (it.n.indexOf('/') > 0 ? ' › ' + pretty(it.n.split('/')[0]) : '') + (it.t === 'ImageServer' ? ' · image service' : ''), inProject(u));
            }).join('') + '</div>' : (feat.length ? '' : '<p class="hint">No maps match “' + esc(text) + '”.' + (items.length ? '' : ' (The catalogues could not be reached: the library needs an internet connection.)') + '</p>');
            wire();
          });
        };
        var show = function () { if (tab === 'featured') featured(); else browse(); };
        [].forEach.call(el.querySelectorAll('.lib-tabs button'), function (b) {
          b.onclick = function () {
            tab = b.getAttribute('data-t'); qbox.value = '';
            var root = ROOTS.filter(function (r) { return r.id === tab; })[0]; path = root && root.start || '';
            [].forEach.call(el.querySelectorAll('.lib-tabs button'), function (x) { x.classList.toggle('on', x === b); });
            show();
          };
        });
        var timer = null;
        qbox.oninput = function () { clearTimeout(timer); timer = setTimeout(function () { search(qbox.value.trim()); }, 250); };
        el.querySelector('[data-a=close]').onclick = close;
        el.querySelector('[data-a=back]').onclick = function () { close(); if (GC.mymaps) GC.mymaps.open({ folder: target }); };
        featured();
      });
  }

  if ($('btn-library')) $('btn-library').onclick = function () { open(); };
  GC.library = { open: open, add: addService, parseUrl: parseUrl, copyFeatures: copyFeatures, layerFor: layerFor, tileUrl: tileUrl, tileLayer: tileLayer, identify: identify, optionsHtml: optionsHtml, bindOptions: bindOptions,
    visibleServices: visibleServices, index: index, FEATURED: FEATURED, ROOTS: ROOTS };
})(window);

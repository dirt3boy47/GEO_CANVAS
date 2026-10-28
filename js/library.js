/* GeoCanvas web — Map library: browse and search the public map services of Geoscience Australia and the Queensland
   Government (geology, topography, mineral tenements…), add one to the project as a layer (with legend and tap-to-identify),
   and save it for offline use with Offline maps. The catalogues are read live from the agencies' ArcGIS servers, so
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
    else return null;
    return [[+a.lat.toFixed(5), +a.lng.toFixed(5)], [+b.lat.toFixed(5), +b.lng.toFixed(5)]];
  }
  function strip(html) { var d = document.createElement('div'); d.innerHTML = String(html || ''); return (d.textContent || '').replace(/\s+/g, ' ').trim(); }
  /** Builds the project layer for a service from its JSON description. */
  function layerFor(url, info, title) {
    var image = /\/ImageServer$/.test(url), z = webTiles(info);
    var subs = (info.layers || []).slice(0, 300).map(function (s) { return { id: s.id, name: s.name, parent: s.parentLayerId == null ? -1 : s.parentLayerId, group: !!(s.subLayerIds && s.subLayerIds.length), on: s.defaultVisibility !== false }; });
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
    return t;
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
    var pop = L.popup({ className: 'gc-balloon', maxWidth: 380, maxHeight: Math.round(sz.y * 0.6) }).setLatLng(ll).setContent('<div class="gb-title">What’s here…</div>').openOn(map);
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
        if (GC.cadastre && GC.cadastre.on()) { map.closePopup(pop); GC.cadastre.identify(ll); return; }
        html = '<div class="gb-title">Nothing mapped here</div><p class="lib-sub">' + (all.some(function (a) { return a.err; }) ? 'The map service could not be reached (it needs an internet connection).' : 'No features of the visible map services at this spot.') + '</p>';
      }
      pop.setContent('<div class="lib-ident">' + html + '</div>');
    });
    return true;
  }

  // ---------- legend and layer options ----------
  function optionsHtml(l) {
    var s = l.service, shown = s.show ? s.show : s.subs.filter(function (x) { return x.on && !x.group; }).map(function (x) { return x.id; });
    var depth = function (x) { var d = 0, p = x.parent; while (p !== -1 && d < 6) { var q = s.subs.filter(function (y) { return y.id === p; })[0]; if (!q) break; p = q.parent; d++; } return d; };
    var subs = s.image ? '' : s.subs.map(function (x) {
      return x.group ? '<div class="lib-grp" style="padding-left:' + (depth(x) * 14) + 'px">' + esc(x.name) + '</div>' :
        '<label class="opt lib-subl" style="padding-left:' + (depth(x) * 14 + 6) + 'px"><input type="checkbox" data-sub="' + x.id + '"' + (shown.indexOf(x.id) >= 0 ? ' checked' : '') + '> ' + esc(x.name) + '</label>';
    }).join('');
    return (s.about ? '<p class="hint">' + esc(s.about) + '</p>' : '') +
      (subs ? '<div class="pop-title small">Layers in this map</div><div class="lib-subs">' + subs + '</div>' : '') +
      (s.image ? '' : '<label class="opt"><input type="checkbox" id="lo-ident"' + (l.identify ? ' checked' : '') + '> Tap the map to see what’s here (rock unit, tenement…)</label>') +
      '<div class="pop-title small">Legend</div><div id="lo-legend" class="lib-legend"><p class="hint">Loading…</p></div>' +
      '<p class="hint">Source: ' + esc(s.source) + (s.copyright ? ' · ' + esc(s.copyright) : '') + '<br><a href="' + esc(s.url) + '" target="_blank" rel="noopener">Service details</a></p>';
  }
  function bindOptions(l, el) {
    var s = l.service, redraw = function () { GC.renderLayer(l); GC.applyLayerState(); GC.markDirty(l.id); };
    [].forEach.call(el.querySelectorAll('[data-sub]'), function (c) {
      c.onchange = function () {
        s.show = [].filter.call(el.querySelectorAll('[data-sub]'), function (x) { return x.checked; }).map(function (x) { return +x.getAttribute('data-sub'); });
        redraw(); legend(l, el.querySelector('#lo-legend'));
      };
    });
    var id = el.querySelector('#lo-ident'); if (id) id.onchange = function () { l.identify = id.checked; GC.markDirty(l.id); };
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

  // ---------- the library: featured, browse, search ----------
  var target = '';
  function addService(url, title) {
    GC.busy('Adding the map…');
    return getJSON(url).then(function (info) {
      var l = layerFor(url, info, title);
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
    GC.modal('<h2>Online maps</h2><p class="sub">Free maps from Geoscience Australia and the Queensland Government: geology, topography, tenements and more. <b>Add</b> saves the map in My maps' + (target ? ' › ' + esc(target.replace(/\//g, ' › ')) : '') + ' and shows it in this project.</p>' +
      '<input type="search" id="lib-q" placeholder="Search maps, e.g. geology, topographic, groundwater, mineral" autocomplete="off">' +
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
          var root = ROOTS.filter(function (r) { return r.id === tab; })[0];
          body.innerHTML = '<p class="hint">Loading ' + esc(root.name) + '…</p>';
          getJSON(root.url + (path ? '/' + path : '')).then(function (d) {
            var crumbs = '<div class="lib-crumbs"><a data-folder="">' + esc(root.name) + '</a>' + (path ? ' › ' + esc(pretty(path)) : '') + '</div>';
            var folders = path ? [] : (d.folders || []).filter(function (f) { return !/^(Utilities|System)$/i.test(f); });
            var svcs = (d.services || []).filter(function (s) { return s.type === 'MapServer' || s.type === 'ImageServer'; });
            body.innerHTML = crumbs + '<div class="list">' + folders.map(function (f) { return '<div class="lib-row lib-folder" data-folder="' + esc(f) + '"><div class="lib-txt"><b>' + esc(pretty(f)) + '</b><small>Folder</small></div><span class="lib-go">›</span></div>'; }).join('') +
              svcs.map(function (s) { var u = root.url + '/' + s.name + '/' + s.type; return row(u, pretty(s.name), (s.type === 'ImageServer' ? 'Image service' : 'Map service') + (path ? '' : ''), inProject(u)); }).join('') + '</div>' +
              (!folders.length && !svcs.length ? '<p class="hint">No maps in this folder.</p>' : '');
            wire();
          }, function (e) { body.innerHTML = '<p class="hint fail">' + esc(root.name) + ' could not be reached (' + esc(e.message) + '). The library needs an internet connection.</p>'; });
        };
        var search = function (text) {
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
  GC.library = { open: open, add: addService, layerFor: layerFor, tileUrl: tileUrl, tileLayer: tileLayer, identify: identify, optionsHtml: optionsHtml, bindOptions: bindOptions,
    visibleServices: visibleServices, index: index, FEATURED: FEATURED, ROOTS: ROOTS };
})(window);

/* GeoCanvas web — workspaces: one shared team workspace, and private jobs.
   Team workspace: a single shared project per team (id "ws" + team id). Joining a team opens it; it syncs and
   live-updates for everyone.
   Private jobs: projects kept on this device only (never synced, never live-updated), started empty or from a
   snapshot of the team workspace. "Send to team" merges the job's changes into the team workspace: against the
   snapshot it started from (or its last send), so only what changed in the job is applied, item by item for drawings,
   tracks and actions, and changes others made meanwhile are kept. Team projects from before workspaces stay as they
   were, listed under "Older team projects" with Copy into team workspace. */
(function (global) {
  'use strict';
  var GC = global.GC, Ink = global.Ink, $ = GC.$, esc = GC.esc, map = GC.map;
  var BASE = 'base.json';

  function cloudOn() { return !!(GC.cloud && GC.cloud.on() && GC.cloud.team()); }
  function wsId() { var t = cloudOn() && GC.cloud.team(); return t ? 'ws' + String(t.id).toLowerCase().replace(/[^0-9a-z]/g, '') : null; }
  function isWs(p) { return !!p && !!wsId() && p.id === wsId(); }
  function isJob(p) { return !!(p && p.job); }
  function load(id) { return Store.loadProject(id).then(function (p) { return p; }, function () { return null; }); }

  // ---------- the team workspace ----------
  function create(id) {
    var t = GC.cloud.team(), p = GC.newProject((t && t.name ? t.name : 'Team') + ' workspace'), c = map.getCenter();
    p.id = id; p.view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
    if (GC.project && !isJob(GC.project)) { p.view = GC.project.view || p.view; p.basemap = GC.project.basemap || p.basemap; }
    return Store.saveProject(p, null).then(function () { return p; });
  }
  /** The team workspace on this device, fetched from the cloud or made the first time. */
  function ensureWs() {
    var id = wsId(); if (!id) return Promise.resolve(null);
    return load(id).then(function (p) {
      if (p) return p;
      return GC.cloud.remoteList().then(function (list) {
        return (list || []).some(function (x) { return x.id === id; }) ? GC.cloud.download(id) : create(id);
      }, function () { return create(id); });
    });
  }
  function openTeam() {
    if (!wsId()) return Promise.resolve(null);
    GC.busy('Opening the team workspace…');
    return GC.saveNow().then(ensureWs).then(function (p) {
      GC.busy(null);
      if (p && (!GC.project || GC.project.id !== p.id)) GC.openProject(p);
      return p;
    }, function (e) { GC.busy(null); GC.toast(e.message, 'err'); return null; });
  }
  /** Joining a team: projects made on this device before stay private jobs (nothing uploads by surprise);
      the team workspace opens. */
  function onJoin() {
    var ws = wsId();
    return Store.listProjects().then(function (list) {
      return Promise.all(list.filter(function (m) { return m.id !== ws && !m.cloud && !m.cloudOff && !m.library && !/^mylib/.test(m.id); }).map(function (m) {
        return load(m.id).then(function (p) {
          if (!p) return;
          if (!p.notes && p.layers.every(function (l) { return l.kind === 'drawing' && !l.items.length; })) return Store.deleteProject(p.id); // an untouched, empty start-up project: nothing to keep
          p.cloudOff = true; p.job = p.job || { created: p.created || Date.now(), from: null, sent: 0 };
          if (GC.project && GC.project.id === p.id) { GC.project.cloudOff = true; GC.project.job = p.job; }
          return Store.putFile(p.id, '_job', BASE, '[]').then(function () { return Store.saveProject(p, {}); });
        });
      }));
    }).then(openTeam);
  }

  // ---------- private jobs ----------
  function clean(o) { return JSON.parse(JSON.stringify(o, function (k, v) { return k && k.charAt(0) === '_' ? undefined : v; })); }
  function copyFiles(from, to, layers) {
    var lids = layers.filter(function (l) { return l.hasSources; }).map(function (l) { return l.id; }).concat(['_photos']);
    return Promise.all(lids.map(function (lid) {
      return Store.getFiles(from, lid).then(function (fs) {
        return Store.fileNames(to, lid).then(function (have) {
          var got = {}; have.forEach(function (n) { got[n] = true; });
          return Promise.all(fs.filter(function (f) { return !got[f.name]; }).map(function (f) { return Store.putFile(to, lid, f.name, f.data); }));
        });
      });
    }));
  }
  /** A new private job, empty or starting from a copy of the team workspace. */
  function newJob(name, fromTeam) {
    GC.busy(fromTeam ? 'Copying the team workspace…' : 'Creating the job…');
    return GC.saveNow().then(function () { return fromTeam && wsId() ? ensureWs() : null; }).then(function (ws) {
      var p = GC.newProject(name), c = map.getCenter();
      p.cloudOff = true; p.job = { created: Date.now(), from: ws ? ws.id : null, sent: 0 };
      p.view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
      var base = [];
      var go = Promise.resolve();
      if (ws) {
        p.layers = clean(ws.layers); p.view = ws.view || p.view; p.basemap = ws.basemap || p.basemap; p.notes = ws.notes || '';
        p.activeLayer = (p.layers.filter(function (l) { return l.kind === 'drawing'; }).pop() || {}).id || null;
        if (!p.layers.length) { var d = GC.newProject('x').layers[0]; p.layers = [d]; p.activeLayer = d.id; }
        base = clean(ws.layers);
        go = copyFiles(ws.id, p.id, ws.layers);
      }
      return go.then(function () { return Store.putFile(p.id, '_job', BASE, JSON.stringify(base)); })
        .then(function () { return Store.saveProject(p, null); }).then(function () { GC.busy(null); GC.openProject(p); return p; });
    }, function (e) { GC.busy(null); throw e; });
  }

  // three-way merge of a job into the team workspace (mine wins where both changed the same thing)
  var COLL = { drawing: ['items', function (it) { return it.id; }], track: ['tracks', function (t) { return 's' + t.started; }], waypoints: ['waypoints', function (w) { return w.time != null ? 't' + w.time : 'j' + JSON.stringify(w); }] };
  function sig(o) { return JSON.stringify(clean(o)); }
  function props(l) { var c = COLL[l.kind], o = {}; for (var k in l) if (!c || k !== c[0]) o[k] = l[k]; return sig(o); }
  function mergeColl(b, m, t, st) {
    var c = COLL[m.kind], f = c[0], key = c[1];
    var out = props(m) !== (b ? props(b) : null) ? clean(m) : clean(t);
    var bi = {}, mi = {}; (b ? b[f] || [] : []).forEach(function (x) { bi[key(x)] = sig(x); });
    (m[f] || []).forEach(function (x) { mi[key(x)] = x; });
    var items = [], seen = {};
    (t[f] || []).forEach(function (x) {
      var k = key(x); seen[k] = true;
      var mine = mi[k], base = bi[k];
      if (mine && sig(mine) !== base) { items.push(clean(mine)); if (sig(mine) !== sig(x)) st.changed++; } // I changed it
      else if (!mine && base != null) { if (sig(x) === base) st.removed++; else items.push(x); } // I deleted it (unless they edited it)
      else items.push(x);
    });
    (m[f] || []).forEach(function (x) { var k = key(x); if (!seen[k] && (bi[k] == null || sig(x) !== bi[k])) { items.push(clean(x)); st.added++; } }); // new in my job
    out[f] = items;
    return out;
  }
  /** Counts what changed in a collection layer between base and mine (for the summary). */
  function countItems(b, m, st) {
    var c = COLL[m.kind]; if (!c) return;
    var f = c[0], key = c[1], bi = {}, mk = {};
    (b ? b[f] || [] : []).forEach(function (x) { bi[key(x)] = sig(x); });
    (m[f] || []).forEach(function (x) { var k = key(x); mk[k] = 1; if (bi[k] == null) st.added++; else if (bi[k] !== sig(x)) st.changed++; });
    Object.keys(bi).forEach(function (k) { if (!mk[k]) st.removed++; });
  }
  /** Applies a job's changes (mine vs base) to the team's layers. Returns { layers, st }. */
  function apply(base, mine, team) {
    var st = { layersAdded: 0, layersChanged: 0, layersRemoved: 0, added: 0, changed: 0, removed: 0 };
    var by = function (a) { var o = {}; a.forEach(function (l) { o[l.id] = l; }); return o; };
    var B = by(base), M = by(mine), out = team.slice(), idx = function (id) { for (var i = 0; i < out.length; i++) if (out[i].id === id) return i; return -1; };
    mine.forEach(function (m) {
      var b = B[m.id], i = idx(m.id), t = i >= 0 ? out[i] : null;
      if (b && sig(m) === sig(b)) return; // untouched in the job
      if (!t) { out.push(clean(m)); st.layersAdded++; if (COLL[m.kind]) st.added += (m[COLL[m.kind][0]] || []).length; return; } // new in my job (or deleted by the team after I changed it)
      if (b && sig(t) === sig(b)) { out[i] = clean(m); st.layersChanged++; countItems(b, m, st); return; } // only I changed it
      if (COLL[m.kind]) { var c = mergeColl(b, m, t, st); if (sig(c) !== sig(t)) { out[i] = c; st.layersChanged++; } return; }
      out[i] = clean(m); st.layersChanged++; // both changed a map layer: mine wins
    });
    base.forEach(function (b) { if (M[b.id]) return; var i = idx(b.id); if (i >= 0 && sig(out[i]) === sig(b)) { out.splice(i, 1); st.layersRemoved++; } }); // deleted in the job
    return { layers: out, st: st };
  }
  function summary(st) {
    var bits = [];
    if (st.layersAdded) bits.push(st.layersAdded + ' new layer' + (st.layersAdded > 1 ? 's' : ''));
    if (st.added) bits.push(st.added + ' new item' + (st.added > 1 ? 's' : ''));
    if (st.changed) bits.push(st.changed + ' changed');
    if (st.removed) bits.push(st.removed + ' removed');
    if (st.layersRemoved) bits.push(st.layersRemoved + ' layer' + (st.layersRemoved > 1 ? 's' : '') + ' removed');
    if (!bits.length && st.layersChanged) bits.push(st.layersChanged + ' layer' + (st.layersChanged > 1 ? 's' : '') + ' updated');
    return bits.join(', ');
  }
  /** Sends a job's changes into the team workspace. */
  function sendToTeam(jobId) {
    if (!wsId()) { GC.toast('Join a team first (☁).', 'warn'); return Promise.resolve(null); }
    GC.busy('Sending to the team workspace…');
    var job, base, res;
    return GC.saveNow().then(function () { return load(jobId); }).then(function (p) {
      job = p; if (!job) throw new Error('That job is not on this device.');
      return Store.getFile(job.id, '_job', BASE);
    }).then(function (b) {
      base = b ? JSON.parse(b) : [];
      return ensureWs();
    }).then(function (ws) {
      return copyFiles(job.id, ws.id, job.layers).then(function () { return ws; });
    }).then(function (ws) {
      var mine = clean(job.layers);
      if (GC.project && GC.project.id === ws.id) { // the workspace is open here: change it in place
        res = apply(base, mine, GC.project.layers);
        GC.project.layers = res.layers; GC.markAllDirty(); GC.openProject(GC.project);
        return GC.saveNow();
      }
      return GC.cloud.edit(ws.id, function (w) { res = apply(base, mine, w.layers); w.layers = res.layers; return null; });
    }).then(function () {
      job.job.sent = Date.now();
      if (GC.project && GC.project.id === job.id) GC.project.job = job.job;
      return Store.putFile(job.id, '_job', BASE, JSON.stringify(clean(job.layers))).then(function () { return Store.saveProject(job, {}); });
    }).then(function () {
      GC.busy(null);
      var s = summary(res.st);
      GC.toast(s ? 'Sent to the team workspace: ' + s + '.' : 'Nothing new to send: the team workspace already has this job’s work.', null, 6000);
      return res.st;
    }, function (e) { GC.busy(null); GC.toast(e.message, 'err'); return null; });
  }
  /** An older team project's layers, copied into the team workspace as new layers. */
  function copyIntoTeam(id) {
    GC.busy('Copying into the team workspace…');
    var src;
    return GC.saveNow().then(function () { return load(id); }).then(function (p) { return p || GC.cloud.download(id); }).then(function (p) {
      src = p; return ensureWs();
    }).then(function (ws) {
      return copyFiles(src.id, ws.id, src.layers).then(function () {
        var have = {}, res;
        var add = function (layers) { var out = layers.slice(); clean(src.layers).forEach(function (l) { if (!out.some(function (x) { return x.id === l.id; })) { l.name = l.name + ' (' + src.name + ')'; out.push(l); } }); return out; };
        if (GC.project && GC.project.id === ws.id) { GC.project.layers = add(GC.project.layers); GC.markAllDirty(); GC.openProject(GC.project); return GC.saveNow(); }
        return GC.cloud.edit(ws.id, function (w) { w.layers = add(w.layers); return null; });
      });
    }).then(function () { GC.busy(null); GC.toast('“' + src.name + '” copied into the team workspace.'); }, function (e) { GC.busy(null); GC.toast(e.message, 'err'); });
  }

  // ---------- the Workspaces screen (Projects, when in a team) ----------
  function openList() {
    GC.busy('Checking the team cloud…');
    Promise.all([GC.saveNow().then(Store.listProjects), GC.cloud.remoteList().then(null, function () { return null; })]).then(function (r) {
      GC.busy(null);
      var local = r[0], remote = r[1] || [], ws = wsId(), cur = GC.project && GC.project.id;
      var wsLocal = local.filter(function (m) { return m.id === ws; })[0], wsRemote = remote.filter(function (x) { return x.id === ws; })[0];
      var jobs = local.filter(function (m) { return m.job; }).sort(function (a, b) { return (b.modified || 0) - (a.modified || 0); });
      var seen = {}, older = [];
      local.forEach(function (m) { if (m.id !== ws && !m.job && m.cloud && !m.library && !/^mylib/.test(m.id)) { seen[m.id] = 1; older.push({ id: m.id, name: m.name, here: true, t: m.modified, meta: m, foreign: GC.cloud.otherTeam(m) }); } });
      remote.forEach(function (x) { if (x.id !== ws && !seen[x.id] && !/^mylib/.test(x.id)) older.push({ id: x.id, name: x.name, here: false, t: x.modified, by: x.device }); });
      var t = GC.cloud.team(), wsName = (wsLocal && wsLocal.name) || (wsRemote && wsRemote.name) || (t.name + ' workspace');
      var wsT = Math.max(wsLocal ? wsLocal.modified || 0 : 0, wsRemote ? wsRemote.modified || 0 : 0);
      var html = '<h2>Workspaces</h2><p class="sub"><b>' + esc(t.name) + '</b>: one shared team workspace, plus your private jobs on this device.</p>' +
        '<div class="ws-card' + (cur === ws ? ' current' : '') + '" data-ws><div class="ws-ic">☁</div><div class="grow"><b>' + esc(wsName) + '</b><small>Team workspace · live: everyone’s changes appear as they happen' + (wsT ? ' · edited ' + GC.fmtTime(wsT) + (wsRemote && wsRemote.device ? ' by ' + esc(wsRemote.device) : '') : '') + '</small></div><button class="btn primary" data-a="ws">' + (cur === ws ? 'Open' : 'Open') + '</button></div>' +
        '<div class="ws-head">My jobs <small>private · offline · don’t live-update · on this device only</small></div><div class="list">' +
        (jobs.length ? jobs.map(function (m) {
          return '<div class="item' + (m.id === cur ? ' current' : '') + '" data-id="' + esc(m.id) + '"><div class="grow" data-a="open"><b>' + esc(m.name) + '</b><small>' + (m.job.from ? 'from the team workspace · ' : '') + 'edited ' + GC.fmtTime(m.modified || m.created) + ' · ' + (m.job.sent ? 'sent to team ' + GC.fmtTime(m.job.sent) : 'not sent yet') + '</small></div>' +
            '<button class="btn" data-a="send">Send to team</button><button class="ib" data-a="ren" title="Rename">' + GC.icon('text') + '</button><button class="ib danger" data-a="del" title="Delete">' + GC.icon('trash') + '</button></div>';
        }).join('') : '<p class="hint" style="margin:6px 2px">No private jobs yet. Start one to work offline on your own; send it to the team when it’s ready.</p>') + '</div>' +
        (older.length ? '<details class="ws-older"><summary>Older team projects (' + older.length + ')</summary><div class="list">' + older.map(function (x) {
          return '<div class="item' + (x.id === cur ? ' current' : '') + '" data-id="' + esc(x.id) + '" data-old="' + (x.here ? 1 : 0) + '"><div class="grow" data-a="openold"><b>' + esc(x.name) + '</b><small>' + (x.foreign ? 'from a team this device has left (kept here only)' : 'team project from before workspaces') + ' · edited ' + GC.fmtTime(x.t) + (x.by ? ' by ' + esc(x.by) : '') + (x.here ? '' : ' · ☁ in the cloud') + '</small></div><button class="btn" data-a="copyin">Copy into team workspace</button><button class="ib danger" data-a="delold" title="Delete">' + GC.icon('trash') + '</button></div>';
        }).join('') + '</div></details>' : '') +
        '<div class="actions"><button class="btn" data-a="close">Close</button><button class="btn primary" data-a="newjob">+ New private job</button></div>';
      GC.modal(html, function (el, close) {
        el.querySelector('[data-a=close]').onclick = close;
        el.querySelector('[data-a=ws]').onclick = function () { close(); openTeam(); };
        el.querySelector('[data-a=newjob]').onclick = function () { close(); askNewJob(); };
        el.addEventListener('click', function (e) {
          var it = e.target.closest('[data-id]'), a = e.target.closest('[data-a]'); if (!it || !a) return;
          var id = it.getAttribute('data-id'), act = a.getAttribute('data-a');
          if (act === 'open' || act === 'openold') {
            close(); if (GC.project && GC.project.id === id) return;
            GC.saveNow().then(function () { return load(id); }).then(function (p) { return p || GC.cloud.download(id); }).then(function (p) { GC.openProject(p); }, function (er) { GC.toast(er.message, 'err'); });
          } else if (act === 'send') { close(); sendToTeam(id).then(function (st) { if (st) openList(); }); }
          else if (act === 'copyin') { close(); copyIntoTeam(id); }
          else if (act === 'delold') { var o = older.filter(function (x) { return x.id === id; })[0]; close(); GC.deleteProject(o.here ? o.meta : { id: id, name: o.name, cloud: {}, remoteOnly: true }); }
          else if (act === 'ren') { close(); load(id).then(function (p) { GC.prompt('Rename job', p.name, 'Name', 'Rename').then(function (n) { if (!n) return; if (GC.project && GC.project.id === id) { GC.project.name = n; $('project-name').textContent = n; GC.markDirty(); } else { p.name = n; Store.saveProject(p, {}); } }); }); }
          else if (act === 'del') {
            close();
            GC.confirm('Delete this private job?', 'It is only on this device and has not been shared since its last send. This cannot be undone.', 'Delete job', true).then(function (y) {
              if (!y) return;
              var after = GC.project && GC.project.id === id ? openTeam() : Promise.resolve();
              after.then(function () { return Store.deleteProject(id); }).then(function () { GC.toast('Job deleted.'); });
            });
          }
        });
      });
    }, function (e) { GC.busy(null); GC.toast(e.message, 'err'); });
  }
  function askNewJob() {
    GC.modal('<h2>New private job</h2><p class="sub">A workspace of your own on this device: works offline, and the team’s changes don’t come in while you work. Send it to the team when it’s ready.</p>' +
      '<label class="field">Job name<input type="text" id="nj-name" value="' + esc('Job ' + new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })) + '"></label>' +
      '<label class="opt"><input type="radio" name="nj-from" value="team" checked> Start from a copy of the team workspace (its layers, actions and maps as they are now)</label>' +
      '<label class="opt"><input type="radio" name="nj-from" value="empty"> Start empty</label>' +
      '<div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="yes">Create job</button></div>',
    function (el, close) {
      el.querySelector('[data-a=no]').onclick = close;
      el.querySelector('[data-a=yes]').onclick = function () {
        var n = el.querySelector('#nj-name').value.trim() || 'Job', team = el.querySelector('[name=nj-from]:checked').value === 'team';
        close(); newJob(n, team).then(function (p) { GC.toast('“' + p.name + '” is your private job. The team’s changes won’t come in; Projects › Send to team when you’re done.', null, 7000); }, function (e) { GC.toast(e.message, 'err'); });
      };
    });
  }

  // ---------- which workspace am I in? ----------
  function paintTag() {
    var tag = $('ws-tag'); if (!tag) return;
    var p = GC.project;
    tag.hidden = !(cloudOn() && p && (isWs(p) || isJob(p)));
    tag.className = 'ws-tag ' + (isWs(p) ? 'team' : 'job');
    tag.textContent = isWs(p) ? 'Team · live' : 'Private job';
  }
  var origOpen = GC.openProject;
  GC.openProject = function (p) { var r = origOpen.apply(this, arguments); paintTag(); return r; };
  if ($('ws-tag')) $('ws-tag').onclick = function () { if (cloudOn()) openList(); };

  GC.workspace = { active: cloudOn, id: wsId, isWs: isWs, isJob: isJob, openTeam: openTeam, onJoin: onJoin, newJob: newJob, sendToTeam: sendToTeam, copyIntoTeam: copyIntoTeam, openList: openList, _apply: apply };
  paintTag();
})(window);

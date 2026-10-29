/* GeoCanvas web — user accounts (☁ in the top bar).
   People sign in on each of their devices (iPad, iPhone, laptop) with email + password, or with a 6-digit code made
   on a device that is already signed in. Teams belong to people: join a team once and it is on all your devices; you
   can be in several and switch. Owners and admins manage the team: roles, removing people, resetting a forgotten
   password, the join code. Private jobs follow you across your own devices (your private space in the cloud).
   Devices set up before accounts (team join code only) keep working; signing in moves them onto the account. */
(function (global) {
  'use strict';
  var GC = global.GC, Store = global.Store, $ = GC.$, esc = GC.esc;
  var ROLE = { owner: 'Owner', admin: 'Admin', member: 'Member' };

  function cfg() { return GC.settings.cloud || {}; }
  function api(m, path, body, opts) { return GC.cloud.api(m, path, body, opts); }
  function deviceGuess() {
    var ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
    return /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Computer';
  }
  function msgOf(el) { return function (t) { var m = el.querySelector('.fail'); m.hidden = !t; m.textContent = t || ''; }; }

  // ---------- signing in ----------
  /** After any sign-in: keep the session, move an old join-code team onto the account, pick the team, sync. */
  function signedIn(r) {
    var old = cfg(), legacyKey = old.key, legacyTeam = old.team;
    GC.settings.cloud = { session: r.token, user: r.user, teams: r.teams || [], device: r.user.name, deviceType: deviceGuess() };
    GC.settings.lastEmail = r.user.email; GC.saveSettings();
    var up = legacyKey ? api('POST', 'teams/join', { code: legacyKey }).then(function (j) { return j.team; }, function () { return null; }) : Promise.resolve(null);
    return up.then(function (joined) {
      return api('GET', 'me').then(function (me) { GC.settings.cloud.teams = me.teams; GC.settings.cloud.user = me.user; return joined; }, function () { return joined; });
    }).then(function (joined) {
      var teams = cfg().teams || [], pick = (joined && teams.filter(function (t) { return t.id === joined.id; })[0]) || (legacyTeam && teams.filter(function (t) { return t.id === legacyTeam.id; })[0]) || teams[0] || null;
      GC.settings.cloud.team = pick; GC.saveSettings();
      return privateJobsFollow();
    }).then(function () {
      GC.cloud.refresh();
      if (cfg().team && GC.workspace) return GC.workspace.onJoin();
    });
  }
  /** Private jobs on this device start syncing to your private space (they follow you to your other devices). */
  function privateJobsFollow() {
    return Store.listProjects().then(function (list) {
      return Promise.all(list.filter(function (m) { return m.job && m.cloudOff; }).map(function (m) {
        return Store.loadProject(m.id).then(function (p) {
          delete p.cloudOff; if (GC.project && GC.project.id === p.id) delete GC.project.cloudOff;
          GC.cloud.touch(p.id); return Store.saveProject(p, {});
        });
      }));
    });
  }
  function signInScreen(tab) {
    var c = cfg(), legacy = c.key && c.team;
    GC.modal('<h2>Sign in to GeoCanvas</h2><p class="sub">' + (legacy ? 'This device is in <b>' + esc(c.team.name) + '</b> with a join code. Sign in (or create your account) to keep it and have your teams and private jobs on all your devices.' :
      'One account on your iPad, iPhone and laptop: your teams and private jobs follow you. Everything still works offline on each device.') + '</p>' +
      '<div class="seg tm-tabs" id="ac-tabs"><button data-t="in">Sign in</button><button data-t="new">Create account</button><button data-t="code">Use a code</button></div>' +
      '<div data-p="in new"><label class="field">Email<input type="email" id="ac-email" autocomplete="username" value="' + esc(GC.settings.lastEmail || '') + '"></label></div>' +
      '<div data-p="new"><label class="field">Your name<input type="text" id="ac-name" autocomplete="name" placeholder="e.g. Sam Taylor" value="' + esc(c.device || GC.settings.lastName || '') + '"></label></div>' +
      '<div data-p="in new"><label class="field">Password<input type="password" id="ac-pw" autocomplete="current-password" placeholder="At least 8 characters"></label></div>' +
      '<div data-p="code"><label class="field">6-digit code<input type="text" id="ac-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" style="font-family:ui-monospace,Menlo,monospace;letter-spacing:.2em;font-size:22px"></label>' +
      '<p class="hint">On a device that is already signed in: ☁ › Add a device. The code works once, for 10 minutes.</p></div>' +
      '<p class="hint" data-p="in">Forgot your password? Ask your team’s owner or an admin to reset it (☁ › your team › Manage).</p>' +
      '<p class="fail" hidden></p>' +
      '<div class="actions"><button class="btn" data-a="no">Not now</button><button class="btn primary" data-a="go">Sign in</button></div>',
    function (el, close) {
      var mode = tab || (GC.settings.lastEmail ? 'in' : 'new'), q = function (x) { return el.querySelector(x); }, msg = msgOf(el);
      var show = function () {
        [].forEach.call(q('#ac-tabs').children, function (b) { b.classList.toggle('on', b.getAttribute('data-t') === mode); });
        [].forEach.call(el.querySelectorAll('[data-p]'), function (d) { d.hidden = d.getAttribute('data-p').split(' ').indexOf(mode) < 0; });
        q('[data-a=go]').textContent = mode === 'new' ? 'Create account' : 'Sign in';
        q('#ac-pw').autocomplete = mode === 'new' ? 'new-password' : 'current-password'; msg('');
      };
      show();
      q('#ac-tabs').onclick = function (e) { var b = e.target.closest('[data-t]'); if (b) { mode = b.getAttribute('data-t'); show(); } };
      q('[data-a=no]').onclick = close;
      q('[data-a=go]').onclick = function () {
        var btn = q('[data-a=go]'), label = btn.textContent, dev = deviceGuess(), job;
        if (mode === 'code') job = api('POST', 'auth/pair', { code: q('#ac-code').value, device: dev });
        else if (mode === 'new') job = api('POST', 'auth/signup', { email: q('#ac-email').value, name: q('#ac-name').value, password: q('#ac-pw').value, device: dev });
        else job = api('POST', 'auth/login', { email: q('#ac-email').value, password: q('#ac-pw').value, device: dev });
        btn.textContent = 'One moment…'; btn.disabled = true;
        job.then(function (r) { return signedIn(r).then(function () { return r; }); }).then(function (r) {
          close();
          GC.toast('Signed in as ' + r.user.name + '.' + (cfg().team ? ' Team: ' + cfg().team.name + '.' : ' Join or create a team under ☁.'), null, 6000);
          if (!cfg().team) open();
        }, function (e) { btn.textContent = label; btn.disabled = false; msg(e.offline ? 'No internet connection. Signing in needs to be online once.' : e.message); });
      };
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.tagName === 'INPUT') q('[data-a=go]').click(); });
    });
  }

  // ---------- the account screen ----------
  function open() {
    if (!GC.cloud.signedIn()) { signInScreen(); return; }
    var c = cfg();
    GC.busy('Loading your account…');
    api('GET', 'me', null, { timeout: 15000 }).then(function (me) {
      GC.busy(null);
      GC.settings.cloud.user = me.user; GC.settings.cloud.teams = me.teams;
      if (c.team) { var still = me.teams.filter(function (t) { return t.id === c.team.id; })[0]; GC.settings.cloud.team = still || me.teams[0] || null; }
      else if (me.teams.length) GC.settings.cloud.team = me.teams[0];
      GC.saveSettings(); GC.cloud.refresh();
      render(me);
    }, function (e) { GC.busy(null); if (e.offline) render({ user: c.user, teams: c.teams || [], devices: null }); else if (!e.signedOut) GC.toast(e.message, 'err'); else signInScreen('in'); });
  }
  function render(me) {
    var c = cfg(), cur = c.team && c.team.id;
    GC.modal('<h2>' + esc(me.user.name) + '</h2><p class="sub">' + esc(me.user.email) + ' · <span id="tm-status" class="tm-status"></span></p>' +
      '<div class="pop-title small">Your teams</div><div class="list ac-teams">' +
      (me.teams.length ? me.teams.map(function (t) {
        return '<div class="item' + (t.id === cur ? ' current' : '') + '" data-t="' + esc(t.id) + '"><div class="grow"><b>' + esc(t.name) + '</b><small>' + ROLE[t.role] + (t.id === cur ? ' · the team you are working in' : '') + '</small></div>' +
          (t.id === cur ? '' : '<button class="btn" data-a="use">Switch to</button>') + '<button class="btn" data-a="manage">' + (t.role === 'member' ? 'Members' : 'Manage') + '</button></div>';
      }).join('') : '<p class="hint" style="margin:4px 2px">Not in a team yet. Join one with its code, or create one. Your private jobs work without a team.</p>') + '</div>' +
      '<div class="row-btns"><button class="btn" data-a="join">Join a team</button><button class="btn" data-a="create">Create a team</button></div>' +
      '<div class="pop-title small">Your devices</div>' + (me.devices ? '<div class="list ac-devs">' + me.devices.map(function (d) {
        return '<div class="item' + (d.current ? ' current' : '') + '" data-d="' + esc(d.id) + '"><div class="grow"><b>' + esc(d.device || 'Device') + (d.current ? ' (this one)' : '') + '</b><small>signed in ' + GC.fmtTime(d.created) + ' · last seen ' + GC.fmtTime(d.seen) + '</small></div>' + (d.current ? '' : '<button class="btn" data-a="devout">Sign out</button>') + '</div>';
      }).join('') + '</div>' : '<p class="hint">Offline: the device list needs a connection.</p>') +
      '<div class="row-btns"><button class="btn primary" data-a="pair">Add a device</button></div>' +
      '<div class="row-btns" style="margin-top:14px"><button class="link" data-a="rename">Change name</button><button class="link" data-a="pw">Change password</button><button class="link" data-a="now">Save now</button></div>' +
      '<div class="actions"><button class="btn danger" data-a="out">Sign out</button><span class="spacer"></span><button class="btn primary" data-a="ok">Done</button></div>',
    function (el, close) {
      GC.cloud.refresh(true);
      var q = function (x) { return el.querySelector(x); };
      q('[data-a=ok]').onclick = close;
      el.addEventListener('click', function (e) {
        var a = e.target.closest('[data-a]'); if (!a) return;
        var act = a.getAttribute('data-a'), row = a.closest('[data-t]'), tid = row && row.getAttribute('data-t');
        if (act === 'use') { close(); switchTeam(me.teams.filter(function (t) { return t.id === tid; })[0]); }
        else if (act === 'manage') { close(); manage(tid); }
        else if (act === 'join') { close(); joinTeam(); }
        else if (act === 'create') { close(); createTeam(); }
        else if (act === 'pair') { close(); pair(); }
        else if (act === 'devout') { var did = a.closest('[data-d]').getAttribute('data-d'); api('DELETE', 'me/devices/' + did).then(function () { GC.toast('That device is signed out.'); close(); open(); }, function (er) { GC.toast(er.message, 'err'); }); }
        else if (act === 'rename') { close(); GC.prompt('Your name', me.user.name, 'e.g. Sam Taylor', 'Save').then(function (n) { if (!n) { open(); return; } api('POST', 'me', { name: n }).then(function (r) { GC.settings.cloud.user = r.user; GC.settings.cloud.device = r.user.name; GC.saveSettings(); open(); }, function (er) { GC.toast(er.message, 'err'); }); }); }
        else if (act === 'pw') { close(); changePassword(); }
        else if (act === 'now') { GC.cloud.refresh(); }
        else if (act === 'out') { close(); signOut(); }
      });
    });
  }
  function switchTeam(t) {
    if (!t) return;
    GC.settings.cloud.team = t; GC.saveSettings(); GC.cloud.refresh();
    GC.toast('Working in “' + t.name + '”.');
    if (GC.workspace) GC.workspace.openTeam();
  }
  function joinTeam() {
    GC.modal('<h2>Join a team</h2><label class="field">Team join code<input type="text" id="jt-code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" style="font-family:ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase"></label>' +
      '<p class="hint">Ask the team’s owner or an admin for it.</p><p class="fail" hidden></p><div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="go">Join</button></div>',
    function (el, close) {
      var msg = msgOf(el);
      el.querySelector('[data-a=no]').onclick = function () { close(); open(); };
      el.querySelector('[data-a=go]').onclick = function () {
        api('POST', 'teams/join', { code: el.querySelector('#jt-code').value }).then(function (r) {
          close(); (GC.settings.cloud.teams = GC.settings.cloud.teams || []).push(r.team); GC.settings.cloud.team = r.team; GC.saveSettings(); GC.cloud.refresh();
          GC.toast('Welcome to “' + r.team.name + '”. This is the team workspace: everyone’s changes appear here live.', null, 7000);
          if (GC.workspace) GC.workspace.onJoin();
        }, function (e) { msg(e.message); });
      };
    });
  }
  function createTeam() {
    GC.prompt('Create a team', '', 'e.g. T2W Pipeline crew', 'Create').then(function (n) {
      if (!n) { open(); return; }
      api('POST', 'teams', { name: n }).then(function (r) {
        (GC.settings.cloud.teams = GC.settings.cloud.teams || []).push(r.team); GC.settings.cloud.team = r.team;
        GC.settings.cloud.codes = Object.assign({}, GC.settings.cloud.codes); GC.settings.cloud.codes[r.team.id] = r.code; GC.saveSettings(); GC.cloud.refresh();
        var go = GC.workspace ? GC.workspace.onJoin() : Promise.resolve();
        go.then(function () { showCode(r.team, r.code, true); });
      }, function (e) { GC.toast(e.message, 'err'); });
    });
  }
  function showCode(t, code, fresh) {
    var shown = String(code).toUpperCase();
    GC.modal('<h2>' + (fresh ? 'Team “' + esc(t.name) + '” is ready' : 'Join code for “' + esc(t.name) + '”') + '</h2><p class="sub">Anyone signed in to GeoCanvas who types this code (☁ › Join a team) joins the team.</p>' +
      '<div class="tm-code"><code>' + esc(shown) + '</code><button class="btn" data-a="copy">Copy</button>' + (navigator.share ? '<button class="btn" data-a="share">Share…</button>' : '') + '</div>' +
      '<div class="actions"><button class="btn primary" data-a="ok">Done</button></div>',
    function (el, close) {
      el.querySelector('[data-a=ok]').onclick = close;
      el.querySelector('[data-a=copy]').onclick = function () { (navigator.clipboard ? navigator.clipboard.writeText(shown) : Promise.resolve()).then(function () { GC.toast('Join code copied.'); }); };
      if (el.querySelector('[data-a=share]')) el.querySelector('[data-a=share]').onclick = function () { navigator.share({ text: 'Join our GeoCanvas team “' + t.name + '”: open ' + location.origin + ' , sign in, tap ☁ › Join a team and enter ' + shown }).catch(function () {}); };
    });
  }
  function manage(tid) {
    GC.busy('Loading the team…');
    api('GET', 'teams/' + tid).then(function (r) {
      GC.busy(null);
      var me = cfg().user, role = r.role, boss = role === 'owner' || role === 'admin', code = (cfg().codes || {})[tid];
      GC.modal('<h2>' + esc(r.team.name) + '</h2><p class="sub">You are ' + (role === 'member' ? 'a member' : 'an ' + role) + '. ' + r.members.length + ' ' + (r.members.length === 1 ? 'person' : 'people') + '.</p><div class="list ac-mem">' +
        r.members.map(function (m) {
          var self = m.id === me.id, canRole = role === 'owner' && !self, canRemove = !self && (role === 'owner' || (role === 'admin' && m.role === 'member')), canReset = !self && boss && (m.role !== 'owner' || role === 'owner');
          return '<div class="item" data-u="' + esc(m.id) + '"><div class="grow"><b>' + esc(m.name) + (self ? ' (you)' : '') + '</b><small>' + esc(m.email) + ' · joined ' + GC.fmtTime(m.joined) + '</small></div>' +
            (canRole ? '<select data-a="role">' + ['member', 'admin', 'owner'].map(function (x) { return '<option value="' + x + '"' + (x === m.role ? ' selected' : '') + '>' + ROLE[x] + '</option>'; }).join('') + '</select>' : '<span class="ac-role ' + m.role + '">' + ROLE[m.role] + '</span>') +
            (canReset ? '<button class="btn" data-a="reset" title="For someone who forgot their password">Reset password</button>' : '') +
            (canRemove ? '<button class="ib danger" data-a="remove" title="Remove from the team">' + GC.icon('trash') + '</button>' : '') + '</div>';
        }).join('') + '</div>' +
        (boss ? '<div class="row-btns"><button class="btn" data-a="code">' + (code ? 'Show join code' : 'New join code') + '</button><button class="btn" data-a="tname">Rename team</button></div>' : '<p class="hint">For the join code or changes, ask the owner or an admin.</p>') +
        '<div class="actions"><button class="btn danger" data-a="leave">Leave team</button><span class="spacer"></span><button class="btn primary" data-a="ok">Done</button></div>',
      function (el, close) {
        var back = function () { close(); manage(tid); };
        el.querySelector('[data-a=ok]').onclick = function () { close(); open(); };
        el.addEventListener('change', function (e) {
          if (e.target.getAttribute('data-a') !== 'role') return;
          var uid = e.target.closest('[data-u]').getAttribute('data-u');
          api('POST', 'teams/' + tid + '/members/' + uid, { role: e.target.value }).then(function () { GC.toast('Role changed.'); back(); }, function (er) { GC.toast(er.message, 'err'); back(); });
        });
        el.addEventListener('click', function (e) {
          var a = e.target.closest('[data-a]'); if (!a || a.tagName === 'SELECT') return;
          var act = a.getAttribute('data-a'), u = a.closest('[data-u]'), uid = u && u.getAttribute('data-u'), who = uid && r.members.filter(function (m) { return m.id === uid; })[0];
          if (act === 'remove') { close(); GC.confirm('Remove ' + who.name + ' from “' + r.team.name + '”?', 'They lose access to the team workspace straight away, on all their devices. Their private jobs stay theirs.', 'Remove', true).then(function (y) { if (!y) { manage(tid); return; } api('DELETE', 'teams/' + tid + '/members/' + uid).then(function () { GC.toast(who.name + ' was removed.'); manage(tid); }, function (er) { GC.toast(er.message, 'err'); manage(tid); }); }); }
          else if (act === 'reset') {
            close(); GC.confirm('Reset ' + who.name + '’s password?', 'They are signed out on all their devices, and you get a temporary password to pass on to them. They can change it under ☁ › Change password.', 'Reset password', true).then(function (y) {
              if (!y) { manage(tid); return; }
              api('POST', 'teams/' + tid + '/members/' + uid + '/reset').then(function (x) {
                GC.modal('<h2>Temporary password for ' + esc(who.name) + '</h2><p class="sub">Give this to ' + esc(who.name) + ' in person or by phone. They sign in with ' + esc(who.email) + ' and this password.</p><div class="tm-code"><code>' + esc(x.password) + '</code></div><div class="actions"><button class="btn primary" data-a="ok">Done</button></div>',
                  function (el2, close2) { el2.querySelector('[data-a=ok]').onclick = function () { close2(); manage(tid); }; });
              }, function (er) { GC.toast(er.message, 'err'); manage(tid); });
            });
          }
          else if (act === 'code') {
            close();
            var known = (cfg().codes || {})[tid];
            if (known) { showCode(r.team, known); return; }
            GC.confirm('Make a new join code?', 'Join codes are only shown when they are made. A new one replaces the old code (people already in the team stay in it).', 'New code').then(function (y) {
              if (!y) { manage(tid); return; }
              api('POST', 'teams/' + tid + '/code').then(function (x) { GC.settings.cloud.codes = Object.assign({}, cfg().codes); GC.settings.cloud.codes[tid] = x.code; GC.saveSettings(); showCode(r.team, x.code); }, function (er) { GC.toast(er.message, 'err'); });
            });
          }
          else if (act === 'tname') { close(); GC.prompt('Team name', r.team.name, 'Name', 'Rename').then(function (n) { if (!n) { manage(tid); return; } api('POST', 'teams/' + tid, { name: n }).then(function (x) { updateTeam(x.team); manage(tid); }, function (er) { GC.toast(er.message, 'err'); }); }); }
          else if (act === 'leave') {
            close(); GC.confirm('Leave “' + r.team.name + '”?', 'You lose access to its team workspace on all your devices. Copies already on this device stay here.', 'Leave team', true).then(function (y) {
              if (!y) { manage(tid); return; }
              api('DELETE', 'teams/' + tid + '/members/' + me.id).then(function () {
                GC.settings.cloud.teams = (cfg().teams || []).filter(function (t) { return t.id !== tid; });
                if (cfg().team && cfg().team.id === tid) GC.settings.cloud.team = GC.settings.cloud.teams[0] || null;
                GC.saveSettings(); GC.cloud.refresh(); GC.toast('You left “' + r.team.name + '”.'); open();
              }, function (er) { GC.toast(er.message, 'err'); });
            });
          }
        });
      });
    }, function (e) { GC.busy(null); GC.toast(e.message, 'err'); });
  }
  function updateTeam(t) {
    GC.settings.cloud.teams = (cfg().teams || []).map(function (x) { return x.id === t.id ? Object.assign({}, x, { name: t.name }) : x; });
    if (cfg().team && cfg().team.id === t.id) GC.settings.cloud.team = Object.assign({}, cfg().team, { name: t.name });
    GC.saveSettings(); GC.cloud.refresh();
  }
  function pair() {
    api('POST', 'me/pair').then(function (r) {
      var shown = r.code.slice(0, 3) + ' ' + r.code.slice(3);
      GC.modal('<h2>Add a device</h2><p class="sub">On the new device open GeoCanvas, tap ☁ › <b>Use a code</b> and type:</p><div class="ac-pair">' + shown + '</div><p class="hint">Works once, for 10 minutes. Or just sign in there with your email and password.</p><div class="actions"><button class="btn primary" data-a="ok">Done</button></div>',
        function (el, close) { el.querySelector('[data-a=ok]').onclick = function () { close(); open(); }; });
    }, function (e) { GC.toast(e.message, 'err'); });
  }
  function changePassword() {
    GC.modal('<h2>Change password</h2><label class="field">Current password<input type="password" id="cp-old" autocomplete="current-password"></label><label class="field">New password<input type="password" id="cp-new" autocomplete="new-password" placeholder="At least 8 characters"></label><p class="hint">Your other devices are signed out; sign in there with the new password.</p><p class="fail" hidden></p><div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="go">Change</button></div>',
      function (el, close) {
        var msg = msgOf(el);
        el.querySelector('[data-a=no]').onclick = function () { close(); open(); };
        el.querySelector('[data-a=go]').onclick = function () { api('POST', 'me/password', { old: el.querySelector('#cp-old').value, new: el.querySelector('#cp-new').value }).then(function () { close(); GC.toast('Password changed.'); }, function (e) { msg(e.message); }); };
      });
  }
  function signOut() {
    GC.confirm('Sign out on this device?', 'Projects and private jobs stay on this device but stop saving to the cloud until you sign in again.', 'Sign out', true).then(function (y) {
      if (!y) return;
      api('POST', 'auth/logout').catch(function () {}).then(function () { forget(); GC.toast('Signed out.'); });
    });
  }
  /** This device is no longer signed in (signed out here, or from another device, or the password was reset). */
  function forget() {
    var c = cfg();
    GC.settings.lastEmail = (c.user && c.user.email) || GC.settings.lastEmail; GC.settings.lastName = c.device || GC.settings.lastName;
    delete GC.settings.cloud; GC.saveSettings(); GC.cloud.refresh();
  }

  if ($('btn-cloud')) $('btn-cloud').onclick = open;
  GC.account = { open: open, signIn: signInScreen, forget: forget, deviceGuess: deviceGuess };
})(window);

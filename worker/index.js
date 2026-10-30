/* GeoCanvas cloud sync — Cloudflare Worker.
   Static files are served by Workers Assets; only /api/* reaches this script.
   Storage is D1 (see migrations/). There can be any number of teams; each has a name, a join code and its own
   projects. Every request (except creating a team) carries the team's join code in X-GC-Key.

   Accounts (header X-GC-Session: a session token; X-GC-Team: a team id, or "me" for the person's private space):
   POST   /api/auth/signup                  {email, name, password, device} → {token, user, teams}
   POST   /api/auth/login                   {email, password, device} → {token, user, teams}
   POST   /api/auth/pair                    {code, device} → sign in with a 6-digit code from a signed-in device
   POST   /api/auth/logout                  sign this device out
   GET    /api/me                           {user, teams [{id, name, role}], devices}
   POST   /api/me                           {name} rename yourself; POST /api/me/password {old, new}
   POST   /api/me/pair                      → {code} for adding a device (valid 10 minutes)
   DELETE /api/me/devices/:id               sign one of your devices out
   POST   /api/teams                        {name} → a new team (you are its owner) and its join code
   POST   /api/teams/join                   {code} or {invite} → join a team (with its join code, or an invite link's token)
   GET    /api/invite/:token                which team an invite link is for → {team: {name}, by, expires} (no sign-in needed)
   GET    /api/teams/:id                    {team, role, code, members}
   POST   /api/teams/:id                    {name} rename (owner/admin); POST /api/teams/:id/code new join code (owner/admin)
   POST   /api/teams/:id/members/:uid       {role} (owner: make admin/member/owner); DELETE removes (owner/admin) or leaves (yourself)
   POST   /api/teams/:id/members/:uid/reset → a temporary password for a member who forgot theirs (owner/admin)
   POST   /api/teams/:id/invite             → {token, expires} a new invite link (owner/admin; valid 14 days); DELETE stops all of them
   Project routes below work for any project in one of your teams or your own space.

   Devices set up before accounts send the team's join code in X-GC-Key instead, as before:
   POST   /api/teams                        {name} → a new team and its join code (no code needed)
   GET    /api/ping                         check the join code → {team: {id, name}}
   POST   /api/team                         {name} → rename the team
   POST   /api/team/code                    → a new join code (the old one stops working)
   GET    /api/projects                     the team's projects
   GET    /api/projects/:id                 one project's manifest and revision
   PUT    /api/projects/:id                 {baseRev, manifest} → new revision, or 409 with the current one
   DELETE /api/projects/:id                 delete for everyone (leaves a tombstone so other devices know)
   POST   /api/projects/:id/missing         {hashes} → the ones the server does not have
   PUT    /api/projects/:id/blobs/:hash     store a blob (text: JSON, or base64 for binary files)
   GET    /api/projects/:id/blobs/:hash     fetch a blob
   Blobs of 32 KB or more live in R2 (binding FILES) when it is bound; D1 keeps a marker row for each. */

const CHUNK = 600000; // characters; ≤ 1.8 MB of UTF-8, under D1's 2 MB row limit
const MAX_BLOB = 90 * 1024 * 1024;
const ID = /^[0-9a-z]{4,40}$/i;
const HASH = /^[0-9a-f]{16,64}$/;
// Large items (map pieces, photos, big GIS data) are kept in R2 (binding FILES) when it is bound; D1 then holds a marker
// row "@r2:<length>" so uploads, the "missing" check and clean-up work the same for both.
const R2_MIN = 32 * 1024, R2_MARK = '@r2:';
const r2key = (pid, hash) => 'p/' + pid + '/' + hash;
const SIZE_SQL = "COALESCE(SUM(CASE WHEN data LIKE '@r2:%' THEN CAST(substr(data, 5) AS INTEGER) ELSE LENGTH(data) END), 0)";
async function r2Drop(env, pid, hashes) {
  if (!env.FILES || !hashes.length) return;
  for (let i = 0; i < hashes.length; i += 1000) await env.FILES.delete(hashes.slice(i, i + 1000).map((h) => r2key(pid, h)));
}
/** A large blob still in D1 moves to R2 the first time it is read. */
async function moveToR2(env, pid, hash, text) {
  await env.FILES.put(r2key(pid, hash), text, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM blobs WHERE pid = ? AND hash = ? AND idx > 0').bind(pid, hash),
    env.DB.prepare('UPDATE blobs SET data = ? WHERE pid = ? AND hash = ? AND idx = 0').bind(R2_MARK + text.length, pid, hash)
  ]);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url, ctx);
    } catch (e) {
      return json({ error: 'Server error: ' + (e && e.message ? e.message : String(e)) }, 500);
    }
  }
};

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
/** Join codes are typed however people like: case, spaces and dashes don't matter. */
function normCode(t) { const c = String(t || '').toLowerCase().replace(/[^a-z0-9]/g, ''), g = c.match(/.{1,4}/g); return g ? g.join('-') : ''; }
function newCode() { const r = new Uint32Array(12); crypto.getRandomValues(r); return normCode(Array.from(r, (x) => ALPHA[x % ALPHA.length]).join('')); }
function codeHash(code) { return sha256('gc-team:' + normCode(code)); }

const INVITE_DAYS = 14;
function inviteHash(token) { return sha256('gc-invite:' + String(token || '').toLowerCase().replace(/[^0-9a-f]/g, '')); }
/** The team an invite link's token is for, while the link is valid. */
async function inviteTeam(env, token) {
  return env.DB.prepare('SELECT t.id, t.name, u.name AS by_name, i.expires FROM invites i JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.created_by WHERE i.token_hash = ? AND i.expires > ?').bind(await inviteHash(token), Date.now()).first();
}
const MAX_FAILS = 20, MAX_NEW_TEAMS = 10, WINDOW = 10 * 60 * 1000;
function ipOf(request) { return request.headers.get('CF-Connecting-IP') || 'local'; }
async function count(env, ip, win) { const f = await env.DB.prepare('SELECT n FROM fails WHERE ip = ? AND win = ?').bind(ip, win).first(); return f ? f.n : 0; }
async function bump(env, ip, win) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO fails (ip, win, n) VALUES (?, ?, 1) ON CONFLICT(ip, win) DO UPDATE SET n = n + 1').bind(ip, win),
    env.DB.prepare('DELETE FROM fails WHERE win < ?').bind(win - 6)
  ]);
}
/** The team whose join code the request carries; 'locked' after too many wrong codes from one connection. */
async function teamOf(request, env) {
  const key = request.headers.get('X-GC-Key') || '';
  if (!normCode(key)) return null;
  const ip = ipOf(request), win = Math.floor(Date.now() / WINDOW);
  if (await count(env, ip, win) >= MAX_FAILS) return 'locked'; // refuse without even checking: stops guessing
  const t = await env.DB.prepare('SELECT id, name FROM teams WHERE codehash = ?').bind(await codeHash(key)).first();
  if (t) return t;
  await bump(env, ip, win);
  return null;
}

async function current(env, id) {
  return env.DB.prepare('SELECT id, rev, name, modified, device, size, deleted, manifest FROM projects WHERE id = ?').bind(id).first();
}
function shape(row) {
  return { id: row.id, rev: row.rev, name: row.name, modified: row.modified, device: row.device, size: row.size, deleted: !!row.deleted, manifest: row.manifest ? JSON.parse(row.manifest) : null };
}

/** Whether a project id is this team's ('mine'), another team's ('other') or not in the cloud yet ('none'). */
async function owner(env, team, id) {
  const r = await env.DB.prepare('SELECT team_id FROM projects WHERE id = ?').bind(id).first();
  return !r ? 'none' : r.team_id === team.id ? 'mine' : 'other';
}

// ---------- accounts ----------
const PBKDF2_ITER = 100000, MAX_LOGIN_FAILS = 10;
function hexOf(buf) { return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join(''); }
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hexOf(a); }
async function pwHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hexOf(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITER }, key, 256));
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function publicUser(u) { return { id: u.id, email: u.email, name: u.name }; }
async function newSession(env, uid, device) {
  const token = randHex(32), id = 's' + randHex(8), now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (id, token_hash, user_id, device, created, seen) VALUES (?, ?, ?, ?, ?, ?)').bind(id, await sha256('gc-session:' + token), uid, String(device || '').slice(0, 80), now, now).run();
  return token;
}
/** The signed-in person ({user, sid}) for a request with X-GC-Session; null if the session is unknown (signed out). */
async function userOf(request, env, ctx) {
  const token = request.headers.get('X-GC-Session') || '';
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const s = await env.DB.prepare('SELECT s.id AS sid, s.seen, u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(await sha256('gc-session:' + token)).first();
  if (!s) return null;
  if (Date.now() - s.seen > 3600000) { const q = env.DB.prepare('UPDATE sessions SET seen = ? WHERE id = ?').bind(Date.now(), s.sid).run(); if (ctx) ctx.waitUntil(q); else await q; }
  return { user: { id: s.id, email: s.email, name: s.name }, sid: s.sid };
}
async function roleIn(env, uid, tid) { const r = await env.DB.prepare('SELECT role FROM members WHERE team_id = ? AND user_id = ?').bind(tid, uid).first(); return r ? r.role : null; }
async function teamsOf(env, uid) {
  return (await env.DB.prepare('SELECT t.id, t.name, m.role FROM members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY m.joined').bind(uid).all()).results;
}
async function devicesOf(env, uid, sid) {
  return (await env.DB.prepare('SELECT id, device, created, seen FROM sessions WHERE user_id = ? ORDER BY seen DESC').bind(uid).all()).results.map((d) => Object.assign(d, { current: d.id === sid }));
}
function pairCode() { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(a[0] % 1000000).padStart(6, '0'); }
function tempPassword() { const a = new Uint32Array(8); crypto.getRandomValues(a); return Array.from(a, (x) => ALPHA[x % ALPHA.length]).join('').replace(/^(.{4})/, '$1-'); }
async function limited(env, request, kind, max) { const ip = kind + ':' + ipOf(request), win = Math.floor(Date.now() / WINDOW); return { over: (await count(env, ip, win)) >= max, fail: () => bump(env, ip, win) }; }

/** Sign-up, sign-in and pairing: no session needed. */
async function authApi(request, env, parts, m) {
  const body = await request.json().catch(() => ({}));
  const lim = await limited(env, request, 'auth', MAX_LOGIN_FAILS);
  if (lim.over) return json({ error: 'Too many tries from this connection. Wait 10 minutes and try again.' }, 429);
  const device = String(body.device || '').slice(0, 80);
  if (parts[2] === 'signup') {
    const email = normEmail(body.email), name = String(body.name || '').trim().slice(0, 80), pw = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Type a valid email address.' }, 400);
    if (!name) return json({ error: 'Type your name, so others can see who changed what.' }, 400);
    if (pw.length < 8) return json({ error: 'Use a password of at least 8 characters.' }, 400);
    if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(email).first()) return json({ error: 'There is already an account with that email. Sign in instead.' }, 409);
    const id = 'u' + randHex(8), salt = randHex(16);
    await env.DB.prepare('INSERT INTO users (id, email, name, pwhash, salt, created) VALUES (?, ?, ?, ?, ?, ?)').bind(id, email, name, await pwHash(pw, salt), salt, Date.now()).run();
    await lim.fail(); // sign-ups count towards the limit too
    return json({ token: await newSession(env, id, device), user: { id: id, email: email, name: name }, teams: [] });
  }
  if (parts[2] === 'login') {
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(normEmail(body.email)).first();
    if (!u || !same(await pwHash(String(body.password || ''), u.salt), u.pwhash)) { await lim.fail(); return json({ error: 'That email and password don’t match. Check them, or ask a team owner to reset your password.' }, 401); }
    return json({ token: await newSession(env, u.id, device), user: publicUser(u), teams: await teamsOf(env, u.id) });
  }
  if (parts[2] === 'pair') {
    const code = String(body.code || '').replace(/\D/g, '');
    const row = code.length === 6 ? await env.DB.prepare('SELECT user_id FROM pairing WHERE code_hash = ? AND expires > ?').bind(await sha256('gc-pair:' + code), Date.now()).first() : null;
    if (!row) { await lim.fail(); return json({ error: 'That code is not right or has expired. Make a new one on your other device.' }, 401); }
    await env.DB.prepare('DELETE FROM pairing WHERE code_hash = ?').bind(await sha256('gc-pair:' + code)).run();
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
    return json({ token: await newSession(env, u.id, device), user: publicUser(u), teams: await teamsOf(env, u.id) });
  }
  return json({ error: 'Not found.' }, 404);
}

/** Your account and your teams (signed in). Returns null when the route is not one of these. */
async function accountApi(request, env, parts, m, me) {
  const uid = me.user.id;
  const body = m === 'POST' ? await request.clone().json().catch(() => ({})) : {};
  if (parts[1] === 'auth' && parts[2] === 'logout' && m === 'POST') { await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(me.sid).run(); return json({ ok: true }); }
  if (parts[1] === 'me') {
    if (parts.length === 2 && m === 'GET') return json({ user: me.user, teams: await teamsOf(env, uid), devices: await devicesOf(env, uid, me.sid) });
    if (parts.length === 2 && m === 'POST') { const n = String(body.name || '').trim().slice(0, 80); if (!n) return json({ error: 'Type a name.' }, 400); await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(n, uid).run(); return json({ user: Object.assign({}, me.user, { name: n }) }); }
    if (parts[2] === 'password' && m === 'POST') {
      const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first(), nw = String(body.new || '');
      if (!same(await pwHash(String(body.old || ''), u.salt), u.pwhash)) return json({ error: 'Your current password is not right.' }, 403);
      if (nw.length < 8) return json({ error: 'Use a password of at least 8 characters.' }, 400);
      const salt = randHex(16);
      await env.DB.batch([env.DB.prepare('UPDATE users SET pwhash = ?, salt = ? WHERE id = ?').bind(await pwHash(nw, salt), salt, uid), env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(uid, me.sid)]);
      return json({ ok: true }); // other devices are signed out
    }
    if (parts[2] === 'pair' && m === 'POST') {
      const code = pairCode();
      await env.DB.batch([env.DB.prepare('DELETE FROM pairing WHERE expires < ? OR user_id = ?').bind(Date.now(), uid), env.DB.prepare('INSERT INTO pairing (code_hash, user_id, expires) VALUES (?, ?, ?)').bind(await sha256('gc-pair:' + code), uid, Date.now() + 10 * 60000)]);
      return json({ code: code, expires: Date.now() + 10 * 60000 });
    }
    if (parts[2] === 'devices' && parts[3] && m === 'DELETE') { await env.DB.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(parts[3], uid).run(); return json({ ok: true }); }
    return json({ error: 'Not found.' }, 404);
  }
  if (parts[1] !== 'teams') return null;
  if (parts.length === 2 && m === 'POST') { // a new team: you are its owner
    const lim = await limited(env, request, 'new', MAX_NEW_TEAMS);
    if (lim.over) return json({ error: 'Too many new teams from this connection. Wait 10 minutes and try again.' }, 429);
    const name = String(body.name || '').trim().slice(0, 80) || 'My team', code = newCode(), id = 'tm' + crypto.randomUUID().replace(/-/g, '').slice(0, 16), now = Date.now();
    await env.DB.batch([env.DB.prepare('INSERT INTO teams (id, name, codehash, created) VALUES (?, ?, ?, ?)').bind(id, name, await codeHash(code), now), env.DB.prepare('INSERT INTO members (team_id, user_id, role, joined) VALUES (?, ?, ?, ?)').bind(id, uid, 'owner', now)]);
    await lim.fail();
    return json({ code: code, team: { id: id, name: name, role: 'owner' } });
  }
  if (parts[2] === 'join' && parts.length === 3 && m === 'POST') {
    const lim = await limited(env, request, '', MAX_FAILS);
    if (lim.over) return json({ error: 'Too many wrong join codes from this connection. Wait 10 minutes and try again.' }, 429);
    const t = body.invite ? await inviteTeam(env, body.invite) : await env.DB.prepare('SELECT id, name FROM teams WHERE codehash = ?').bind(await codeHash(body.code)).first();
    if (!t) { await lim.fail(); return json({ error: body.invite ? 'This invite link has expired or was stopped. Ask the team’s owner or an admin for a new one.' : 'That join code is not right. Check it with someone in your team.' }, 401); }
    const had = await roleIn(env, uid, t.id);
    if (!had) await env.DB.prepare('INSERT INTO members (team_id, user_id, role, joined) VALUES (?, ?, ?, ?)').bind(t.id, uid, 'member', Date.now()).run();
    return json({ team: { id: t.id, name: t.name, role: had || 'member' } });
  }
  const tid = parts[2], role = tid ? await roleIn(env, uid, tid) : null;
  if (!role) return json({ error: 'You are not in that team.' }, 403);
  const boss = role === 'owner' || role === 'admin';
  const t = await env.DB.prepare('SELECT id, name FROM teams WHERE id = ?').bind(tid).first();
  if (parts.length === 3 && m === 'GET') {
    const members = (await env.DB.prepare('SELECT u.id, u.name, u.email, m.role, m.joined FROM members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.joined').bind(tid).all()).results;
    return json({ team: Object.assign({}, t, { role: role }), role: role, members: members });
  }
  if (parts.length === 3 && m === 'POST') {
    if (!boss) return json({ error: 'Only the team’s owner or an admin can rename it.' }, 403);
    const name = String(body.name || '').trim().slice(0, 80); if (!name) return json({ error: 'Give the team a name.' }, 400);
    await env.DB.prepare('UPDATE teams SET name = ? WHERE id = ?').bind(name, tid).run();
    return json({ team: { id: tid, name: name, role: role } });
  }
  if (parts[3] === 'code' && m === 'POST') {
    if (!boss) return json({ error: 'Only the team’s owner or an admin can change the join code.' }, 403);
    const code = newCode(); await env.DB.prepare('UPDATE teams SET codehash = ? WHERE id = ?').bind(await codeHash(code), tid).run();
    return json({ code: code });
  }
  if (parts[3] === 'invite' && parts.length === 4) {
    if (!boss) return json({ error: 'Only the team’s owner or an admin can invite people.' }, 403);
    if (m === 'DELETE') { await env.DB.prepare('DELETE FROM invites WHERE team_id = ?').bind(tid).run(); return json({ ok: true }); }
    if (m === 'POST') {
      const token = randHex(16), now = Date.now(), expires = now + INVITE_DAYS * 86400000;
      await env.DB.batch([env.DB.prepare('DELETE FROM invites WHERE expires < ?').bind(now), env.DB.prepare('INSERT INTO invites (token_hash, team_id, created_by, created, expires) VALUES (?, ?, ?, ?, ?)').bind(await inviteHash(token), tid, uid, now, expires)]);
      return json({ token: token, expires: expires });
    }
  }
  if (parts[3] === 'code' && m === 'GET') { // the join code itself is not stored: a new one is made only on request
    return json({ error: 'The join code is shown once when it is made. Make a new one to share it again.' }, 404);
  }
  if (parts[3] === 'members' && parts[4]) {
    const who = parts[4], theirs = await roleIn(env, who, tid);
    if (!theirs) return json({ error: 'That person is not in the team.' }, 404);
    const owners = (await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE team_id = ? AND role = 'owner'").bind(tid).first()).n;
    if (parts.length === 5 && m === 'DELETE') {
      if (who !== uid && !(role === 'owner' || (role === 'admin' && theirs === 'member'))) return json({ error: 'Admins can remove members; only an owner can remove an admin or owner.' }, 403);
      if (theirs === 'owner' && owners < 2) return json({ error: 'A team needs an owner: make someone else owner first.' }, 400);
      await env.DB.prepare('DELETE FROM members WHERE team_id = ? AND user_id = ?').bind(tid, who).run();
      return json({ ok: true });
    }
    if (parts.length === 5 && m === 'POST') {
      const nr = String(body.role || '');
      if (role !== 'owner') return json({ error: 'Only an owner can change roles.' }, 403);
      if (['owner', 'admin', 'member'].indexOf(nr) < 0) return json({ error: 'Bad role.' }, 400);
      if (theirs === 'owner' && nr !== 'owner' && owners < 2) return json({ error: 'A team needs an owner: make someone else owner first.' }, 400);
      await env.DB.prepare('UPDATE members SET role = ? WHERE team_id = ? AND user_id = ?').bind(nr, tid, who).run();
      return json({ ok: true });
    }
    if (parts[5] === 'reset' && m === 'POST') {
      if (!boss || who === uid) return json({ error: 'Only the team’s owner or an admin can reset someone else’s password.' }, 403);
      if (theirs === 'owner' && role !== 'owner') return json({ error: 'Only an owner can reset an owner’s password.' }, 403);
      const pw = tempPassword(), salt = randHex(16);
      await env.DB.batch([env.DB.prepare('UPDATE users SET pwhash = ?, salt = ? WHERE id = ?').bind(await pwHash(pw, salt), salt, who), env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(who)]);
      return json({ password: pw });
    }
  }
  return json({ error: 'Not found.' }, 404);
}

async function api(request, env, url, ctx) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = request.method;

  if (parts[1] === 'auth' && parts[2] !== 'logout' && m === 'POST') return authApi(request, env, parts, m);
  if (parts[1] === 'invite' && parts.length === 3 && m === 'GET') { // what an invite link is for, before signing in
    const lim = await limited(env, request, '', MAX_FAILS);
    if (lim.over) return json({ error: 'Too many tries from this connection. Wait 10 minutes and try again.' }, 429);
    const t = await inviteTeam(env, parts[2]);
    if (!t) { await lim.fail(); return json({ error: 'This invite link has expired or was stopped. Ask the team’s owner or an admin for a new one.' }, 404); }
    return json({ team: { name: t.name }, by: t.by_name || '', expires: t.expires });
  }
  if (request.headers.get('X-GC-Session')) return sessionApi(request, env, url, ctx, parts, m);

  if (parts[1] === 'teams' && parts.length === 2 && m === 'POST') { // create a team: open to anyone, rate-limited
    const ip = 'new:' + ipOf(request), win = Math.floor(Date.now() / WINDOW);
    if (await count(env, ip, win) >= MAX_NEW_TEAMS) return json({ error: 'Too many new teams from this connection. Wait 10 minutes and try again.' }, 429);
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim().slice(0, 80) || 'My team', code = newCode(), id = 'tm' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await env.DB.prepare('INSERT INTO teams (id, name, codehash, created) VALUES (?, ?, ?, ?)').bind(id, name, await codeHash(code), Date.now()).run();
    await bump(env, ip, win);
    return json({ code: code, team: { id: id, name: name } });
  }

  const team = await teamOf(request, env);
  if (team === 'locked') return json({ error: 'Too many wrong join codes from this connection. Wait 10 minutes and try again.' }, 429);
  if (!team) return json({ error: 'That join code is not right. Check it with someone in your team.' }, 401);

  if (parts[1] === 'ping' && m === 'GET') return json({ ok: true, team: team });

  if (parts[1] === 'team' && m === 'POST') {
    if (parts[2] === 'code') { // a new join code; the old one stops working
      const code = newCode();
      await env.DB.prepare('UPDATE teams SET codehash = ? WHERE id = ?').bind(await codeHash(code), team.id).run();
      return json({ code: code, team: team });
    }
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return json({ error: 'Give the team a name.' }, 400);
    await env.DB.prepare('UPDATE teams SET name = ? WHERE id = ?').bind(name, team.id).run();
    return json({ ok: true, team: { id: team.id, name: name } });
  }

  if (parts[1] !== 'projects') return json({ error: 'Not found.' }, 404);

  if (parts.length === 2 && m === 'GET') {
    const rows = (await env.DB.prepare('SELECT id, rev, name, modified, device, size, deleted FROM projects WHERE team_id = ? ORDER BY modified DESC').bind(team.id).all()).results;
    return json({ team: team, projects: rows.map((r) => ({ id: r.id, rev: r.rev, name: r.name, modified: r.modified, device: r.device, size: r.size, deleted: !!r.deleted })) });
  }

  const id = parts[2];
  if (!id || !ID.test(id)) return json({ error: 'Bad project id.' }, 400);
  const own = await owner(env, team, id);
  if (own === 'other') return json({ error: 'This project belongs to another team.' }, 403);
  return projectApi(request, env, ctx, parts, m, team, own);
}

/** One project's routes, for a team (or private space) that may use it; own: 'mine' (it is in that space) or 'none'. */
async function projectApi(request, env, ctx, parts, m, team, own) {
  const id = parts[2];
  if (parts.length === 3) {
    if (m === 'GET') {
      const row = own === 'mine' ? await current(env, id) : null;
      return row ? json(shape(row)) : json({ error: 'Not in the cloud.' }, 404);
    }
    if (m === 'PUT') return putProject(request, env, id, team);
    if (m === 'DELETE') {
      if (own !== 'mine') return json({ error: 'Not in the cloud.' }, 404);
      const inR2 = (await env.DB.prepare("SELECT hash FROM blobs WHERE pid = ? AND idx = 0 AND data LIKE '@r2:%'").bind(id).all()).results.map((r) => r.hash);
      await r2Drop(env, id, inR2);
      await env.DB.batch([
        env.DB.prepare('UPDATE projects SET deleted = 1, manifest = NULL, size = 0, rev = rev + 1, modified = ? WHERE id = ?').bind(Date.now(), id),
        env.DB.prepare('DELETE FROM blobs WHERE pid = ?').bind(id)
      ]);
      return json({ ok: true });
    }
  }

  if (parts[3] === 'missing' && parts.length === 4 && m === 'POST') {
    const body = await request.json();
    const hashes = (body.hashes || []).filter((h) => HASH.test(h));
    const have = new Set((await env.DB.prepare('SELECT hash FROM blobs WHERE pid = ?1 AND idx = 0 AND hash IN (SELECT value FROM json_each(?2))').bind(id, JSON.stringify(hashes)).all()).results.map((r) => r.hash));
    return json({ missing: hashes.filter((h) => !have.has(h)) });
  }

  if (parts[3] === 'blobs' && parts.length === 5) {
    const hash = parts[4];
    if (!HASH.test(hash)) return json({ error: 'Bad blob hash.' }, 400);
    if (m === 'GET') {
      if (own !== 'mine') return json({ error: 'Blob not found.' }, 404);
      const rows = (await env.DB.prepare('SELECT data FROM blobs WHERE pid = ? AND hash = ? ORDER BY idx').bind(id, hash).all()).results;
      if (!rows.length) return json({ error: 'Blob not found.' }, 404);
      const head = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=31536000, immutable' };
      if (rows.length === 1 && rows[0].data.startsWith(R2_MARK)) {
        const obj = env.FILES ? await env.FILES.get(r2key(id, hash)) : null;
        if (!obj) return json({ error: 'Blob not found.' }, 404);
        return new Response(obj.body, { headers: head });
      }
      const text = rows.map((r) => r.data).join('');
      if (env.FILES && text.length >= R2_MIN && ctx) ctx.waitUntil(moveToR2(env, id, hash, text).catch(() => {}));
      return new Response(text, { headers: head });
    }
    if (m === 'PUT') {
      const done = await env.DB.prepare('SELECT 1 AS x FROM blobs WHERE pid = ? AND hash = ? AND idx = 0').bind(id, hash).first();
      if (done) return json({ ok: true });
      const text = await request.text();
      if (text.length > MAX_BLOB) return json({ error: 'That item is too large for cloud sync (over 90 MB).' }, 413);
      if (env.FILES && text.length >= R2_MIN) { // R2 first, then the marker that says it is complete
        await env.FILES.put(r2key(id, hash), text, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
        await env.DB.batch([
          env.DB.prepare('DELETE FROM blobs WHERE pid = ? AND hash = ?').bind(id, hash),
          env.DB.prepare('INSERT INTO blobs (pid, hash, idx, data) VALUES (?, ?, 0, ?)').bind(id, hash, R2_MARK + text.length)
        ]);
        return json({ ok: true });
      }
      const chunks = [];
      for (let i = 0; i < text.length || i === 0; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
      await env.DB.prepare('DELETE FROM blobs WHERE pid = ? AND hash = ?').bind(id, hash).run();
      const ins = (i) => env.DB.prepare('INSERT INTO blobs (pid, hash, idx, data) VALUES (?, ?, ?, ?)').bind(id, hash, i, chunks[i]);
      // Chunk 0 last: its presence marks the blob complete.
      for (let i = chunks.length - 1; i >= 1; i -= 4) {
        const batch = [];
        for (let j = i; j > i - 4 && j >= 1; j--) batch.push(ins(j));
        await env.DB.batch(batch);
      }
      await ins(0).run();
      return json({ ok: true });
    }
  }
  return json({ error: 'Not found.' }, 404);
}

async function putProject(request, env, id, team) {
  const body = await request.json();
  const man = body.manifest, baseRev = body.baseRev | 0;
  if (!man || typeof man !== 'object' || !Array.isArray(man.blobs)) return json({ error: 'Bad manifest.' }, 400);
  const blobs = man.blobs.filter((h) => HASH.test(h));
  const have = (await env.DB.prepare('SELECT COUNT(*) AS n FROM blobs WHERE pid = ?1 AND idx = 0 AND hash IN (SELECT value FROM json_each(?2))').bind(id, JSON.stringify(blobs)).first()).n;
  if (have !== new Set(blobs).size) return json({ error: 'Some project data has not been uploaded yet.', retry: true }, 400);

  const text = JSON.stringify(man), name = String((man.meta && man.meta.name) || 'Untitled').slice(0, 200), device = String(man.device || '').slice(0, 80), now = Date.now();
  let res;
  if (baseRev === 0) {
    res = await env.DB.prepare('INSERT INTO projects (id, rev, name, modified, device, deleted, manifest, team_id) VALUES (?, 1, ?, ?, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING').bind(id, name, now, device, text, team.id).run();
  } else {
    res = await env.DB.prepare('UPDATE projects SET rev = rev + 1, name = ?, modified = ?, device = ?, deleted = 0, manifest = ? WHERE id = ? AND rev = ? AND team_id = ?').bind(name, now, device, text, id, baseRev, team.id).run();
  }
  if (!res.meta.changes) {
    const row = await current(env, id);
    return json(Object.assign({ error: 'Changed on another device.' }, row ? shape(row) : { rev: 0, missing: true }), 409);
  }
  // Drop data the new revision no longer uses, then record the project's size.
  const gone = (await env.DB.prepare("SELECT hash FROM blobs WHERE pid = ?1 AND idx = 0 AND data LIKE '@r2:%' AND hash NOT IN (SELECT value FROM json_each(?2))").bind(id, JSON.stringify(blobs)).all()).results.map((r) => r.hash);
  await env.DB.prepare('DELETE FROM blobs WHERE pid = ?1 AND hash NOT IN (SELECT value FROM json_each(?2))').bind(id, JSON.stringify(blobs)).run();
  await r2Drop(env, id, gone);
  const size = (await env.DB.prepare('SELECT ' + SIZE_SQL + ' AS s FROM blobs WHERE pid = ?').bind(id).first()).s;
  const row = await env.DB.prepare('UPDATE projects SET size = ? WHERE id = ? RETURNING rev, modified').bind(size, id).first();
  return json({ rev: row.rev, modified: row.modified });
}

/** Requests from a signed-in device: account routes, then projects in one of the person's teams or their own space. */
async function sessionApi(request, env, url, ctx, parts, m) {
  const me = await userOf(request, env, ctx);
  if (!me) return json({ error: 'You have been signed out on this device. Sign in again.', signedOut: true }, 401);
  const acc = await accountApi(request, env, parts, m, me);
  if (acc) return acc;
  const want = request.headers.get('X-GC-Team') || 'me';
  let space;
  if (want === 'me') space = { id: 'u' + me.user.id, name: me.user.name, personal: true };
  else {
    const role = await roleIn(env, me.user.id, want);
    if (!role) return json({ error: 'You are not in that team (any more).', notMember: true }, 403);
    space = Object.assign({ role: role }, await env.DB.prepare('SELECT id, name FROM teams WHERE id = ?').bind(want).first());
  }
  if (parts[1] === 'ping' && m === 'GET') return json({ ok: true, team: space.personal ? null : space, user: me.user });
  if (parts[1] !== 'projects') return json({ error: 'Not found.' }, 404);
  if (parts.length === 2 && m === 'GET') {
    const rows = (await env.DB.prepare('SELECT id, rev, name, modified, device, size, deleted FROM projects WHERE team_id = ? ORDER BY modified DESC').bind(space.id).all()).results;
    return json({ team: space, projects: rows.map((r) => ({ id: r.id, rev: r.rev, name: r.name, modified: r.modified, device: r.device, size: r.size, deleted: !!r.deleted })) });
  }
  // an existing project is reached in whichever of your spaces it lives; a new one goes into the space asked for
  const id = parts[2];
  if (!id || !ID.test(id)) return json({ error: 'Bad project id.' }, 400);
  const r = await env.DB.prepare('SELECT team_id FROM projects WHERE id = ?').bind(id).first();
  if (r) {
    const ok = r.team_id === 'u' + me.user.id || (r.team_id && r.team_id.charAt(0) !== 'u' && await roleIn(env, me.user.id, r.team_id));
    if (!ok) return json({ error: 'This project belongs to another team.' }, 403);
    space = { id: r.team_id };
  }
  return projectApi(request, env, ctx, parts, m, space, r ? 'mine' : 'none');
}

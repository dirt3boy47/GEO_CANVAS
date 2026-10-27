/* GeoCanvas cloud sync — Cloudflare Worker.
   Static files are served by Workers Assets; only /api/* reaches this script.
   Storage is D1 (see migrations/). There can be any number of teams; each has a name, a join code and its own
   projects. Every request (except creating a team) carries the team's join code in X-GC-Key.

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
   GET    /api/projects/:id/blobs/:hash     fetch a blob */

const CHUNK = 600000; // characters; ≤ 1.8 MB of UTF-8, under D1's 2 MB row limit
const MAX_BLOB = 90 * 1024 * 1024;
const ID = /^[0-9a-z]{4,40}$/i;
const HASH = /^[0-9a-f]{16,64}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url);
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

async function api(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = request.method;

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

  if (parts.length === 3) {
    if (m === 'GET') {
      const row = own === 'mine' ? await current(env, id) : null;
      return row ? json(shape(row)) : json({ error: 'Not in the cloud.' }, 404);
    }
    if (m === 'PUT') return putProject(request, env, id, team);
    if (m === 'DELETE') {
      if (own !== 'mine') return json({ error: 'Not in the cloud.' }, 404);
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
      return new Response(rows.map((r) => r.data).join(''), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=31536000, immutable' } });
    }
    if (m === 'PUT') {
      const done = await env.DB.prepare('SELECT 1 AS x FROM blobs WHERE pid = ? AND hash = ? AND idx = 0').bind(id, hash).first();
      if (done) return json({ ok: true });
      const text = await request.text();
      if (text.length > MAX_BLOB) return json({ error: 'That item is too large for cloud sync (over 90 MB).' }, 413);
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
  await env.DB.prepare('DELETE FROM blobs WHERE pid = ?1 AND hash NOT IN (SELECT value FROM json_each(?2))').bind(id, JSON.stringify(blobs)).run();
  const size = (await env.DB.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) AS s FROM blobs WHERE pid = ?').bind(id).first()).s;
  const row = await env.DB.prepare('UPDATE projects SET size = ? WHERE id = ? RETURNING rev, modified').bind(size, id).first();
  return json({ rev: row.rev, modified: row.modified });
}

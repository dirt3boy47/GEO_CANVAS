/* GeoCanvas cloud sync — Cloudflare Worker.
   Static files are served by Workers Assets; only /api/* reaches this script.
   Storage is D1 (see migrations/0001_init.sql). Every request carries the team passcode in X-GC-Key.

   GET    /api/ping                         check the passcode
   GET    /api/projects                     list shared projects
   GET    /api/projects/:id                 one project's manifest and revision
   PUT    /api/projects/:id                 {baseRev, manifest} → new revision, or 409 with the current one
   DELETE /api/projects/:id                 delete everywhere (leaves a tombstone so other devices know)
   POST   /api/projects/:id/missing         {hashes} → the ones the server does not have
   PUT    /api/projects/:id/blobs/:hash     store a blob (text: JSON, or base64 for binary files)
   GET    /api/projects/:id/blobs/:hash     fetch a blob
   POST   /api/passcode                     {key} → change the team passcode (or set the first one) */

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

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function authorised(request, env) {
  const key = request.headers.get('X-GC-Key') || '';
  const rows = (await env.DB.prepare("SELECT k, v FROM config WHERE k IN ('keyhash', 'salt')").all()).results;
  const cfg = {};
  rows.forEach((r) => { cfg[r.k] = r.v; });
  if (!cfg.keyhash) return 'unset';
  if (!key) return false;
  return sameText(await sha256((cfg.salt || '') + key), cfg.keyhash);
}

async function current(env, id) {
  return env.DB.prepare('SELECT id, rev, name, modified, device, size, deleted, manifest FROM projects WHERE id = ?').bind(id).first();
}
function shape(row) {
  return { id: row.id, rev: row.rev, name: row.name, modified: row.modified, device: row.device, size: row.size, deleted: !!row.deleted, manifest: row.manifest ? JSON.parse(row.manifest) : null };
}

async function api(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = request.method;
  const auth = await authorised(request, env);
  // With no passcode set (new database, or reset by clearing the config table), the first device to set one claims it.
  if (auth === 'unset' && !(parts[1] === 'passcode' && m === 'POST')) return json({ error: 'Cloud sync has no team passcode yet.', unset: true }, 503);
  if (!auth) return json({ error: 'Wrong team passcode.' }, 401);

  if (parts[1] === 'ping' && m === 'GET') return json({ ok: true });

  if (parts[1] === 'passcode' && m === 'POST') {
    const body = await request.json();
    const key = String(body.key || '');
    if (key.length < 8) return json({ error: 'The passcode must be at least 8 characters.' }, 400);
    const salt = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO config (k, v) VALUES ('salt', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(salt),
      env.DB.prepare("INSERT INTO config (k, v) VALUES ('keyhash', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(await sha256(salt + key))
    ]);
    return json({ ok: true });
  }

  if (parts[1] !== 'projects') return json({ error: 'Not found.' }, 404);

  if (parts.length === 2 && m === 'GET') {
    const rows = (await env.DB.prepare('SELECT id, rev, name, modified, device, size, deleted FROM projects ORDER BY modified DESC').all()).results;
    return json({ projects: rows.map((r) => ({ id: r.id, rev: r.rev, name: r.name, modified: r.modified, device: r.device, size: r.size, deleted: !!r.deleted })) });
  }

  const id = parts[2];
  if (!id || !ID.test(id)) return json({ error: 'Bad project id.' }, 400);

  if (parts.length === 3) {
    if (m === 'GET') {
      const row = await current(env, id);
      return row ? json(shape(row)) : json({ error: 'Not in the cloud.' }, 404);
    }
    if (m === 'PUT') return putProject(request, env, id);
    if (m === 'DELETE') {
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

async function putProject(request, env, id) {
  const body = await request.json();
  const man = body.manifest, baseRev = body.baseRev | 0;
  if (!man || typeof man !== 'object' || !Array.isArray(man.blobs)) return json({ error: 'Bad manifest.' }, 400);
  const blobs = man.blobs.filter((h) => HASH.test(h));
  const have = (await env.DB.prepare('SELECT COUNT(*) AS n FROM blobs WHERE pid = ?1 AND idx = 0 AND hash IN (SELECT value FROM json_each(?2))').bind(id, JSON.stringify(blobs)).first()).n;
  if (have !== new Set(blobs).size) return json({ error: 'Some project data has not been uploaded yet.', retry: true }, 400);

  const text = JSON.stringify(man), name = String((man.meta && man.meta.name) || 'Untitled').slice(0, 200), device = String(man.device || '').slice(0, 80), now = Date.now();
  let res;
  if (baseRev === 0) {
    res = await env.DB.prepare('INSERT INTO projects (id, rev, name, modified, device, deleted, manifest) VALUES (?, 1, ?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING').bind(id, name, now, device, text).run();
  } else {
    res = await env.DB.prepare('UPDATE projects SET rev = rev + 1, name = ?, modified = ?, device = ?, deleted = 0, manifest = ? WHERE id = ? AND rev = ?').bind(name, now, device, text, id, baseRev).run();
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

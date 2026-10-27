-- GeoCanvas cloud sync (Cloudflare D1).
-- projects: one row per shared project; `manifest` lists the project's layers and files by content hash.
-- blobs:    content-addressed layer data, item packs and original imported files, split into ≤1 MB chunks
--           (D1 rows are limited to 2 MB). Chunk 0 is written last, so its presence means the blob is complete.
-- config:   `keyhash` = SHA-256 of salt + team passcode, `salt`.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  name TEXT,
  modified INTEGER,
  device TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  manifest TEXT
);
CREATE TABLE IF NOT EXISTS blobs (
  pid TEXT NOT NULL,
  hash TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (pid, hash, idx)
);
CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT
);

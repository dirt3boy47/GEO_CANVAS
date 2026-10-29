-- User accounts: people sign in on each of their devices; teams belong to people (members), not devices.
-- users:    email + display name; password = PBKDF2-SHA256 (100k iterations) of the password with a random salt.
-- sessions: one per signed-in device; only a SHA-256 of the session token is stored.
-- members:  who is in which team, as owner / admin / member.
-- pairing:  short-lived 6-digit codes ("Add a device") that sign another device into the same account.
-- Private jobs live in each person's own space: projects.team_id = 'u' + user id.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pwhash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  device TEXT,
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  joined INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members (user_id);
CREATE TABLE IF NOT EXISTS pairing (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires INTEGER NOT NULL
);

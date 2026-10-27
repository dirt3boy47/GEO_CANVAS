-- Several teams, each with its own join code and its own projects.
-- codehash = SHA-256 of "gc-team:" + the normalised join code (codes are 12 random characters, so no salt is needed).
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  codehash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL
);
ALTER TABLE projects ADD COLUMN team_id TEXT;
CREATE INDEX IF NOT EXISTS projects_team ON projects (team_id, modified);

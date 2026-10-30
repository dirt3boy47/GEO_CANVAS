-- Team invite links: an owner or admin shares a link; whoever opens it signs in (or creates an account) and joins.
-- Only a SHA-256 of the link's token is stored. Links work for anyone who has them until they expire (14 days)
-- or the team stops all its invite links.
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_team ON invites (team_id);

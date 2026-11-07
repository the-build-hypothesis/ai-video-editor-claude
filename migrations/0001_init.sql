-- FrameForge initial schema. All timestamps are INTEGER milliseconds since epoch (UTC).
-- D1 enforces foreign keys; ON DELETE CASCADE removes dependent rows (R2 objects are deleted in code).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,                 -- lowercase; NULL for guests
  password_hash TEXT,                -- pbkdf2$<iter>$<salt_b64>$<hash_b64>; NULL for guests
  is_guest INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX idx_users_created ON users(created_at);
CREATE INDEX idx_users_guest_seen ON users(is_guest, last_seen_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,       -- hex SHA-256 of the cookie token; raw token never stored
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data TEXT NOT NULL,                -- canonical project JSON (see src/shared/model.ts)
  version INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER NOT NULL,
  duration_us INTEGER NOT NULL DEFAULT 0,
  thumbnail_asset_id TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_owner ON projects(owner_id, updated_at);
CREATE INDEX idx_projects_updated ON projects(updated_at);

CREATE TABLE project_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, version)
);
CREATE INDEX idx_revisions_project ON project_revisions(project_id, version);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video','image','audio')),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','failed')),
  metadata TEXT NOT NULL,            -- AssetMetadata JSON
  thumb_mime TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_assets_owner ON assets(owner_id, created_at);
CREATE INDEX idx_assets_status ON assets(status, created_at);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','canceled')),
  progress REAL NOT NULL DEFAULT 0,
  preset TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  fps INTEGER NOT NULL,
  duration_us INTEGER NOT NULL,
  size_bytes INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_exports_owner ON exports(owner_id, created_at);
CREATE INDEX idx_exports_project ON exports(project_id, created_at);
CREATE INDEX idx_exports_created ON exports(created_at);

-- No FK on purpose: usage/cost records are kept for aggregate metrics after a user is deleted.
-- Never contains prompts, transcripts or keys.
CREATE TABLE ai_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('transcribe','plan')),
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  audio_seconds REAL,
  cost_usd REAL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_ops_user ON ai_operations(user_id, created_at);
CREATE INDEX idx_ai_ops_project ON ai_operations(project_id, created_at);
CREATE INDEX idx_ai_ops_created ON ai_operations(created_at);

-- Fixed-window counters. key examples: 'login:<ip>:<email>', 'register:<ip>', 'export:<userId>'.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);

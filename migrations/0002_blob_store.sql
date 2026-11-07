-- Fallback object storage in D1, used only when no R2 binding (MEDIA) is configured.
-- Objects are split into ≤1 MB chunks (D1 row limit is 2 MB).
CREATE TABLE IF NOT EXISTS blob_objects (
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  chunk_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blob_chunks (
  key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key, idx)
);

-- Multipart upload state for large assets (JSON: { uploadId, partSize, parts: [{partNumber, etag}] }).
ALTER TABLE assets ADD COLUMN upload_state TEXT;

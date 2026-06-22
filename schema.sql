-- ============================================================================
-- SMART MULTIPART DOWNLOAD MANAGER SCHEMA
-- For PostgreSQL (Works on standard setups & Termux / Android environment)
-- ============================================================================

-- Drop tables if they already exist to restart cleanly (be careful on production systems)
DROP TABLE IF EXISTS chunks CASCADE;
DROP TABLE IF EXISTS downloads CASCADE;
DROP TABLE IF EXISTS settings CASCADE;

-- ----------------------------------------------------------------------------
-- Table 1: downloads
-- Holds metadata, overall download status, and scheduling timestamps.
-- ----------------------------------------------------------------------------
CREATE TABLE downloads (
                           id TEXT PRIMARY KEY,
                           url TEXT NOT NULL,
                           filename TEXT NOT NULL,
                           directory TEXT NOT NULL,
                           total_size BIGINT,
                           downloaded_size BIGINT DEFAULT 0,
                           chunk_count INTEGER DEFAULT 1,
                           status TEXT DEFAULT 'PENDING', -- 'PENDING', 'DOWNLOADING', 'PAUSED', 'COMPLETED', 'ERROR', 'SCHEDULED'
                           scheduled_at TIMESTAMP,
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for status to speed up state filters and queue retrieval
CREATE INDEX idx_downloads_status ON downloads(status);

-- ----------------------------------------------------------------------------
-- Table 2: chunks
-- Tracks byte ranges and individual stream/slice progress for multipart downloading.
-- ----------------------------------------------------------------------------
CREATE TABLE chunks (
                        id TEXT PRIMARY KEY,
                        download_id TEXT REFERENCES downloads(id) ON DELETE CASCADE,
                        index INTEGER NOT NULL,
                        start_byte BIGINT NOT NULL,
                        end_byte BIGINT,
                        downloaded_bytes BIGINT DEFAULT 0,
                        status TEXT DEFAULT 'PENDING', -- 'PENDING', 'ACTIVE', 'DONE', 'ERROR'
                        UNIQUE(download_id, index)
);

-- Index to optimize chunk range lookup speed
CREATE INDEX idx_chunks_download_id ON chunks(download_id);

-- ----------------------------------------------------------------------------
-- Table 3: settings
-- Persistent configuration keys and JSON payloads.
-- ----------------------------------------------------------------------------
CREATE TABLE settings (
                          key TEXT PRIMARY KEY,
                          value JSONB NOT NULL
);

-- Inject defaults into settings
INSERT INTO settings (key, value) VALUES
                                      ('downloadDirectory', '"./downloads"'),
                                      ('maxConcurrentTasks', '3'),
                                      ('defaultChunkCount', '4')
    ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Trigger Function: Automatic UpdatedAt Synchronization
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_downloads_updated_at
    BEFORE UPDATE ON downloads
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
DROP TABLE IF EXISTS chunks CASCADE;
DROP TABLE IF EXISTS downloads CASCADE;
DROP TABLE IF EXISTS settings CASCADE;

CREATE TYPE status_enum AS ENUM ('PENDING', 'DOWNLOADING', 'PAUSED', 'COMPLETED', 'ERROR', 'SCHEDULED');
CREATE TYPE chunk_status_enum AS ENUM ('PENDING', 'ACTIVE', 'DONE', 'ERROR');

CREATE TABLE downloads (
                           id TEXT PRIMARY KEY,
                           url TEXT NOT NULL,
                           filename TEXT NOT NULL,
                           directory TEXT NOT NULL,
                           total_size BIGINT,
                           downloaded_size BIGINT DEFAULT 0,
                           chunk_count INTEGER DEFAULT 1,
                           status status_enum DEFAULT 'PENDING',
                           scheduled_at TIMESTAMP,
                           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_downloads_status ON downloads(status);

CREATE TABLE chunks (
                        id TEXT PRIMARY KEY,
                        download_id TEXT REFERENCES downloads(id) ON DELETE CASCADE,
                        index INTEGER NOT NULL,
                        start_byte BIGINT NOT NULL,
                        end_byte BIGINT,
                        downloaded_bytes BIGINT DEFAULT 0,
                        status chunk_status_enum DEFAULT 'PENDING',
                        UNIQUE(download_id, index)
);

CREATE TABLE settings (
                          key TEXT PRIMARY KEY,
                          value JSONB NOT NULL
);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_downloads_updated_at
    BEFORE UPDATE ON downloads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
-- Apply explicitly; the application never runs migrations on startup.
CREATE TABLE IF NOT EXISTS weather_snapshots (
 coordinate_key TEXT NOT NULL,
 fetched_at TIMESTAMPTZ NOT NULL,
 window_end TIMESTAMPTZ NOT NULL,
 payload JSONB NOT NULL,
 PRIMARY KEY (coordinate_key,fetched_at)
);
CREATE INDEX IF NOT EXISTS weather_snapshots_window_idx ON weather_snapshots(window_end DESC);

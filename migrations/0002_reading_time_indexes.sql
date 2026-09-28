-- Queries order and filter by datetime(COALESCE(sampled_at, received_at)).
-- The indexes in 0001 cover the raw columns, so SQLite could not use them for
-- that expression and every summary request scanned the whole table. These
-- expression indexes must match READING_TIME_SQL in src/database/time.ts exactly.
DROP INDEX idx_readings_sampled_at;
DROP INDEX idx_readings_probe_sampled;
DROP INDEX idx_readings_source_sampled;

CREATE INDEX idx_readings_probe_time
  ON readings (probe_id, datetime(COALESCE(sampled_at, received_at)), received_at);
CREATE INDEX idx_readings_source_time
  ON readings (source, datetime(COALESCE(sampled_at, received_at)));

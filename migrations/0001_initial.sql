-- Single-row site configuration. Admin routes (phase C3) update this row.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  alert_threshold_c REAL NOT NULL DEFAULT 25.0,
  alert_cooldown_hours INTEGER NOT NULL DEFAULT 24,
  alerts_enabled INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  email_recipients TEXT NOT NULL DEFAULT '[]',
  last_alert_at TEXT,
  probe_layout TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per probe reading. Ten rows from one hub upload share sample_id.
CREATE TABLE readings (
  sample_id TEXT NOT NULL,
  probe_id TEXT NOT NULL,
  sampled_at TEXT,
  received_at TEXT NOT NULL,
  source TEXT NOT NULL,
  time_quality TEXT NOT NULL,
  raw_temperature_c REAL,
  temperature_c REAL,
  status TEXT NOT NULL,
  battery_v REAL,
  external_power INTEGER NOT NULL,
  firmware_version TEXT NOT NULL,
  upload_sequence INTEGER NOT NULL,
  hub_id TEXT NOT NULL,
  channel INTEGER NOT NULL,
  rom_id TEXT,
  PRIMARY KEY (sample_id, probe_id)
);

CREATE INDEX idx_readings_sampled_at ON readings (sampled_at);
CREATE INDEX idx_readings_probe_sampled ON readings (probe_id, sampled_at);
CREATE INDEX idx_readings_source_sampled ON readings (source, sampled_at);

INSERT INTO settings (
  id,
  alert_threshold_c,
  alert_cooldown_hours,
  alerts_enabled,
  timezone,
  email_recipients,
  last_alert_at,
  probe_layout,
  updated_at
) VALUES (
  1,
  25.0,
  24,
  0,
  'Europe/London',
  '[]',
  NULL,
  '{"probes":[{"probeId":"grain-01","label":"Grain 1","kind":"grain","row":0,"col":0},{"probeId":"grain-02","label":"Grain 2","kind":"grain","row":0,"col":1},{"probeId":"grain-03","label":"Grain 3","kind":"grain","row":0,"col":2},{"probeId":"grain-04","label":"Grain 4","kind":"grain","row":1,"col":0},{"probeId":"grain-05","label":"Grain 5","kind":"grain","row":1,"col":1},{"probeId":"grain-06","label":"Grain 6","kind":"grain","row":1,"col":2},{"probeId":"grain-07","label":"Grain 7","kind":"grain","row":2,"col":0},{"probeId":"grain-08","label":"Grain 8","kind":"grain","row":2,"col":1},{"probeId":"grain-09","label":"Grain 9","kind":"grain","row":2,"col":2},{"probeId":"air-01","label":"Air","kind":"air"}]}',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
);

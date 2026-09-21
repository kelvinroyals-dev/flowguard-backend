-- ============================================================================
-- Firmware releases + staged rollouts (deployment rings) with rollback.
-- A rollout targets a release at a device set (fleet or tag) and advances
-- through cumulative percentage rings (e.g. 5% → 25% → 100%), queueing a
-- firmware_update command per device as each ring opens. Ops can pause,
-- advance, or roll back (re-flash the prior version). Devices under an active
-- protection window are deferred, not skipped. "updated" is judged by the
-- device actually reporting the target firmware — not by the command being sent.
-- ============================================================================
CREATE TABLE IF NOT EXISTS firmware_releases (
  id           SERIAL PRIMARY KEY,
  version      VARCHAR(40) UNIQUE NOT NULL,
  channel      VARCHAR(12) NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable','beta','internal')),
  notes        TEXT,
  artifact_url TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS firmware_rollouts (
  id           SERIAL PRIMARY KEY,
  release_id   INTEGER NOT NULL REFERENCES firmware_releases(id) ON DELETE CASCADE,
  name         VARCHAR(120),
  target_type  VARCHAR(12) NOT NULL CHECK (target_type IN ('fleet','tag')),
  target_value VARCHAR(64),                 -- tag name; NULL for fleet
  rings        INTEGER[] NOT NULL DEFAULT '{5,25,100}',  -- cumulative percents
  current_ring INTEGER NOT NULL DEFAULT -1, -- -1 = created, nothing deployed yet
  status       VARCHAR(14) NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','paused','completed','rolled_back','cancelled')),
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS firmware_rollout_targets (
  id           SERIAL PRIMARY KEY,
  rollout_id   INTEGER NOT NULL REFERENCES firmware_rollouts(id) ON DELETE CASCADE,
  sensor_id    VARCHAR(50) NOT NULL REFERENCES sensors(sensor_id) ON DELETE CASCADE,
  ring         INTEGER NOT NULL,
  from_version VARCHAR(40),                 -- what it was on at rollout creation (for rollback)
  status       VARCHAR(10) NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','queued','updated','failed')),
  command_id   INTEGER,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rollout_id, sensor_id)
);
CREATE INDEX IF NOT EXISTS idx_fr_targets_rollout ON firmware_rollout_targets(rollout_id);

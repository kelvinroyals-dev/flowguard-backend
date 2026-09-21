-- ============================================================================
-- Offline command queue — expiry + delivery-time safety hold.
-- A queued command can carry an expiry (auto-'expired' if the device never
-- reconnects in time). At delivery, disruptive commands (reboot/firmware) are
-- re-checked against protection windows and the live high-water rule; if unsafe
-- they are HELD (kept queued, hold_reason recorded) rather than handed over.
-- ============================================================================
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMPTZ;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS hold_reason TEXT;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS held_at     TIMESTAMPTZ;

ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_status_check;
ALTER TABLE device_commands ADD CONSTRAINT device_commands_status_check
  CHECK (status IN ('queued','delivered','acknowledged','failed','cancelled','expired'));

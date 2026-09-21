-- ============================================================================
-- Expanded remote-action vocabulary for device_commands.
-- Adds operational commands beyond reboot/firmware/config: connectivity &
-- diagnostics (force_sync, connectivity_test, self_test, reconnect_modem,
-- refresh_gps, diagnostic_bundle, locate), configuration (set_reporting_interval,
-- set_thresholds, enable_sensor, disable_sensor, reset_config), and heavy
-- lifecycle actions (factory_reset, reprovision).
-- The disruptive subset (reset, firmware_update, reset_config, factory_reset,
-- reprovision) stays gated by the command-safety policy in the app layer.
-- ============================================================================
ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_command_type_check;
ALTER TABLE device_commands ADD CONSTRAINT device_commands_command_type_check
  CHECK (command_type IN (
    'firmware_update','reset','recalibrate','apply_config',
    'force_sync','connectivity_test','self_test','reconnect_modem','refresh_gps',
    'diagnostic_bundle','locate','set_reporting_interval','set_thresholds',
    'enable_sensor','disable_sensor','reset_config','factory_reset','reprovision'
  ));

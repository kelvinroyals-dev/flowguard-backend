# FlowGuard Device Integration Guide (Third-Party SDK Contract)

This is the contract a third-party device (or gateway) implements to plug into
FlowGuard's Sentinel platform. FlowGuard normalises any conforming device onto
the same telemetry, command, integrity and lifecycle model as a first-party
Sentinel node, through a **driver**.

## 1. Concepts

- **Device** — one physical unit, identified by a `sensor_id` and authenticated
  by a secret device key.
- **Driver** — an adapter record (`device_drivers`) describing a make/model:
  its `capabilities`, a `field_map` translating the device's raw telemetry to
  FlowGuard's canonical fields, and the subset of the command vocabulary it
  supports. A device is bound to a driver via `sensors.driver_id`. The built-in
  `sentinel-native` driver is an identity mapping with full command support.
- **Store-and-forward** — commands are queued server-side and delivered on the
  device's next check-in; nothing is pushed to the device.

## 2. Authentication

Every request from a device carries its key:

```
X-Device-Key: <device key issued at provisioning>
```

The key is stored only as a SHA-256 hash server-side. A device may never claim a
different `sensor_id` than the one its key resolves to.

## 3. Reporting telemetry — `POST /api/v1/monitoring/readings`

Send a JSON body at your reporting interval. Fields may use **canonical** names
(below) or your **own vendor names** if your driver's `field_map` remaps them.

Canonical reading fields:

| Field                 | Unit / range        | Notes                              |
|-----------------------|---------------------|------------------------------------|
| `sensor_id`           | string              | Optional; must match your key      |
| `water_level_percent` | 0–100               |                                    |
| `water_level_liters`  | 0–10,000,000        |                                    |
| `inflow_rate`         | L/s, 0–100,000      |                                    |
| `outflow_rate`        | L/s, 0–100,000      |                                    |
| `temperature`         | °C, -20–80          |                                    |
| `battery_voltage`     | V, 0–6              |                                    |
| `signal_strength`     | %, 0–100            |                                    |
| `debris_detected`     | boolean             |                                    |
| `firmware_version`    | string              |                                    |
| `time`                | ISO-8601            | The reading's timestamp (may be a  |
|                       |                     | buffered past reading)             |

Integrity signals (optional, all folded into the device's integrity state):

| Field           | Meaning                                                      |
|-----------------|-------------------------------------------------------------|
| `device_clock`  | The device's *current* wall-clock at send time (ISO-8601).  |
|                 | Used to compute clock skew — distinct from `time`.          |
| `latitude`,     | Current GPS fix; compared to the geofence anchor.           |
| `longitude`     |                                                             |
| `tamper`        | boolean; `true` raises the tamper flag until ops clears it. |
| `tamper_reason` | optional string.                                            |

### Field mapping (vendor payloads)

If your device posts flat vendor JSON, define a `field_map` on your driver as
`{ canonical_field: "vendor.dot.path" }`. On ingest FlowGuard remaps before
validation. Example driver `field_map`:

```json
{
  "water_level_percent": "level_pct",
  "inflow_rate": "flow_lps",
  "temperature": "temp_c",
  "battery_voltage": "batt_v",
  "signal_strength": "rssi_pct"
}
```

so a device may post `{ "level_pct": 62, "flow_lps": 3.4, "batt_v": 3.9 }`.

The response acknowledges the reading and hands over any queued commands:

```json
{ "success": true, "commands": [ { "id": 12, "type": "force_sync", "payload": null } ] }
```

## 4. Receiving commands

Commands ride back on the `POST /readings` response (`commands[]`). Each has an
`id`, a `type` (from the vocabulary below), and an optional `payload`. Your
device should apply what it can and — where supported — acknowledge.

Command vocabulary (a driver advertises the subset it supports; unsupported
commands are rejected at queue time):

```
firmware_update, reset, recalibrate, apply_config,
force_sync, connectivity_test, self_test, reconnect_modem, refresh_gps,
diagnostic_bundle, locate, set_reporting_interval, set_thresholds,
enable_sensor, disable_sensor, reset_config, factory_reset, reprovision
```

Parameterised payloads:

- `set_reporting_interval` → `{ "interval_seconds": 300 }` (30–86400)
- `set_thresholds` → `{ "thresholds": { "level_high_pct": 80, "level_low_pct": 15 } }`
- `enable_sensor` / `disable_sensor` → `{ "channel": "water_level" }`
- `firmware_update` → `{ "firmware_version": "2.4.1" }`

Disruptive commands (`reset`, `firmware_update`, `reset_config`,
`factory_reset`, `reprovision`) are additionally gated by FlowGuard's
command-safety policy and may be held at delivery during a flood window.

## 5. Onboarding a new device type

1. Create a driver via `POST /api/v1/device-drivers` with your `capabilities`,
   `field_map` and supported `commands`.
2. Provision the device (issue its key) and bind it:
   `PUT /api/v1/monitoring/sensors/:id/driver { "driver_id": <id> }`.
3. The device begins posting to `/readings`; telemetry is normalised, commands
   are gated to the driver's supported set, and the unit appears in the fleet
   exactly like a Sentinel — health, integrity, lifecycle, analytics and all.

## 6. Notes

- Auth types: `device_key` (default), `hmac`, `bearer` — declared per driver.
- A driver's `active: false` retires it from new bindings without deleting it.
- The `sentinel-native` driver is immutable in identity (its key and native
  flag) and represents first-party hardware.

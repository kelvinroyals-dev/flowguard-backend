"""Build a labelled training set from sensor_readings + flood_incident labels.

One row per (estate, hourly timestamp t):
  features  — the same signals the Node feature engine uses (utils/features.js),
              computed as-of time t so there is NO leakage from the future.
  label     — 1 if a flood_incident occurred at that estate within the next
              HORIZON_H hours, else 0.

Output: backend/ml/data/dataset.parquet

Usage:
  python export_dataset.py --horizon 24 --cadence 6 --days 365
"""
import argparse
import numpy as np
import pandas as pd
from db import query_df, DATA_DIR

# Readings rolled up sensor -> asset -> estate (COALESCE parent estate).
READINGS_SQL = """
SELECT COALESCE(asset.parent_property_id, asset.property_id) AS estate_id,
       r.time,
       r.water_level_percent, r.silt_depth_mm,
       r.inflow_rate, r.outflow_rate, r.rainfall_mm
  FROM sensor_readings r
  JOIN sensors s      ON s.sensor_id = r.sensor_id
  JOIN properties asset ON asset.property_id = s.property_id
 WHERE r.time >= NOW() - (%(days)s || ' days')::interval
"""

LABELS_SQL = """
SELECT property_id AS estate_id, occurred_at
  FROM property_events
 WHERE event_type = 'flood_incident'
   AND occurred_at >= NOW() - (%(days)s || ' days')::interval
"""


def hourly_estate_frame(days: int) -> pd.DataFrame:
    raw = query_df(READINGS_SQL, {"days": str(days)})
    if raw.empty:
        return raw
    raw["time"] = pd.to_datetime(raw["time"], utc=True)
    # Mean across sensors, resampled hourly per estate.
    out = []
    for estate, g in raw.groupby("estate_id"):
        h = (g.set_index("time")
               .sort_index()
               .resample("1h")[["water_level_percent", "silt_depth_mm",
                                 "inflow_rate", "outflow_rate", "rainfall_mm"]]
               .mean())
        h["estate_id"] = estate
        out.append(h)
    return pd.concat(out).reset_index()


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Rolling, as-of-t features mirroring utils/features.js."""
    df = df.sort_values(["estate_id", "time"]).copy()
    g = df.groupby("estate_id", group_keys=False)

    df["level_now"] = df["water_level_percent"]
    df["level_1h_ago"] = g["water_level_percent"].shift(1)
    df["level_change_1h"] = df["level_now"] - df["level_1h_ago"]
    # rise rate over the last 3h (%/hr), positive = filling
    df["level_3h_ago"] = g["water_level_percent"].shift(3)
    df["rise_rate_pph"] = (df["level_now"] - df["level_3h_ago"]) / 3.0
    df["level_avg_6h"] = g["water_level_percent"].transform(lambda s: s.rolling(6, min_periods=1).mean())
    df["level_max_6h"] = g["water_level_percent"].transform(lambda s: s.rolling(6, min_periods=1).max())
    df["silt_now"] = df["silt_depth_mm"]
    df["silt_avg_24h"] = g["silt_depth_mm"].transform(lambda s: s.rolling(24, min_periods=1).mean())
    df["net_flow"] = df["inflow_rate"].fillna(0) - df["outflow_rate"].fillna(0)
    df["rain_1h"] = df["rainfall_mm"]
    df["rain_3h"] = g["rainfall_mm"].transform(lambda s: s.rolling(3, min_periods=1).sum())
    df["rain_6h"] = g["rainfall_mm"].transform(lambda s: s.rolling(6, min_periods=1).sum())
    return df


FEATURE_COLS = [
    "level_now", "level_change_1h", "rise_rate_pph", "level_avg_6h", "level_max_6h",
    "silt_now", "silt_avg_24h", "net_flow", "rain_1h", "rain_3h", "rain_6h",
]


def attach_labels(df: pd.DataFrame, labels: pd.DataFrame, horizon_h: int) -> pd.DataFrame:
    df["label"] = 0
    if labels.empty:
        return df
    labels = labels.copy()
    labels["occurred_at"] = pd.to_datetime(labels["occurred_at"], utc=True)
    for estate, evs in labels.groupby("estate_id"):
        mask_estate = df["estate_id"] == estate
        if not mask_estate.any():
            continue
        times = df.loc[mask_estate, "time"]
        hit = np.zeros(len(times), dtype=bool)
        for t0 in evs["occurred_at"]:
            window_start = t0 - pd.Timedelta(hours=horizon_h)
            hit |= (times >= window_start) & (times < t0)
        df.loc[mask_estate, "label"] = hit.astype(int)
    return df


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--horizon", type=int, default=24, help="predict a flood within the next N hours")
    ap.add_argument("--cadence", type=int, default=6, help="sample every N hours to reduce autocorrelation")
    ap.add_argument("--days", type=int, default=365)
    args = ap.parse_args()

    frame = hourly_estate_frame(args.days)
    if frame.empty:
        print("No sensor_readings found — nothing to export.")
        return
    frame = build_features(frame)
    labels = query_df(LABELS_SQL, {"days": str(args.days)})
    frame = attach_labels(frame, labels, args.horizon)

    # Sample at cadence; drop rows without a usable level reading.
    frame = frame.dropna(subset=["level_now"])
    frame = frame[frame["time"].dt.hour % args.cadence == 0]
    ds = frame[["estate_id", "time", "label"] + FEATURE_COLS].copy()
    ds[FEATURE_COLS] = ds[FEATURE_COLS].fillna(0.0)

    out = DATA_DIR / "dataset.parquet"
    ds.to_parquet(out, index=False)
    pos = int(ds["label"].sum())
    print(f"Wrote {out} — {len(ds):,} rows, {pos:,} positive ({100*pos/max(len(ds),1):.2f}%), "
          f"{ds['estate_id'].nunique()} estates, horizon {args.horizon}h.")
    if pos == 0:
        print("NOTE: no positive labels yet. Log real flood_incident events (ops → AI Risk "
              "Forecast → Log flood incident) before training a supervised model.")


if __name__ == "__main__":
    main()

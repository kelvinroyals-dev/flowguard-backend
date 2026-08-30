"""Unsupervised anomaly detection over estate sensor states (IsolationForest).

Complements the supervised model: it needs NO labels, so it works from day one.
It flags sensor states that are statistically unusual for the network — e.g. a
sharp water-level rise with no rain (a blockage signature), which the rule-based
engine also catches but this generalises to patterns nobody hand-coded.

Usage:
  python anomaly.py --days 120 --contamination 0.02
"""
import argparse
import pandas as pd
import joblib
from db import DATA_DIR, MODEL_DIR
from export_dataset import hourly_estate_frame, build_features, FEATURE_COLS


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--contamination", type=float, default=0.02)
    args = ap.parse_args()

    frame = hourly_estate_frame(args.days)
    if frame.empty:
        print("No sensor_readings — nothing to fit.")
        return
    frame = build_features(frame).dropna(subset=["level_now"])
    X = frame[FEATURE_COLS].fillna(0.0)

    from sklearn.ensemble import IsolationForest
    iso = IsolationForest(n_estimators=300, contamination=args.contamination, random_state=42)
    frame["anomaly"] = iso.fit_predict(X)          # -1 = anomaly
    frame["anomaly_score"] = -iso.score_samples(X)  # higher = more anomalous

    joblib.dump(iso, MODEL_DIR / "anomaly_iforest.joblib")
    flagged = frame[frame["anomaly"] == -1].sort_values("anomaly_score", ascending=False)
    out = DATA_DIR / "anomalies.csv"
    flagged[["estate_id", "time", "anomaly_score"] + FEATURE_COLS].to_csv(out, index=False)
    print(f"Fit on {len(frame):,} states — flagged {len(flagged):,} anomalies -> {out}")
    if len(flagged):
        print("\nMost anomalous recent states:")
        print(flagged.head(10)[["estate_id", "time", "anomaly_score",
                                 "level_now", "rise_rate_pph", "rain_1h", "silt_now"]].to_string(index=False))


if __name__ == "__main__":
    main()

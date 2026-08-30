"""Walk-forward backtest: does the model hold up out-of-sample over time?

Splits the timeline into sequential folds. For each fold boundary it trains on
everything before and evaluates on the next slice — the only honest way to test
a forecaster, because it never lets the model see the future it's scored on.

Usage:
  python backtest.py --folds 5
"""
import argparse
import json
import numpy as np
import pandas as pd
from db import DATA_DIR, MODEL_DIR
from export_dataset import FEATURE_COLS


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", type=int, default=5)
    args = ap.parse_args()

    path = DATA_DIR / "dataset.parquet"
    if not path.exists():
        print("No dataset — run export_dataset.py first.")
        return
    df = pd.read_parquet(path).sort_values("time").reset_index(drop=True)
    if df["label"].sum() < args.folds * 3:
        print("Too few positive labels for a stable backtest — collect more incidents first.")
        return

    from xgboost import XGBClassifier
    from sklearn.metrics import roc_auc_score, average_precision_score

    n = len(df)
    bounds = [int(n * (i + 1) / (args.folds + 1)) for i in range(args.folds)]
    rows = []
    for k, cut in enumerate(bounds, 1):
        nxt = int(n * (k + 1) / (args.folds + 1)) if k < args.folds else n
        train, test = df.iloc[:cut], df.iloc[cut:nxt]
        if test.empty or train["label"].sum() < 3 or test["label"].nunique() < 2:
            continue
        pos = max(int(train["label"].sum()), 1)
        m = XGBClassifier(n_estimators=300, max_depth=4, learning_rate=0.05,
                          scale_pos_weight=(len(train) - pos) / pos,
                          eval_metric="aucpr", n_jobs=4)
        m.fit(train[FEATURE_COLS], train["label"])
        p = m.predict_proba(test[FEATURE_COLS])[:, 1]
        rows.append({
            "fold": k,
            "train_end": str(train["time"].iloc[-1]),
            "test_rows": int(len(test)),
            "test_pos": int(test["label"].sum()),
            "roc_auc": round(float(roc_auc_score(test["label"], p)), 3),
            "pr_auc": round(float(average_precision_score(test["label"], p)), 3),
        })

    if not rows:
        print("No evaluable folds (labels too sparse in time).")
        return
    res = pd.DataFrame(rows)
    print(res.to_string(index=False))
    summary = {"mean_roc_auc": round(res["roc_auc"].mean(), 3),
               "mean_pr_auc": round(res["pr_auc"].mean(), 3),
               "folds": len(res)}
    print("\n" + json.dumps(summary, indent=2))
    (MODEL_DIR / "backtest.json").write_text(json.dumps({"folds": rows, "summary": summary}, indent=2))


if __name__ == "__main__":
    main()

"""Train an XGBoost flood-risk classifier with a time-based split + SHAP.

Reads backend/ml/data/dataset.parquet (from export_dataset.py). Trains on the
earlier portion of the timeline and evaluates on the most recent portion (no
random shuffling — that would leak future information into the past). Saves the
model and a SHAP feature-importance summary.

Usage:
  python train.py --test-frac 0.25
"""
import argparse
import json
import numpy as np
import pandas as pd
import joblib
from db import DATA_DIR, MODEL_DIR
from export_dataset import FEATURE_COLS


def time_split(df: pd.DataFrame, test_frac: float):
    df = df.sort_values("time")
    cut = int(len(df) * (1 - test_frac))
    return df.iloc[:cut], df.iloc[cut:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-frac", type=float, default=0.25)
    args = ap.parse_args()

    path = DATA_DIR / "dataset.parquet"
    if not path.exists():
        print("No dataset — run export_dataset.py first.")
        return
    df = pd.read_parquet(path)
    if df["label"].sum() < 10:
        print(f"Only {int(df['label'].sum())} positive labels — too few to train a reliable model. "
              "Collect more flood_incident labels first.")
        return

    from xgboost import XGBClassifier
    from sklearn.metrics import roc_auc_score, average_precision_score, classification_report

    train, test = time_split(df, args.test_frac)
    Xtr, ytr = train[FEATURE_COLS], train["label"]
    Xte, yte = test[FEATURE_COLS], test["label"]

    # Class imbalance: weight positives by the negative/positive ratio.
    pos = max(int(ytr.sum()), 1)
    spw = (len(ytr) - pos) / pos

    model = XGBClassifier(
        n_estimators=400, max_depth=4, learning_rate=0.05,
        subsample=0.9, colsample_bytree=0.9, scale_pos_weight=spw,
        eval_metric="aucpr", n_jobs=4,
    )
    model.fit(Xtr, ytr)

    proba = model.predict_proba(Xte)[:, 1]
    metrics = {
        "n_train": int(len(Xtr)), "n_test": int(len(Xte)),
        "pos_train": int(ytr.sum()), "pos_test": int(yte.sum()),
        "roc_auc": float(roc_auc_score(yte, proba)) if yte.nunique() > 1 else None,
        "pr_auc": float(average_precision_score(yte, proba)) if yte.nunique() > 1 else None,
    }
    print(json.dumps(metrics, indent=2))
    if yte.nunique() > 1:
        print(classification_report(yte, (proba >= 0.5).astype(int), digits=3))

    joblib.dump(model, MODEL_DIR / "flood_xgb.joblib")
    (MODEL_DIR / "metrics.json").write_text(json.dumps(metrics, indent=2))

    # SHAP: which features drive the predictions (explainability, not a black box).
    try:
        import shap
        expl = shap.TreeExplainer(model)
        sv = expl.shap_values(Xte)
        imp = pd.DataFrame({"feature": FEATURE_COLS,
                            "mean_abs_shap": np.abs(sv).mean(axis=0)}).sort_values(
                            "mean_abs_shap", ascending=False)
        imp.to_csv(MODEL_DIR / "shap_importance.csv", index=False)
        print("\nTop drivers (mean |SHAP|):")
        print(imp.head(8).to_string(index=False))
    except Exception as e:
        print(f"(SHAP summary skipped: {e})")

    print(f"\nSaved model -> {MODEL_DIR/'flood_xgb.joblib'}")


if __name__ == "__main__":
    main()

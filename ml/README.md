# FlowGuard — Phase 2 ML pipeline

Supervised flood-risk modelling that builds on the Phase 1.5 rule-based engine.
Phase 1.5 (in `backend/utils/`) is explainable and works with zero training
data; this pipeline learns from **real outcomes** once enough have been
labelled, and stays explainable via SHAP.

## The one prerequisite: labels

A supervised model needs ground truth — dates estates actually flooded. Log them
in ops: **AI Risk Forecast → select an estate → Log flood incident** (or they're
captured automatically when an alert is confirmed as "flooded"). Each becomes a
`flood_incident` row in `property_events`, which is this pipeline's target
variable. Until you have a few dozen spread across estates and time, the scripts
will tell you there's too little signal to train — that's expected, not a bug.

## Setup

```bash
cd backend/ml
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Credentials come from `backend/.env` (same DB the API uses) — nothing to
configure separately. Never commit a populated `.env`.

## Pipeline

```bash
# 1. Build a leak-free labelled dataset (features as-of t, label = flood in next N hours)
python export_dataset.py --horizon 24 --cadence 6 --days 365

# 2. Train XGBoost with a time-based split + SHAP feature importances
python train.py --test-frac 0.25

# 3. Unsupervised anomaly detection (works with no labels)
python anomaly.py --days 120 --contamination 0.02

# 4. Walk-forward backtest (honest out-of-sample evaluation over time)
python backtest.py --folds 5
```

Artifacts land in `models/` (`flood_xgb.joblib`, `metrics.json`,
`shap_importance.csv`, `anomaly_iforest.joblib`, `backtest.json`) and datasets in
`data/`. Both dirs are gitignored.

## Feature parity

`export_dataset.py` computes the same signals as the Node feature engine
(`utils/features.js`): current level, 1h change, 3h rise-rate, 6h avg/max, silt,
net flow, and rolling rainfall (1h/3h/6h). This keeps training features aligned
with what the live service can serve at inference time.

## Serving (next step, not yet wired)

When metrics justify it, export the trained model to a small scorer the Node
service calls (a Python microservice, or ONNX in-process). Until then the live
product runs the rule-based engine; this pipeline is how we prove a learned model
beats it before that swap — never a black box that silently replaces it.

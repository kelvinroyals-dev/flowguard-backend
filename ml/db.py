"""Shared DB access for the FlowGuard ML pipeline.

Reads the SAME connection settings the Node backend uses (backend/.env), so the
model trains on production-shaped data without a separate config. Never commit a
populated .env — these scripts read credentials from the environment only.
"""
import os
import psycopg2
import pandas as pd
from pathlib import Path

try:
    from dotenv import load_dotenv
    # Load backend/.env (one directory up) if present.
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except Exception:
    pass


def connect():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        user=os.getenv("DB_USER", "flowguard_user"),
        password=os.getenv("DB_PASSWORD", ""),
        dbname=os.getenv("DB_NAME", "flowguard_prod"),
    )


def query_df(sql: str, params=None) -> pd.DataFrame:
    conn = connect()
    try:
        return pd.read_sql_query(sql, conn, params=params)
    finally:
        conn.close()


DATA_DIR = Path(__file__).resolve().parent / "data"
MODEL_DIR = Path(__file__).resolve().parent / "models"
DATA_DIR.mkdir(exist_ok=True)
MODEL_DIR.mkdir(exist_ok=True)

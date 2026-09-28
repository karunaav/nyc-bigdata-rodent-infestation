import pandas as pd
import json
import numpy as np
import pyarrow.parquet as pq
from pathlib import Path

Path('web/data').mkdir(parents=True, exist_ok=True)

print("Reading parquet...")
# PySpark writes dictionary-encoded string columns per partition; unifying them
# across partitions fails when some have nulls. Cast dict → string before to_pandas.
import pyarrow as pa
import pyarrow.compute as pc

_table = pq.read_table('data/processed/rodent_inspections.parquet')
_cast  = {
    name: pc.cast(_table.column(name), pa.string())
           if pa.types.is_dictionary(_table.schema.field(name).type)
           else _table.column(name)
    for name in _table.schema.names
}
df = pa.table(_cast).to_pandas()
df['year'] = df['year'].fillna(0).astype(int)
df['month'] = df['month'].fillna(0).astype(int)
df = df[(df['year'] >= 2009) & (df['year'] <= 2025)]
df['NTA'] = df['NTA'].fillna('Unknown')
print(f"Loaded {len(df):,} rows")

RAT_POSITIVE = {'Rat Activity', 'Bait applied'}
df['rat_positive'] = df['RESULT'].isin(RAT_POSITIVE).astype(int)
df['rat_activity'] = (df['RESULT'] == 'Rat Activity').astype(int)
df['bait_applied'] = (df['RESULT'] == 'Bait applied').astype(int)
df['passed'] = (df['RESULT'] == 'Passed').astype(int)

# 1. Summary
total = len(df)
rat_pos = int(df['rat_positive'].sum())
summary = {
    'total_inspections': int(total),
    'rat_positive_total': rat_pos,
    'rat_positive_rate': round(rat_pos / total * 100, 1),
    'rat_activity_count': int(df['rat_activity'].sum()),
    'bait_applied_count': int(df['bait_applied'].sum()),
    'passed_count': int(df['passed'].sum()),
    'years': sorted(df['year'].unique().tolist()),
    'boroughs': sorted(df['BOROUGH'].dropna().unique().tolist()),
}
Path('web/data/summary.json').write_text(json.dumps(summary))
print("✓ summary.json")

# 2. By year × borough
by_yb = df.groupby(['year', 'BOROUGH']).agg(
    total=('rat_positive', 'count'),
    rat_positive=('rat_positive', 'sum'),
    rat_activity=('rat_activity', 'sum'),
    bait_applied=('bait_applied', 'sum'),
    passed=('passed', 'sum'),
).reset_index()
by_yb['rat_rate'] = (by_yb['rat_positive'] / by_yb['total'] * 100).round(2)
by_yb['year'] = by_yb['year'].astype(int)
Path('web/data/by_year_borough.json').write_text(by_yb.to_json(orient='records'))
print("✓ by_year_borough.json")

# 3. By year × month (all boroughs combined)
by_ym = df.groupby(['year', 'month']).agg(
    total=('rat_positive', 'count'),
    rat_positive=('rat_positive', 'sum'),
    rat_activity=('rat_activity', 'sum'),
).reset_index()
by_ym['rat_rate'] = (by_ym['rat_positive'] / by_ym['total'] * 100).round(2)
by_ym['year'] = by_ym['year'].astype(int)
by_ym['month'] = by_ym['month'].astype(int)
Path('web/data/by_year_month.json').write_text(by_ym.to_json(orient='records'))
print("✓ by_year_month.json")

# 4. By year × month × borough (for seasonality per borough)
by_ymb = df.groupby(['year', 'month', 'BOROUGH']).agg(
    total=('rat_positive', 'count'),
    rat_positive=('rat_positive', 'sum'),
).reset_index()
by_ymb['rat_rate'] = (by_ymb['rat_positive'] / by_ymb['total'] * 100).round(2)
by_ymb['year'] = by_ymb['year'].astype(int)
by_ymb['month'] = by_ymb['month'].astype(int)
Path('web/data/by_year_month_borough.json').write_text(by_ymb.to_json(orient='records'))
print("✓ by_year_month_borough.json")

# 5. By inspection type
by_type = df.groupby('INSPECTION_TYPE').agg(
    total=('rat_positive', 'count'),
    rat_positive=('rat_positive', 'sum'),
    rat_activity=('rat_activity', 'sum'),
    bait_applied=('bait_applied', 'sum'),
    passed=('passed', 'sum'),
).reset_index()
by_type['rat_rate'] = (by_type['rat_positive'] / by_type['total'] * 100).round(1)
by_type = by_type.sort_values('total', ascending=False)
Path('web/data/by_inspection_type.json').write_text(by_type.to_json(orient='records'))
print("✓ by_inspection_type.json")

# 6. Top 60 neighborhoods
nbhd = df.groupby(['NTA', 'BOROUGH']).agg(
    total=('rat_positive', 'count'),
    rat_positive=('rat_positive', 'sum'),
    rat_activity=('rat_activity', 'sum'),
).reset_index()
nbhd['rat_rate'] = (nbhd['rat_positive'] / nbhd['total'] * 100).round(1)
top_nbhd = nbhd.sort_values('rat_positive', ascending=False).head(60)
Path('web/data/neighborhoods.json').write_text(top_nbhd.to_json(orient='records'))
print("✓ neighborhoods.json")

# 7. Heatmap grids per year (rat-positive locations)
print("Generating heatmap grids...")
rat_df = df[df['rat_positive'] == 1].dropna(subset=['LATITUDE', 'LONGITUDE'])
RESOLUTION = 0.004

years = sorted(df['year'].unique().tolist())
for yr in years:
    yr_df = rat_df[rat_df['year'] == yr].copy()
    yr_df['lat_bin'] = (yr_df['LATITUDE'] / RESOLUTION).round() * RESOLUTION
    yr_df['lon_bin'] = (yr_df['LONGITUDE'] / RESOLUTION).round() * RESOLUTION
    grid = yr_df.groupby(['lat_bin', 'lon_bin']).size().reset_index(name='cnt')
    max_cnt = float(grid['cnt'].max())
    grid['intensity'] = ((grid['cnt'] / max_cnt) * 0.85 + 0.15).clip(0, 1).round(3)
    points = [
        [round(float(r.lat_bin), 5), round(float(r.lon_bin), 5), float(r.intensity)]
        for r in grid.itertuples()
    ]
    Path(f'web/data/heatmap_{yr}.json').write_text(json.dumps(points))
    print(f"  ✓ heatmap_{yr}.json  ({len(points)} cells)")

print("\n✅ All data files written to web/data/")

# ─── ML Predictions ───────────────────────────────────────────────────────────
import ast

PREDS_PARQUET = 'data/predictions/test_predictions.parquet'

if Path(PREDS_PARQUET).exists():
    print("\nLoading ML predictions...")
    dp = pd.read_parquet(PREDS_PARQUET, engine='pyarrow')

    # Cast and filter to valid test years only
    dp['year']  = dp['year'].fillna(0).astype(int)
    dp['month'] = dp['month'].fillna(0).astype(int)
    dp = dp[(dp['year'] >= 2023) & (dp['year'] <= 2025)]

    # Parse probability string "[p0, p1]" → extract p1 (prob of rat positive)
    dp['risk_score'] = dp['probability'].apply(
        lambda x: round(ast.literal_eval(x)[1], 4) if pd.notna(x) else None
    )

    # 8. ML predictions per ZIP × year × month (test period)
    ml_preds = dp[[
        'ZIP_CODE', 'BOROUGH', 'year', 'month',
        'rat_positive_rate', 'label', 'prediction', 'risk_score'
    ]].copy()
    ml_preds['rat_positive_rate'] = ml_preds['rat_positive_rate'].round(2)
    ml_preds['prediction'] = ml_preds['prediction'].astype(int)
    ml_preds['label']      = ml_preds['label'].astype(int)
    Path('web/data/ml_predictions.json').write_text(ml_preds.to_json(orient='records'))
    print(f"✓ ml_predictions.json  ({len(ml_preds):,} rows)")

    # 9. ZIP-level risk snapshot — latest month available per ZIP
    latest_idx = dp.groupby('ZIP_CODE')['year'].transform('max')
    latest = dp[dp['year'] == latest_idx]
    latest_month_idx = latest.groupby('ZIP_CODE')['month'].transform('max')
    latest = latest[latest['month'] == latest_month_idx]
    zip_risk = (
        latest[['ZIP_CODE', 'BOROUGH', 'year', 'month', 'risk_score', 'prediction']]
        .drop_duplicates('ZIP_CODE')
        .sort_values('risk_score', ascending=False)
    )
    zip_risk['prediction'] = zip_risk['prediction'].astype(int)
    Path('web/data/ml_zip_risk.json').write_text(zip_risk.to_json(orient='records'))
    print(f"✓ ml_zip_risk.json  ({len(zip_risk):,} ZIPs)")

    # 10. Model accuracy summary (pre-computed from training run)
    ml_summary = {
        'model':     'Random Forest',
        'auc_roc':   0.8715,
        'accuracy':  0.8271,
        'f1':        0.8242,
        'precision': 0.823,
        'recall':    0.827,
        'train_years': '2009–2022',
        'test_years':  '2023–2025',
        'n_test_rows': int(len(dp)),
        'n_features':  17,
        'top_features': [
            'lag1_rat_rate', 'lag1_rat_count', 'rolling3_rat_count',
            'rolling6_avg_rat_rate', 'rolling3_avg_rat_rate', 'hist_avg_rat_rate'
        ],
    }
    Path('web/data/ml_summary.json').write_text(json.dumps(ml_summary, indent=2))
    print("✓ ml_summary.json")
else:
    print(f"⚠️  Skipping ML data — {PREDS_PARQUET} not found. Run train_classifier.py first.")

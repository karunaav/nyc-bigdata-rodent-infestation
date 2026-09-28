# NYC Rodent Inspection Dashboard

A data pipeline, ML classifier, and interactive web dashboard that processes 16 years of NYC rodent inspection records and visualises patterns across boroughs, neighbourhoods, and seasons.

**Data:** [DOHMH Rodent Inspection Dataset](https://data.cityofnewyork.us/Health/Rodent-Inspection/p937-wjvj) — NYC Open Data
**Coverage:** 2009 – 2025 · ~2.72 million records · 25 columns · ~1 GB CSV

---

## How it works

The project has four phases. Raw CSV is processed by a PySpark ETL into Parquet. That Parquet then forks: one branch derives ML features and trains a classifier, the other aggregates the data into JSON. Both feed into a single set of files under `web/data/` that the static dashboard loads in the browser. No backend is running at serve time.

```
Raw CSV (~1 GB)
     │
     ▼  pipeline/etl/process_rodent_data.py   (PySpark)
Partitioned Parquet
     │
     ├─────────────────────────────────────┐
     ▼                                     ▼
pipeline/etl/feature_engineering.py    pipeline/generate_web_data.py
     │  (PySpark)                          (pandas + pyarrow)
     ▼                                     │
ZIP × year × month features                │
     │                                     │
     ▼  pipeline/ml/train_classifier.py    │
     │  (PySpark MLlib)                    │
     ▼                                     │
Trained model + test_predictions.parquet ──┤
                                           ▼
                                    web/data/*.json
                                           │
                                           ▼  web/index.html (static)
                                       Dashboard
```

---

## Repository structure

```
├── pipeline/
│   ├── etl/
│   │   ├── process_rodent_data.py    # Step 1 — PySpark ETL
│   │   └── feature_engineering.py    # Step 2 — ZIP×month feature engineering
│   ├── ml/
│   │   └── train_classifier.py       # Step 3 — RF + GBT training
│   ├── generate_web_data.py          # Step 4 — aggregation + JSON export
│   └── notebooks/
│       └── 01_full_analysis.ipynb       # Exploratory analysis (standalone)
|       └── 02_model_comparison.ipynb    # Model Comparison (standalone)
│
├── web/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── data/                         # Output of Step 4 — loaded by the browser
│
├── data/
│   ├── processed/
│   │   └── rodent_inspections.parquet/   # Output of Step 1
│   ├── features/
│   │   └── rodent_features.parquet/      # Output of Step 2
│   └── predictions/
│       └── test_predictions.parquet/     # Output of Step 3
│
├── models/
│   └── rodent_classifier/            # Best saved MLlib model
│
├── requirements.txt
└── .gitignore
```

---

## Step 1 — ETL (`pipeline/etl/process_rodent_data.py`)

Takes the raw CSV and produces a clean, partitioned Parquet dataset. Runs on PySpark 4.0 locally.

### Spark session configuration

The session is configured for local execution on a laptop:

| Config | Value |
|---|---|
| `spark.driver.memory` | 4 g |
| `spark.executor.memory` | 4 g |
| `spark.sql.shuffle.partitions` | 8 |
| `spark.local.dir` | `/Users/akashweb/spark-temp` |

`spark.local.dir` is where Spark spills temporary data during shuffles. Change this to a path on your machine before running.

### Schema enforcement

Rather than letting Spark infer the schema from the CSV (which is slow and unreliable on a 1 GB file), a fixed 25-field `StructType` is declared upfront:

| Field | Declared type |
|---|---|
| INSPECTION_TYPE | String |
| JOB_TICKET_OR_WORK_ORDER_ID | String |
| JOB_ID | String |
| JOB_PROGRESS | Integer |
| BBL | String |
| BORO_CODE | Integer |
| BLOCK | Integer |
| LOT | Integer |
| HOUSE_NUMBER | String |
| STREET_NAME | String |
| ZIP_CODE | Integer |
| X_COORD | Double |
| Y_COORD | Double |
| LATITUDE | Double |
| LONGITUDE | Double |
| BOROUGH | String |
| INSPECTION_DATE | String |
| RESULT | String |
| APPROVED_DATE | String |
| LOCATION | String |
| COMMUNITY BOARD | Integer |
| COUNCIL DISTRICT | Integer |
| CENSUS TRACT | String |
| BIN | Integer |
| NTA | String |

Before applying this schema, the ETL reads the file once with schema inference and compares the result against the declared schema. If they differ, a warning is logged but processing continues using the declared schema. This guards against upstream column changes in the NYC Open Data export without hard-failing the pipeline.

### Date parsing

`INSPECTION_DATE` and `APPROVED_DATE` are raw strings in the CSV. The ETL tries to parse them as timestamps using the format `MM/dd/yyyy hh:mm:ss a` (e.g. `06/15/2018 12:00:00 AM`).

After parsing, it counts what fraction of `inspection_ts` values came out null. If more than 80% are null, the data is using the shorter historical format `MM/dd/yyyy` (no time component), so it drops the initial timestamp columns and re-parses using that format instead. This fallback handles the format variation that exists between older and newer records in the DOHMH dataset.

### Cleaning and deduplication

After date parsing the ETL applies three operations in sequence:

1. **Drop unparseable dates** — rows where `inspection_ts` is still null after both format attempts are removed. These records have no usable timestamp and cannot be placed on a timeline.

2. **Deduplicate** — rows with the same `(JOB_TICKET_OR_WORK_ORDER_ID, inspection_ts)` pair are collapsed to one. The same job ticket can appear multiple times in the raw export.

3. **Add time columns** — `year` and `month` integer columns are extracted from `inspection_ts` and added to the output. These are used as partition keys and as filter columns downstream.

### Output

The cleaned DataFrame is written as Parquet partitioned by `year` and then `BOROUGH`:

```
data/processed/rodent_inspections.parquet/
  year=2009/
    BOROUGH=Bronx/
    BOROUGH=Brooklyn/
    ...
  year=2010/
    ...
```

This partition layout means that when downstream steps read the data, pyarrow can skip entire year or borough partitions during loading if only a subset is needed.

### Logging

Every run creates a timestamped log file at `logs/etl_YYYY-MM-DD_HH-MM-SS.log`. The same output goes to stdout. Logged events include schema comparison result, sample date parse output, row count after cleaning, distinct years found, and distinct boroughs found.

---

## Step 2 — Feature Engineering (`pipeline/etl/feature_engineering.py`)

Reads the Parquet from Step 1 and aggregates it to `(ZIP_CODE, year, month)` granularity, then derives time-series features ready for MLlib. Output is `data/features/rodent_features.parquet`.

### Aggregation

Records are filtered to those with valid `ZIP_CODE`, `BOROUGH`, `year`, and `month`. A stable borough-per-zip lookup is built first (zips that straddle two boroughs get assigned to the dominant one by record count), then inspections are grouped to one row per ZIP × year × month with `total_inspections`, `rat_positive_count`, and `rat_positive_rate` (%) computed.

A monotonic `time_idx = year * 12 + month` column is added to give window functions a correct chronological ordering across years.

### Derived features

| Family | Columns | What they capture |
|---|---|---|
| Seasonal | `quarter`, `is_summer` (May–Sep), `is_winter` (Dec–Feb) | Calendar context |
| Lag | `lag1_rat_rate`, `lag2_rat_rate`, `lag3_rat_rate`, `lag1_total`, `lag1_rat_count` | Strictly prior months for the same zip |
| Rolling | `rolling3_avg_rat_rate`, `rolling6_avg_rat_rate`, `rolling3_rat_count`, `rolling3_total` | Trailing 3- and 6-month windows, current month excluded |
| Expanding | `hist_avg_rat_rate` | All-time mean rate for this zip up to but not including the current month |

All window definitions use `rowsBetween(..., -1)` so the current month is never included — there is no data leakage from the target month into any feature.

### Encoding and label

`BOROUGH` is encoded with a `StringIndexer` into `borough_idx`. The binary classification label is defined as:

```
label = 1 if rat_positive_rate >= 20.0 else 0
```

The threshold of 20% gives reasonably balanced classes given the pre-2020 baseline (~13%) and post-2020 baseline (~33%).

### Cleanup

Rows where `lag1_rat_rate`, `lag2_rat_rate`, `lag3_rat_rate`, `rolling3_avg_rat_rate`, or `hist_avg_rat_rate` are null are dropped — these are warm-up rows for each zip (the first 1–3 months of its history) and cannot be used for training. Final label distribution is logged.

---

## Step 3 — Model Training (`pipeline/ml/train_classifier.py`)

Trains Random Forest and Gradient Boosted Tree classifiers on the engineered features and saves the better one. Output is `models/rodent_classifier/` (best model) and `data/predictions/test_predictions.parquet` (test-set predictions for the dashboard).

### Temporal train/test split

The split is **temporal, not random**, because the deployment scenario is forecasting forward in time:

- **Train**: 2009 – 2022
- **Test**: 2023 – 2025

A random split would let the model see future months for the same zip during training and produce optimistic metrics that would not hold in practice.

### Features

17 input features, all from Step 2's output:

```
month, year, quarter, is_summer, is_winter,
borough_idx, zip_code_num,
lag1_rat_rate, lag2_rat_rate, lag3_rat_rate,
lag1_total, lag1_rat_count,
rolling3_avg_rat_rate, rolling6_avg_rat_rate,
rolling3_rat_count, rolling3_total,
hist_avg_rat_rate
```

`total_inspections`, `rat_positive_count`, and `rat_positive_rate` are deliberately **not** features — they are computed from the current month being predicted.

### Models

| Model | Hyperparameters |
|---|---|
| Random Forest | `numTrees=100`, `maxDepth=10`, `seed=42` |
| Gradient Boosted Trees | `maxIter=50`, `maxDepth=8`, `seed=42` |

Both run inside a `Pipeline` together with a `VectorAssembler` that produces the `features` vector column.

### Evaluation and selection

The held-out test set is scored on AUC-ROC, accuracy, F1, weighted precision, and weighted recall. The model with the higher AUC-ROC is selected as the winner. On the current dataset Random Forest wins with AUC-ROC ≈ 0.87 and accuracy ≈ 0.83. The winning model is saved to `models/rodent_classifier/` and its test-set predictions are written to `data/predictions/test_predictions.parquet`. Feature importances for both models are logged for diagnostics.

---

## Step 4 — Web data generation (`pipeline/generate_web_data.py`)

Reads the Parquet from Step 1 and runs aggregation passes, writing each result as a JSON file into `web/data/`. If the predictions Parquet from Step 3 exists, it also produces ML-derived JSONs. No Spark — uses pandas and pyarrow.

### Loading and initial filtering

The full Parquet is loaded into a pandas DataFrame via pyarrow. Then:

- `year` and `month` columns have any remaining NaN values filled with `0` and cast to int.
- Rows outside 2009–2025 are dropped.
- Rows where `NTA` (Neighbourhood Tabulation Area) is null are filled with the string `"Unknown"` so they still appear in neighbourhood groupings rather than being silently excluded.

### Rat-positive classification

Four binary flag columns are added to every row:

| Column | Condition |
|---|---|
| `rat_positive` | `RESULT` is `"Rat Activity"` or `"Bait applied"` |
| `rat_activity` | `RESULT` is exactly `"Rat Activity"` |
| `bait_applied` | `RESULT` is exactly `"Bait applied"` |
| `passed` | `RESULT` is exactly `"Passed"` |

`rat_positive` is the primary indicator used across all charts. A `"Bait applied"` result is included as rat-positive because bait is only applied when active infestation is confirmed — it reflects the same underlying condition as a direct sighting.

### Aggregations

**`summary.json`** — single object with global totals across all years and boroughs: total inspection count, total rat-positive count, overall rat-positive rate %, rat activity count, bait applied count, passed count, and sorted lists of available years and boroughs. Used to populate KPI cards on first load.

**`by_year_borough.json`** — one record per (year, borough) pair containing total inspection count, rat-positive count, rat activity count, bait applied count, passed count, and rat-positive rate %. Powers the borough comparison chart and year-over-year KPI deltas.

**`by_year_month.json`** — one record per (year, month) pair, all boroughs combined, with total count, rat-positive count, rat activity count, and rat-positive rate %. Powers the historical trend chart and the seasonal pattern chart when no borough filter is active.

**`by_year_month_borough.json`** — one record per (year, month, borough) triple with total count, rat-positive count, and rat-positive rate %. Powers the seasonal pattern chart when a specific borough is selected, and the monthly activity matrix.

**`by_inspection_type.json`** — one record per `INSPECTION_TYPE` value sorted by total volume descending, with the same count breakdown and rat-positive rate. Powers the inspection type breakdown chart. The DOHMH runs five inspection types: Initial, Compliance, Baiting, Clean Up, and Stoppage — each has a different baseline rat-positive rate because they are triggered under different conditions.

**`neighborhoods.json`** — one record per (NTA, borough) pair, aggregated across all years, containing total count, rat-positive count, rat activity count, and rat-positive rate %. The top 60 by rat-positive count are kept. Powers the top neighbourhoods leaderboard.

**`heatmap_<year>.json`** — one file per year (2009–2025). Only rat-positive records with non-null latitude and longitude are included. Coordinates are binned into a `0.004°` grid (roughly 400 m cells at NYC latitudes). For each grid cell, the count of rat-positive inspections is summed. Intensity is then normalised to the range `[0.15, 1.0]` using the formula `(count / max_count) * 0.85 + 0.15`, clipped to `[0, 1]`. The minimum of `0.15` ensures that even a single hit in a cell is still visible on the map. Each file is a JSON array of `[lat, lon, intensity]` triples consumed directly by the Leaflet heatmap plugin.

### ML outputs (only if `data/predictions/test_predictions.parquet` exists)

If Step 3 has been run, three additional files are written:

**`ml_predictions.json`** — per-ZIP × year × month predictions for the test period (2023–2025), including the actual `rat_positive_rate`, the binary `label`, the binary `prediction`, and a `risk_score` (probability of class 1, parsed from MLlib's `probability` vector).

**`ml_zip_risk.json`** — latest-month risk snapshot per ZIP, sorted by risk score descending. Powers the ZIP Code Risk Explorer in the Predictive Intelligence panel.

**`ml_summary.json`** — model metadata: model name (`Random Forest`), AUC-ROC (0.87), accuracy (0.83), F1, precision, recall, train/test year ranges, test row count, feature count (17), and a list of top-importance features.

If the predictions Parquet is missing, this branch is skipped silently and only the aggregation JSONs are produced — the dashboard still loads but the Predictive Intelligence panel will be empty.

---

## Web dashboard (`web/`)

A single-page static application. No framework. Loads all data from `web/data/` on startup.

**Runtime dependencies (loaded from CDN):**
- Leaflet 1.9.4 — interactive map
- leaflet.heat 0.2.0 — heatmap layer
- Chart.js 4.4.0 — all charts

### Filters

The filter bar at the top of the page controls all visualisations simultaneously:

- **Year slider** — scrubs from 2009 to 2025. All charts, the heatmap, and the KPI cards update instantly on change.
- **Play / Pause button** — animates year progression automatically. Keyboard `Space` toggles playback. `←` and `→` arrow keys step one year at a time.
- **Borough pills** — `All`, `Manhattan`, `Brooklyn`, `Bronx`, `Queens`, `Staten Island`. Selecting a specific borough filters every metric to that borough only.

### KPI cards

Four cards at the top: **Total Inspections**, **Rat Positive Rate**, **Active Rat Signs**, **Bait Applied**. Each card shows the value for the currently selected year and borough, a year-over-year delta (arrow + percentage change vs the previous year), and a sparkline showing the full 2009–2025 history for that metric.

### Charts and panels

| Panel | What it shows |
|---|---|
| Historical Trend | Rat-positive rate % per year 2009–2025 as a line chart, with a dashed projection line beyond 2025. The projection is a **client-side linear regression** on the last 6 years computed in `app.js` — it is not produced by the Random Forest model. |
| Rat Activity Heatmap | Leaflet map using the pre-gridded `heatmap_<year>.json` for the selected year. Borough centroid markers are clickable to apply the borough filter |
| Borough Comparison | Horizontal bar chart of rat-positive rate % per borough for the selected year. Clicking a bar applies the borough filter |
| Monthly Activity Matrix | Calendar-style grid with years on the y-axis and months on the x-axis. Each cell is coloured by rat-positive rate for that year/month. Clicking a cell jumps the year slider to that year |
| Seasonal Pattern | Line chart of monthly rat-positive % for the selected year and borough combination |
| Top Neighbourhoods | Ranked list of the top 15 NTA neighbourhoods by cumulative rat-positive count across all years |
| Inspection Type Breakdown | Bar chart of rat-positive rate % per inspection type (Initial, Compliance, Baiting, Clean Up, Stoppage) |
| Inspection Result Distribution | Stacked bar chart showing annual counts of all inspection outcomes side by side |
| Predictive Intelligence | Five signal cards (5-year trend, peak season, highest-risk borough, RF AUC-ROC, count of high-risk ZIPs) plus a ZIP Code Risk Explorer with searchable list of top-10 high-risk ZIPs from the RF model |

### Theme

A light/dark theme toggle is in the nav bar. The preference is saved to `localStorage` and restored on next visit. All charts, the map tile layer, and the heatmap gradient switch with the theme.

---

## Prerequisites

- **Python 3.13**
- **Java 11 or later** — required by PySpark. The ETL sets `JAVA_HOME` to `/opt/homebrew/opt/java/libexec/openjdk.jdk/Contents/Home` (macOS Homebrew). Update this path at the top of each PySpark script (`process_rodent_data.py`, `feature_engineering.py`, `train_classifier.py`) if your Java is installed elsewhere.
- A modern web browser to open the dashboard.

---

## Setup

```bash
# Clone and enter the project
git clone https://github.com/akashchauhanweb/nycOpenDataAnalysisOnRodentInfestation.git
cd nycOpenDataAnalysisOnRodentInfestation

# Create a virtual environment using Python 3.13
python3.13 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# Install setuptools first — pkg_resources is not bundled in Python 3.12+ venvs
pip install setuptools==70.3.0

# Install all dependencies
pip install -r requirements.txt
```

---

## Running

### Step 1 — ETL

Download the CSV from [NYC Open Data](https://data.cityofnewyork.us/Health/Rodent-Inspection/p937-wjvj) (Export → CSV) and place it at `data/raw/Rodent_Inspection.csv`, then run from the project root:

```bash
python pipeline/etl/process_rodent_data.py \
  --input  data/raw/Rodent_Inspection.csv \
  --output data/processed/rodent_inspections.parquet
```

This will take several minutes on a local machine. Progress is printed to stdout and logged to `logs/etl_<timestamp>.log`. The output is a directory of Parquet part files at `data/processed/rodent_inspections.parquet/`.

If you need to tune memory for your machine, edit these values near the top of `process()` in `process_rodent_data.py`:

```python
.config("spark.driver.memory", "4g")      # increase if you have RAM to spare
.config("spark.executor.memory", "4g")
.config("spark.sql.shuffle.partitions", "8")
.config("spark.local.dir", "/your/path/spark-temp")  # must exist and have space
```

### Step 2 — Feature Engineering (optional)

```bash
python pipeline/etl/feature_engineering.py \
  --input  data/processed/rodent_inspections.parquet \
  --output data/features/rodent_features.parquet
```

Aggregates to ZIP × month and derives lag, rolling, and seasonal features.

### Step 3 — Train Classifier (optional)

```bash
python pipeline/ml/train_classifier.py \
  --input data/features/rodent_features.parquet \
  --model models/rodent_classifier \
  --preds data/predictions/test_predictions.parquet
```

Trains Random Forest and GBT, saves the better one, and writes test-set predictions for the dashboard.

> Steps 2 and 3 are optional. If you skip them, Step 4 still produces all aggregation JSONs and the dashboard works — but it logs `Skipping ML data — ... not found` and the Predictive Intelligence panel will be empty.

### Step 4 — Generate web data

```bash
python pipeline/generate_web_data.py
```

Reads `data/processed/rodent_inspections.parquet`, runs all aggregations, and writes the results to `web/data/`. If `data/predictions/test_predictions.parquet` exists, it also produces `ml_predictions.json`, `ml_zip_risk.json`, and `ml_summary.json`. Takes around 30–60 seconds. You should see output like:

```
Reading parquet...
Loaded 2,650,000 rows
✓ summary.json
✓ by_year_borough.json
✓ by_year_month.json
✓ by_year_month_borough.json
✓ by_inspection_type.json
✓ neighborhoods.json
Generating heatmap grids...
  ✓ heatmap_2009.json  (1842 cells)
  ...
  ✓ heatmap_2025.json  (2103 cells)

All data files written to web/data/

Loading ML predictions...
✓ ml_predictions.json  (12,480 rows)
✓ ml_zip_risk.json     (197 ZIPs)
✓ ml_summary.json
```

Re-run this step whenever new data is downloaded and Step 1 is re-run.

### Serving the dashboard

The simplest option — open `web/index.html` directly in your browser:

```bash
open web/index.html        # macOS
start web/index.html       # Windows
```

If your browser blocks local JSON fetches (some do), serve it over HTTP instead:

```bash
cd web && python -m http.server 8000
# open http://localhost:8000
```

To deploy publicly, upload the entire `web/` directory to any static host (GitHub Pages, Netlify, Vercel, S3). No server-side runtime is needed.

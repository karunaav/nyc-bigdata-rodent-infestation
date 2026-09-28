#!/usr/bin/env python3
"""
Feature Engineering step — NYC Rodent Infestation ML Pipeline.

Aggregates raw inspection records to (ZIP_CODE, year, month) granularity
and derives lag, rolling, and seasonal features ready for PySpark MLlib.

Input : data/processed/rodent_inspections.parquet
Output: data/features/rodent_features.parquet

Run:
    python pipeline/etl/feature_engineering.py \
        --input  data/processed/rodent_inspections.parquet \
        --output data/features/rodent_features.parquet
"""
import argparse
import os
import sys
import logging
from datetime import datetime

# ─── Logging ──────────────────────────────────────────────────────────────────
if not os.path.exists("logs"):
    os.makedirs("logs")

log_filename = datetime.now().strftime("logs/features_%Y-%m-%d_%H-%M-%S.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s — %(levelname)s — %(message)s",
    handlers=[
        logging.FileHandler(log_filename),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)

# ─── Java + Hadoop ─────────────────────────────────────────────────────────────
os.environ["JAVA_HOME"] = "/opt/homebrew/opt/java/libexec/openjdk.jdk/Contents/Home"
os.environ["HADOOP_HOME"] = "/opt/homebrew/opt/hadoop/libexec"
os.environ["hadoop.home.dir"] = os.environ["HADOOP_HOME"]

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.window import Window
from pyspark.sql.types import IntegerType, DoubleType
from pyspark.ml.feature import StringIndexer


RAT_POSITIVE = ("Rat Activity", "Bait applied")

# Threshold for binary label: 20% positive rate.
# Pre-2020 baseline ~13%, post-2020 ~33% — 20% gives reasonably balanced classes.
LABEL_THRESHOLD = 20.0


def build_features(input_parquet: str, output_path: str):
    logger.info("Starting Spark session...")
    spark = (
        SparkSession.builder
        .appName("RodentFeatureEngineering")
        .config("spark.driver.memory", "4g")
        .config("spark.executor.memory", "4g")
        .config("spark.sql.shuffle.partitions", "8")
        .config("spark.local.dir", "/Users/akashweb/spark-temp")
        .config("spark.hadoop.fs.permissions", "false")
        .config("spark.hadoop.mapreduce.fileoutputcommitter.algorithm.version", "1")
        .config("spark.hadoop.fs.file.impl", "org.apache.hadoop.fs.RawLocalFileSystem")
        .config("spark.hadoop.fs.AbstractFileSystem.file.impl", "org.apache.hadoop.fs.local.LocalFs")
        .config("spark.hadoop.home.dir", "/opt/homebrew/opt/hadoop/libexec")
        .getOrCreate()
    )

    # ── 1. Load processed parquet ─────────────────────────────────────────────
    logger.info(f"Loading parquet: {input_parquet}")
    df = spark.read.parquet(input_parquet)

    # ── 2. Derive rat_positive flag from RESULT ───────────────────────────────
    df = df.withColumn(
        "rat_positive",
        F.when(F.col("RESULT").isin(*RAT_POSITIVE), 1).otherwise(0),
    )

    # ── 3. Filter: require valid ZIP, BOROUGH, year, month ────────────────────
    df = df.filter(
        F.col("ZIP_CODE").isNotNull()
        & F.col("BOROUGH").isNotNull()
        & F.col("year").isNotNull()
        & F.col("month").isNotNull()
        & (F.col("ZIP_CODE") > 0)
    )
    logger.info(f"Rows after validity filter: {df.count():,}")

    # ── 4. Stable borough per zip (dominant borough by record count) ──────────
    # A zip code very occasionally straddles two boroughs — pick the majority one.
    w_boro = Window.partitionBy("ZIP_CODE").orderBy(F.col("boro_cnt").desc())
    borough_lookup = (
        df.groupBy("ZIP_CODE", "BOROUGH")
        .agg(F.count("*").alias("boro_cnt"))
        .withColumn("rn", F.row_number().over(w_boro))
        .filter(F.col("rn") == 1)
        .drop("rn", "boro_cnt")
    )

    # ── 5. Aggregate to (ZIP_CODE, year, month) ───────────────────────────────
    logger.info("Aggregating to ZIP × year × month...")
    agg = (
        df.groupBy("ZIP_CODE", "year", "month")
        .agg(
            F.count("*").alias("total_inspections"),
            F.sum("rat_positive").alias("rat_positive_count"),
        )
        .withColumn(
            "rat_positive_rate",
            (F.col("rat_positive_count") / F.col("total_inspections") * 100.0).cast(DoubleType()),
        )
        .join(borough_lookup, on="ZIP_CODE", how="left")
    )

    # ── 6. Monotonic time index for correct window ordering ───────────────────
    agg = agg.withColumn(
        "time_idx",
        (F.col("year") * 12 + F.col("month")).cast(IntegerType()),
    )

    # ── 7. Seasonal features ──────────────────────────────────────────────────
    agg = (
        agg
        .withColumn("quarter",   F.ceil(F.col("month") / 3).cast(IntegerType()))
        .withColumn("is_summer", F.when(F.col("month").between(5, 9), 1).otherwise(0).cast(IntegerType()))
        .withColumn("is_winter", F.when(F.col("month").isin(12, 1, 2), 1).otherwise(0).cast(IntegerType()))
    )

    # ── 8. Window definitions ─────────────────────────────────────────────────
    w_zip      = Window.partitionBy("ZIP_CODE").orderBy("time_idx")
    w_zip_3    = Window.partitionBy("ZIP_CODE").orderBy("time_idx").rowsBetween(-3, -1)
    w_zip_6    = Window.partitionBy("ZIP_CODE").orderBy("time_idx").rowsBetween(-6, -1)
    # Expanding window: all months before the current one (no leakage)
    w_zip_hist = (
        Window.partitionBy("ZIP_CODE")
        .orderBy("time_idx")
        .rowsBetween(Window.unboundedPreceding, -1)
    )

    # ── 9. Lag features (strictly prior months — no data leakage) ─────────────
    logger.info("Computing lag features...")
    agg = (
        agg
        .withColumn("lag1_rat_rate",  F.lag("rat_positive_rate", 1).over(w_zip))
        .withColumn("lag2_rat_rate",  F.lag("rat_positive_rate", 2).over(w_zip))
        .withColumn("lag3_rat_rate",  F.lag("rat_positive_rate", 3).over(w_zip))
        .withColumn("lag1_total",     F.lag("total_inspections",  1).over(w_zip))
        .withColumn("lag1_rat_count", F.lag("rat_positive_count", 1).over(w_zip))
    )

    # ── 10. Rolling features (window excludes current row — no leakage) ───────
    logger.info("Computing rolling features...")
    agg = (
        agg
        .withColumn("rolling3_avg_rat_rate", F.avg("rat_positive_rate").over(w_zip_3))
        .withColumn("rolling6_avg_rat_rate", F.avg("rat_positive_rate").over(w_zip_6))
        .withColumn("rolling3_rat_count",    F.sum("rat_positive_count").over(w_zip_3))
        .withColumn("rolling3_total",        F.sum("total_inspections").over(w_zip_3))
        # Expanding historical average: baseline for this zip before current month
        .withColumn("hist_avg_rat_rate",     F.avg("rat_positive_rate").over(w_zip_hist))
    )

    # ── 11. Borough encoding ──────────────────────────────────────────────────
    logger.info("Encoding BOROUGH via StringIndexer...")
    borough_indexer = StringIndexer(
        inputCol="BOROUGH", outputCol="borough_idx", handleInvalid="keep"
    )
    agg = borough_indexer.fit(agg).transform(agg)

    # ── 12. Binary classification label ───────────────────────────────────────
    agg = agg.withColumn(
        "label",
        F.when(F.col("rat_positive_rate") >= LABEL_THRESHOLD, 1)
        .otherwise(0)
        .cast(IntegerType()),
    )

    # ── 13. Drop rows where lag/rolling features are null ─────────────────────
    # First 1–3 months per zip have incomplete history — not usable for training.
    required_cols = [
        "lag1_rat_rate", "lag2_rat_rate", "lag3_rat_rate",
        "rolling3_avg_rat_rate", "hist_avg_rat_rate",
    ]
    agg_clean = agg.dropna(subset=required_cols)

    n_total = agg.count()
    n_clean = agg_clean.count()
    logger.info(f"Rows before null drop : {n_total:,}")
    logger.info(f"Rows after  null drop : {n_clean:,}  ({n_total - n_clean:,} dropped — warm-up rows)")

    # ── 14. Label distribution check ─────────────────────────────────────────
    logger.info("Label distribution:")
    for row in agg_clean.groupBy("label").count().orderBy("label").collect():
        logger.info(f"  label={row['label']}  count={row['count']:,}")

    # ── 15. Sample output ─────────────────────────────────────────────────────
    logger.info("Feature sample (5 rows):")
    agg_clean.select(
        "ZIP_CODE", "BOROUGH", "year", "month",
        "total_inspections", "rat_positive_rate", "label",
        "lag1_rat_rate", "rolling3_avg_rat_rate", "hist_avg_rat_rate",
        "quarter", "is_summer",
    ).show(5, truncate=False)

    # ── 16. Write ─────────────────────────────────────────────────────────────
    logger.info(f"Writing feature parquet to: {output_path}")
    agg_clean.write.mode("overwrite").parquet(output_path)
    logger.info("Feature engineering complete.")

    spark.stop()
    logger.info("Spark stopped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Feature engineering for NYC Rodent MLlib pipeline")
    parser.add_argument("--input",  required=True, help="Processed parquet path (from process_rodent_data.py)")
    parser.add_argument("--output", required=True, help="Output feature parquet path")
    args = parser.parse_args()
    build_features(args.input, args.output)

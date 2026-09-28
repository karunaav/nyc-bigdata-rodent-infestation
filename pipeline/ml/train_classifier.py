#!/usr/bin/env python3
"""
MLlib Classifier Training — NYC Rodent Infestation Prediction.

Trains Random Forest and Gradient Boosted Tree classifiers using PySpark MLlib
to predict monthly rat infestation likelihood at the ZIP code level.

Temporal split: train = 2009–2022, test = 2023–2025.
Target       : label  (1 = rat_positive_rate >= 20%, 0 otherwise)

Input : data/features/rodent_features.parquet  (from feature_engineering.py)
Output: models/rodent_classifier/              (best model saved here)
        data/predictions/test_predictions.parquet

Run:
    python pipeline/ml/train_classifier.py \
        --input  data/features/rodent_features.parquet \
        --model  models/rodent_classifier \
        --preds  data/predictions/test_predictions.parquet
"""
import argparse
import os
import sys
import logging
from datetime import datetime

# ─── Logging ──────────────────────────────────────────────────────────────────
if not os.path.exists("logs"):
    os.makedirs("logs")

log_filename = datetime.now().strftime("logs/train_%Y-%m-%d_%H-%M-%S.log")
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
from pyspark.sql.types import DoubleType
from pyspark.ml import Pipeline
from pyspark.ml.feature import VectorAssembler
from pyspark.ml.classification import RandomForestClassifier, GBTClassifier
from pyspark.ml.evaluation import (
    BinaryClassificationEvaluator,
    MulticlassClassificationEvaluator,
)


# ─── Feature columns (no current-month data — zero leakage) ───────────────────
# Excluded intentionally: total_inspections, rat_positive_count, rat_positive_rate
# (those are computed from the current month being predicted)
FEATURE_COLS = [
    # Temporal / seasonal
    "month", "year", "quarter", "is_summer", "is_winter",
    # Geographic (borough_idx = StringIndexer-encoded BOROUGH)
    "borough_idx", "zip_code_num",
    # Lag features: rat rate from prior 1–3 months for this zip
    "lag1_rat_rate", "lag2_rat_rate", "lag3_rat_rate",
    # Lag volume: how busy was this zip last month
    "lag1_total", "lag1_rat_count",
    # Rolling trend: 3-month and 6-month averages before current month
    "rolling3_avg_rat_rate", "rolling6_avg_rat_rate",
    "rolling3_rat_count", "rolling3_total",
    # Long-run baseline: all-time average rat rate for this zip
    "hist_avg_rat_rate",
]

# Temporal train / test boundary
TRAIN_END_YEAR = 2022
TEST_START_YEAR = 2023


def evaluate(predictions, label: str = "label") -> dict:
    """Returns AUC-ROC, accuracy, F1, precision, recall."""
    bin_eval = BinaryClassificationEvaluator(
        labelCol=label, rawPredictionCol="rawPrediction", metricName="areaUnderROC"
    )
    mc_eval_acc = MulticlassClassificationEvaluator(
        labelCol=label, predictionCol="prediction", metricName="accuracy"
    )
    mc_eval_f1 = MulticlassClassificationEvaluator(
        labelCol=label, predictionCol="prediction", metricName="f1"
    )
    mc_eval_prec = MulticlassClassificationEvaluator(
        labelCol=label, predictionCol="prediction", metricName="weightedPrecision"
    )
    mc_eval_rec = MulticlassClassificationEvaluator(
        labelCol=label, predictionCol="prediction", metricName="weightedRecall"
    )
    return {
        "auc_roc":   round(bin_eval.evaluate(predictions), 4),
        "accuracy":  round(mc_eval_acc.evaluate(predictions), 4),
        "f1":        round(mc_eval_f1.evaluate(predictions), 4),
        "precision": round(mc_eval_prec.evaluate(predictions), 4),
        "recall":    round(mc_eval_rec.evaluate(predictions), 4),
    }


def log_metrics(name: str, metrics: dict):
    logger.info(f"{'─' * 50}")
    logger.info(f"  {name}")
    logger.info(f"  AUC-ROC   : {metrics['auc_roc']}")
    logger.info(f"  Accuracy  : {metrics['accuracy']}")
    logger.info(f"  F1        : {metrics['f1']}")
    logger.info(f"  Precision : {metrics['precision']}")
    logger.info(f"  Recall    : {metrics['recall']}")
    logger.info(f"{'─' * 50}")


def log_feature_importances(model, name: str):
    importances = model.featureImportances.toArray()
    ranked = sorted(zip(FEATURE_COLS, importances), key=lambda x: x[1], reverse=True)
    logger.info(f"Feature importances — {name}:")
    for feat, score in ranked:
        bar = "█" * int(score * 40)
        logger.info(f"  {feat:<30} {score:.4f}  {bar}")


def train(input_parquet: str, model_output: str, preds_output: str):
    logger.info("Starting Spark session...")
    spark = (
        SparkSession.builder
        .appName("RodentClassifierTraining")
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

    # ── 1. Load features ──────────────────────────────────────────────────────
    logger.info(f"Loading features: {input_parquet}")
    df = spark.read.parquet(input_parquet)

    # ── 2. Prepare: cast ZIP_CODE to double for VectorAssembler ──────────────
    df = df.withColumn("zip_code_num", F.col("ZIP_CODE").cast(DoubleType()))

    # rolling6 can be null for zips with 3–5 months of history; fall back to rolling3
    df = df.withColumn(
        "rolling6_avg_rat_rate",
        F.coalesce(F.col("rolling6_avg_rat_rate"), F.col("rolling3_avg_rat_rate")),
    )

    # Cast all feature columns to DoubleType (MLlib requirement)
    for c in FEATURE_COLS:
        df = df.withColumn(c, F.col(c).cast(DoubleType()))

    df = df.withColumn("label", F.col("label").cast(DoubleType()))

    logger.info(f"Total feature rows: {df.count():,}")
    logger.info("Label distribution (full dataset):")
    df.groupBy("label").count().orderBy("label").show()

    # ── 3. Temporal train / test split ────────────────────────────────────────
    # Train on historical data, test on most recent years — mirrors real deployment.
    train_df = df.filter(F.col("year") <= TRAIN_END_YEAR)
    test_df  = df.filter(F.col("year") >= TEST_START_YEAR)

    logger.info(f"Train rows : {train_df.count():,}  (up to {TRAIN_END_YEAR})")
    logger.info(f"Test  rows : {test_df.count():,}  ({TEST_START_YEAR}–2025)")

    # ── 4. VectorAssembler ────────────────────────────────────────────────────
    assembler = VectorAssembler(
        inputCols=FEATURE_COLS,
        outputCol="features",
        handleInvalid="skip",
    )

    # ── 5. Define models ──────────────────────────────────────────────────────
    rf = RandomForestClassifier(
        featuresCol="features",
        labelCol="label",
        numTrees=100,
        maxDepth=10,
        seed=42,
    )

    gbt = GBTClassifier(
        featuresCol="features",
        labelCol="label",
        maxIter=50,
        maxDepth=8,
        seed=42,
    )

    # ── 6. Train Random Forest ────────────────────────────────────────────────
    logger.info("Training Random Forest (numTrees=100, maxDepth=10)...")
    rf_pipeline = Pipeline(stages=[assembler, rf])
    rf_model    = rf_pipeline.fit(train_df)
    rf_preds    = rf_model.transform(test_df)
    rf_metrics  = evaluate(rf_preds)
    log_metrics("Random Forest — Test Set", rf_metrics)
    log_feature_importances(rf_model.stages[-1], "Random Forest")

    # ── 7. Train Gradient Boosted Trees ───────────────────────────────────────
    logger.info("Training GBT (maxIter=50, maxDepth=8)...")
    gbt_pipeline = Pipeline(stages=[assembler, gbt])
    gbt_model    = gbt_pipeline.fit(train_df)
    gbt_preds    = gbt_model.transform(test_df)
    gbt_metrics  = evaluate(gbt_preds)
    log_metrics("Gradient Boosted Trees — Test Set", gbt_metrics)
    log_feature_importances(gbt_model.stages[-1], "GBT")

    # ── 8. Select and save best model ─────────────────────────────────────────
    if rf_metrics["auc_roc"] >= gbt_metrics["auc_roc"]:
        best_name    = "Random Forest"
        best_model   = rf_model
        best_preds   = rf_preds
        best_metrics = rf_metrics
    else:
        best_name    = "Gradient Boosted Trees"
        best_model   = gbt_model
        best_preds   = gbt_preds
        best_metrics = gbt_metrics

    logger.info(f"Best model: {best_name}  (AUC-ROC = {best_metrics['auc_roc']})")
    logger.info(f"Saving model to: {model_output}")
    best_model.write().overwrite().save(model_output)

    # ── 9. Save test predictions ──────────────────────────────────────────────
    logger.info(f"Saving test predictions to: {preds_output}")
    (
        best_preds
        .select(
            "ZIP_CODE", "BOROUGH", "year", "month",
            "rat_positive_rate", "label", "prediction",
            F.col("probability").cast("string").alias("probability"),
        )
        .write.mode("overwrite")
        .parquet(preds_output)
    )

    # ── 10. Final summary ─────────────────────────────────────────────────────
    logger.info("=" * 52)
    logger.info("  TRAINING COMPLETE")
    logger.info(f"  Best model : {best_name}")
    logger.info(f"  AUC-ROC    : {best_metrics['auc_roc']}")
    logger.info(f"  Accuracy   : {best_metrics['accuracy']}")
    logger.info(f"  F1         : {best_metrics['f1']}")
    logger.info(f"  Model path : {model_output}")
    logger.info(f"  Preds path : {preds_output}")
    logger.info("=" * 52)

    spark.stop()
    logger.info("Spark stopped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train MLlib classifier for NYC rodent infestation")
    parser.add_argument("--input", required=True, help="Feature parquet (from feature_engineering.py)")
    parser.add_argument("--model", required=True, help="Output path to save best model")
    parser.add_argument("--preds", required=True, help="Output path for test predictions parquet")
    args = parser.parse_args()
    train(args.input, args.model, args.preds)

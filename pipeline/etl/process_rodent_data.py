#!/usr/bin/env python3
import argparse
import os
import sys
import logging
from datetime import datetime

# ─── Setup File + Console Logging ─────────────────────────────
if not os.path.exists("logs"):
    os.makedirs("logs")

log_filename = datetime.now().strftime("logs/etl_%Y-%m-%d_%H-%M-%S.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s — %(levelname)s — %(message)s",
    handlers=[
        logging.FileHandler(log_filename),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# ─── Java + Hadoop Setup ──────────────────────────────────────
os.environ["JAVA_HOME"] = "/opt/homebrew/opt/java/libexec/openjdk.jdk/Contents/Home"
os.environ["HADOOP_HOME"] = "/opt/homebrew/opt/hadoop/libexec"
os.environ["hadoop.home.dir"] = os.environ["HADOOP_HOME"]

from pyspark.sql import SparkSession
from pyspark.sql.types import (
    StructType, StructField,
    StringType, IntegerType, DoubleType
)
from pyspark.sql.functions import to_timestamp, col, year, month

# ─── Schema ───────────────────────────────────────────────────
SCHEMA = StructType([
    StructField("INSPECTION_TYPE", StringType(), True),
    StructField("JOB_TICKET_OR_WORK_ORDER_ID", StringType(), True),
    StructField("JOB_ID", StringType(), True),
    StructField("JOB_PROGRESS", IntegerType(), True),
    StructField("BBL", StringType(), True),
    StructField("BORO_CODE", IntegerType(), True),
    StructField("BLOCK", IntegerType(), True),
    StructField("LOT", IntegerType(), True),
    StructField("HOUSE_NUMBER", StringType(), True),
    StructField("STREET_NAME", StringType(), True),
    StructField("ZIP_CODE", IntegerType(), True),
    StructField("X_COORD", DoubleType(), True),
    StructField("Y_COORD", DoubleType(), True),
    StructField("LATITUDE", DoubleType(), True),
    StructField("LONGITUDE", DoubleType(), True),
    StructField("BOROUGH", StringType(), True),
    StructField("INSPECTION_DATE", StringType(), True),
    StructField("RESULT", StringType(), True),
    StructField("APPROVED_DATE", StringType(), True),
    StructField("LOCATION", StringType(), True),
    StructField("COMMUNITY BOARD", IntegerType(), True),
    StructField("COUNCIL DISTRICT", IntegerType(), True),
    StructField("CENSUS TRACT", StringType(), True),
    StructField("BIN", IntegerType(), True),
    StructField("NTA", StringType(), True),
])

# ─── ETL Function ─────────────────────────────────────────────
def process(input_csv: str, output_path: str):
    logger.info(" Starting Spark session...")
    spark = (
        SparkSession.builder
        .appName("RodentInspectionETL")
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

    logger.info(" Checking schema...")
    inferred_schema = spark.read.option("header", True).csv(input_csv).schema
    if inferred_schema != SCHEMA:
        logger.warning("⚠️ Schema mismatch detected!")
        logger.warning(f"Inferred: {inferred_schema}")
        logger.warning(f"Expected: {SCHEMA}")

    try:
        df = spark.read.schema(SCHEMA).option("header", True).csv(input_csv)
    except Exception as e:
        logger.error(f"Failed to read CSV: {e}")
        spark.stop()
        sys.exit(1)

    df = (
        df
        .withColumn("inspection_ts", to_timestamp(col("INSPECTION_DATE"), "MM/dd/yyyy hh:mm:ss a"))
        .withColumn("approved_ts",   to_timestamp(col("APPROVED_DATE"),   "MM/dd/yyyy hh:mm:ss a"))
    )

    logger.info(" Sample date parsing:")
    df.select("INSPECTION_DATE", "inspection_ts").show(5, truncate=False)

    null_fraction = df.filter(col("inspection_ts").isNull()).count() / df.count()
    if null_fraction > 0.8:
        logger.warning(" Falling back to date format: MM/dd/yyyy")
        df = df.drop("inspection_ts", "approved_ts").withColumn(
            "inspection_ts", to_timestamp(col("INSPECTION_DATE"), "MM/dd/yyyy")
        ).withColumn(
            "approved_ts", to_timestamp(col("APPROVED_DATE"), "MM/dd/yyyy")
        )

    df_clean = (
        df
        .filter(col("inspection_ts").isNotNull())
        .dropDuplicates(["JOB_TICKET_OR_WORK_ORDER_ID", "inspection_ts"])
        .withColumn("year", year(col("inspection_ts")))
        .withColumn("month", month(col("inspection_ts")))
    )

    logger.info(f" Rows after cleaning: {df_clean.count()}")
    logger.info(" Available years: " + str([r["year"] for r in df_clean.select("year").distinct().collect()]))
    logger.info(" Available boroughs: " + str([r["BOROUGH"] for r in df_clean.select("BOROUGH").distinct().collect()]))

    try:
        logger.info(" Writing partitioned Parquet...")
        df_clean.write.mode("overwrite").partitionBy("year", "BOROUGH").parquet(output_path)
        logger.info(f" Done! Parquet saved to: {output_path}")
    except Exception as e:
        logger.error(f" Failed to write Parquet: {e}")
        spark.stop()
        sys.exit(1)

    spark.stop()
    logger.info(" Spark stopped.")

# ─── CLI Entry ─────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process NYC Rodent Inspection CSV into Parquet")
    parser.add_argument("--input", required=True, help="Path to raw rodent inspection CSV")
    parser.add_argument("--output", required=True, help="Path to processed Parquet output")
    args = parser.parse_args()

    process(args.input, args.output)

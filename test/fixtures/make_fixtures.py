"""Generate parquet test fixtures for eyeball.

Usage: python make_fixtures.py OUTDIR [--big]

Small fixtures cover types/encodings/codecs; --big adds tall/wide files used for
performance testing (several GB in total).
"""
import datetime as dt
import decimal
import json
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

out = Path(sys.argv[1])
big = "--big" in sys.argv
out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(42)


def with_nulls(arr, frac=0.1):
    mask = rng.random(len(arr)) < frac
    return pc.if_else(pa.array(mask), pa.nulls(len(arr), arr.type), arr)


def types_table(n=1000):
    i = np.arange(n)
    cols = {
        "id": pa.array(i, pa.int64()),
        "i8": with_nulls(pa.array((i % 256 - 128).astype(np.int8))),
        "i16": pa.array((i * 37 % 65536 - 32768).astype(np.int16)),
        "i32": with_nulls(pa.array((i * 7919).astype(np.int32))),
        "i64_big": pa.array([(2**62 + k * 1234567) * (-1) ** k for k in range(n)], pa.int64()),
        "u8": pa.array((i % 256).astype(np.uint8)),
        "u32": pa.array((4294967295 - i).astype(np.uint32)),
        "u64": pa.array([2**64 - 1 - k for k in range(n)], pa.uint64()),
        "f32": with_nulls(pa.array(rng.standard_normal(n).astype(np.float32))),
        "f64": pa.array(np.concatenate([[np.nan, np.inf, -np.inf, 0.0, 1e-300, 1e300, 0.1], rng.standard_normal(n - 7) * 1e6])),
        "f16": pa.array(rng.standard_normal(n).astype(np.float16)),
        "bool": with_nulls(pa.array(i % 3 == 0)),
        "str": with_nulls(pa.array([f"value {k} " + "x" * (k % 50) for k in range(n)])),
        "str_special": pa.array(["tab\there", "new\nline", "quote\"s", "ünïcødé ✓ 日本", "", "emoji 🎉🎉"] * (n // 6) + ["end"] * (n % 6)),
        "long_str": pa.array(["L" * (1000 + k) for k in range(n)]),
        "dict_str": pa.array(["apple", "banana", "cherry", None] * (n // 4)).dictionary_encode(),
        "large_str": pa.array([f"large {k}" for k in range(n)], pa.large_string()),
        "binary": pa.array([bytes([k % 256, 0, 255, 17]) for k in range(n)], pa.binary()),
        "fixed_bin": pa.array([bytes([k % 256] * 4) for k in range(n)], pa.binary(4)),
        "date": with_nulls(pa.array([dt.date(1960, 1, 1) + dt.timedelta(days=37 * k) for k in range(n)], pa.date32())),
        "ts_ms": pa.array([1_600_000_000_000 + 1234567 * k for k in range(n)], pa.timestamp("ms")),
        "ts_us_utc": pa.array([-1_000_000_000_000 + 987654321 * k for k in range(n)], pa.timestamp("us", tz="UTC")),
        "ts_ns": pa.array([1_700_000_000_000_000_000 + 123456789 * k for k in range(n)], pa.timestamp("ns")),
        "time_ms": pa.array([(k * 1234567) % 86400000 for k in range(n)], pa.time32("ms")),
        "time_us": pa.array([(k * 1234567891) % 86400000000 for k in range(n)], pa.time64("us")),
        "dec_9_2": pa.array([decimal.Decimal(k * 37 - 5000) / 100 for k in range(n)], pa.decimal128(9, 2)),
        "dec_38_10": with_nulls(pa.array([decimal.Decimal(f"{(-1)**k * k * 98765432101234567}.{k:010d}") for k in range(n)], pa.decimal128(38, 10))),
        "list_i32": with_nulls(pa.array([list(range(k % 5)) for k in range(n)], pa.list_(pa.int32()))),
        "list_str": pa.array([[f"s{j}" for j in range(k % 4)] if k % 7 else None for k in range(n)], pa.list_(pa.string())),
        "struct": pa.array([{"a": k, "b": f"b{k}", "c": None if k % 5 == 0 else k / 2} for k in range(n)],
                           pa.struct([("a", pa.int32()), ("b", pa.string()), ("c", pa.float64())])),
        "list_struct": pa.array([[{"x": j, "y": f"y{j}"} for j in range(k % 3)] for k in range(n)],
                                pa.list_(pa.struct([("x", pa.int64()), ("y", pa.string())]))),
        "map": pa.array([[(f"k{j}", j * 1.5) for j in range(k % 3)] for k in range(n)], pa.map_(pa.string(), pa.float64())),
        "nested_list": pa.array([[[j, j + 1] for j in range(k % 3)] for k in range(n)], pa.list_(pa.list_(pa.int16()))),
        "all_null": pa.nulls(n, pa.int32()),
        "json": pa.array([json.dumps({"k": k, "v": [1, 2]}) for k in range(n)], pa.string()),
    }
    return pa.table(cols)


def expected_value(v, typ):
    """Canonical string the viewer's full formatter should produce."""
    if v is None:
        return None
    if pa.types.is_boolean(typ):
        return "true" if v else "false"
    if pa.types.is_integer(typ):
        return str(v)
    if pa.types.is_floating(typ):
        return {"float": repr(float(v))}
    if pa.types.is_decimal(typ):
        return format(v, "f")
    if pa.types.is_date(typ):
        return v.isoformat()
    if pa.types.is_timestamp(typ) or pa.types.is_time(typ):
        return None  # checked via raw integer below
    if pa.types.is_binary(typ) or pa.types.is_fixed_size_binary(typ):
        # the viewer shows bytes as text only if they are valid UTF-8 without control characters
        try:
            text = v.decode("utf-8")
            if not any(ord(c) < 32 and c not in "\t\n\r" for c in text):
                return text
        except UnicodeDecodeError:
            pass
        return "0x" + v.hex()
    if pa.types.is_string(typ) or pa.types.is_large_string(typ):
        return v
    if pa.types.is_dictionary(typ):
        return expected_value(v, typ.value_type)
    return {"json": v}


def fmt_time(value, unit, with_date):
    """Format an integer timestamp/time like the viewer does."""
    per_sec = {"s": 1, "ms": 10**3, "us": 10**6, "ns": 10**9}[unit]
    digits = {"s": 0, "ms": 3, "us": 6, "ns": 9}[unit]
    secs, frac = divmod(value, per_sec)
    if with_date:
        base = dt.datetime(1970, 1, 1) + dt.timedelta(seconds=secs)
        s = base.strftime("%Y-%m-%d %H:%M:%S")
    else:
        s = f"{secs // 3600:02d}:{secs // 60 % 60:02d}:{secs % 60:02d}"
    if frac:
        f = str(frac).rjust(digits, "0")
        while len(f) > 3 and f.endswith("000"):
            f = f[:-3]
        s += "." + f
    return s


def write_expected(path, table, samples=200):
    """Write sampled expected cell values for test/check.mjs."""
    n = table.num_rows
    rows = sorted(set(rng.integers(0, max(n, 1), size=min(samples, n)).tolist()) | ({0, n - 1} if n else set()))
    checks = []
    for name in table.column_names:
        col = table.column(name)
        typ = col.type
        for r in rows:
            v = col[r].as_py()
            if pa.types.is_timestamp(typ) or pa.types.is_time(typ):
                raw = col[r].value if col[r].is_valid else None
                exp = None if raw is None else fmt_time(raw, typ.unit, pa.types.is_timestamp(typ))
            elif pa.types.is_map(typ) and v is not None:
                exp = {"json": {k: val for k, val in v}}
            else:
                exp = expected_value(v, typ)
            checks.append({"row": r, "col": name, "expected": exp})
    Path(str(path) + ".expected.json").write_text(json.dumps({"numRows": n, "columns": table.column_names, "checks": checks}, default=str))


def write(name, table, **kw):
    path = out / name
    pq.write_table(table, path, **kw)
    write_expected(path, table)
    print("wrote", path, path.stat().st_size, flush=True)


t = types_table()
write("types_snappy.parquet", t, row_group_size=300, data_page_size=1024)
write("types_v2_zstd.parquet", t, row_group_size=400, data_page_size=2048, data_page_version="2.0", compression="zstd")
write("types_pageindex_gzip.parquet", t, row_group_size=1000, data_page_size=512, write_page_index=True, compression="gzip")
write("types_brotli.parquet", t, compression="brotli", data_page_size=4096)
write("types_lz4.parquet", t, compression="lz4", data_page_size=4096)
write("types_none_plain.parquet", t, compression="none", use_dictionary=False, data_page_size=4096)
write("types_bss_delta.parquet", t.select(["id", "i32", "f32", "f64", "str", "large_str"]), use_dictionary=False,
      column_encoding={"f32": "BYTE_STREAM_SPLIT", "f64": "BYTE_STREAM_SPLIT", "id": "DELTA_BINARY_PACKED",
                       "i32": "DELTA_BINARY_PACKED", "str": "DELTA_BYTE_ARRAY", "large_str": "DELTA_LENGTH_BYTE_ARRAY"})
write("int96.parquet", t.select(["id", "ts_ns", "ts_ms"]), use_deprecated_int96_timestamps=True)
write("empty.parquet", t.slice(0, 0))
write("one_row.parquet", t.slice(0, 1))

# nested data with V1 pages that have no offset index: rows may span pages
n = 200_000
lens = rng.integers(0, 30, n)
offsets = np.concatenate([[0], np.cumsum(lens)]).astype(np.int32)
vals = pa.array(rng.standard_normal(offsets[-1]).astype(np.float32))
emb = pa.ListArray.from_arrays(pa.array(offsets), vals)
nested = pa.table({
    "id": pa.array(np.arange(n)),
    "emb": emb,
    "tags": pa.array([[f"t{j}" for j in range(k % 4)] for k in range(n)]),
    "s": pa.array([{"a": k, "b": [k, k + 1]} for k in range(n)]),
})
write("nested_v1.parquet", nested, row_group_size=n, data_page_size=8192)
write("nested_v2_pi.parquet", nested, row_group_size=50_000, data_page_size=8192, data_page_version="2.0", write_page_index=True)

# polars writer
import polars as pl
pdf = pl.DataFrame({
    "id": np.arange(5000),
    "cat": pl.Series(["a", "b", "c", "d", "e"] * 1000, dtype=pl.Categorical),
    "f": rng.standard_normal(5000),
    "lst": [[k, k * 2] for k in range(5000)],
    "st": [{"p": k, "q": str(k)} for k in range(5000)],
    "dt": pl.datetime_range(dt.datetime(2020, 1, 1), dt.datetime(2020, 1, 1) + dt.timedelta(seconds=4999), "1s", eager=True),
})
pdf.write_parquet(out / "polars.parquet", row_group_size=1000)
write_expected(out / "polars.parquet", pq.read_table(out / "polars.parquet"))
print("wrote polars.parquet", flush=True)

# other writers (optional): DuckDB and fastparquet
try:
    import duckdb
    con = duckdb.connect()
    con.execute("""
        CREATE TABLE t AS SELECT
            i AS id,
            i::HUGEINT * 1000000000000 AS huge,
            (i * 1.5)::DECIMAL(18, 3) AS dec18,
            uuid() AS rand_uuid,
            ('2024-01-01'::DATE + i::INTEGER) AS d,
            ('2024-01-01 00:00:00'::TIMESTAMP + to_microseconds(i * 1234567)) AS ts,
            ('2024-01-01 00:00:00'::TIMESTAMP_NS + to_microseconds(i * 7)) AS ts_ns,
            CASE WHEN i % 5 = 0 THEN NULL ELSE 'str' || i END AS s,
            ['a', 'b', NULL][1:(i % 4)::INTEGER] AS lst,
            {'x': i, 'y': [i, i + 1]} AS st,
            MAP {'k': i} AS mp,
            (i % 2 = 0) AS flag,
            ('\\x' || lpad(to_hex(i % 256), 2, '0'))::BLOB AS blob
        FROM range(300000) r(i)
    """)
    con.execute(f"COPY t TO '{out / 'duckdb.parquet'}' (FORMAT parquet, ROW_GROUP_SIZE 100000)")
    con.execute(f"COPY t TO '{out / 'duckdb_v2.parquet'}' (FORMAT parquet, PARQUET_VERSION v2, COMPRESSION zstd)")
    for name in ("duckdb.parquet", "duckdb_v2.parquet"):
        write_expected(out / name, pq.read_table(out / name).drop_columns(["rand_uuid"]))
        print("wrote", name, flush=True)
except ImportError:
    print("duckdb not installed, skipping DuckDB fixtures")

try:
    import fastparquet
    import pandas as pd
    n = 20000
    df = pd.DataFrame({
        "id": np.arange(n),
        "f": rng.standard_normal(n),
        "s": [f"s{k}" if k % 3 else None for k in range(n)],
        "cat": pd.Categorical(["x", "y", "z", "x"] * (n // 4)),
        "ts": pd.date_range("2020-01-01", periods=n, freq="37s"),
        "b": [k % 2 == 0 for k in range(n)],
    })
    fastparquet.write(str(out / "fastparquet.parquet"), df, row_group_offsets=5000, compression="GZIP")
    write_expected(out / "fastparquet.parquet", pq.read_table(out / "fastparquet.parquet").drop_columns(
        [c for c in pq.read_table(out / "fastparquet.parquet").column_names if c.startswith("__index")]))
    print("wrote fastparquet.parquet", flush=True)
except ImportError:
    print("fastparquet not installed, skipping fastparquet fixtures")

if big:
    # tall: one 30M-row row group, no page index (pyarrow default) -> header scan path
    n = 30_000_000
    ids = np.arange(n, dtype=np.int64)
    tall = pa.table({
        "id": ids,
        "x": rng.standard_normal(n),
        "cat": pa.array(np.array(["alpha", "beta", "gamma", "delta"])[ids % 4]).dictionary_encode(),
        "s": pc.binary_join_element_wise("row-", pc.cast(pa.array(ids), pa.string()), ""),
        "opt": with_nulls(pa.array((ids % 1000).astype(np.int32)), 0.3),
    })
    write("tall_single_rg.parquet", tall, row_group_size=n)
    write("tall_pageindex_zstd.parquet", tall, row_group_size=1 << 20, write_page_index=True, compression="zstd")
    del tall
    # wide: 5000 float32 columns
    nrow, ncol = 20_000, 5000
    data = {f"col_{c:05d}": rng.standard_normal(nrow).astype(np.float32) for c in range(ncol)}
    data = {"name": pa.array([f"sample_{k}" for k in range(nrow)]), **data}
    wide = pa.table(data)
    write("wide_5000.parquet", wide, row_group_size=5000)
    del wide, data

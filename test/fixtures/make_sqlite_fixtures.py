"""Generate SQLite test fixtures for eyeball, with expected values for test/check.mjs.

Usage: python make_sqlite_fixtures.py OUTDIR [--big]
"""
import json
import math
import random
import shutil
import sqlite3
import sys
from pathlib import Path

out = Path(sys.argv[1])
big = "--big" in sys.argv
out.mkdir(parents=True, exist_ok=True)
rnd = random.Random(42)


def expected_value(v):
    """Canonical text the viewer should produce for a value returned by Python's sqlite3."""
    if v is None:
        return None
    if isinstance(v, bool):
        return str(int(v))
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        # SQLite shows REAL values with a decimal point; compare numerically, but require the point
        return {"float": repr(v), "point": math.isfinite(v)}
    if isinstance(v, bytes):
        # the viewer shows bytes as text only if they are valid UTF-8 without control characters
        try:
            text = v.decode("utf-8")
            if not any(ord(c) < 32 and c not in "\t\n\r" for c in text):
                return text
        except UnicodeDecodeError:
            pass
        return "0x" + v.hex()
    return v


def table_expectations(con, name, order, skip=(), samples=150):
    """Expected values for sampled rows of a table, in b-tree order."""
    q = '"' + name.replace('"', '""') + '"'
    columns = [d[0] for d in con.execute(f"SELECT * FROM {q} LIMIT 0").description]
    n = con.execute(f"SELECT count(*) FROM {q}").fetchone()[0]
    want = sorted(set(rnd.sample(range(n), min(samples, n))) | ({0, n - 1} if n else set()))
    checks = []
    wanted = iter(want)
    target = next(wanted, None)
    for i, row in enumerate(con.execute(f"SELECT * FROM {q} ORDER BY {order}")):
        if i != target:
            continue
        for col, v in zip(columns, row):
            if col not in skip:
                checks.append({"row": i, "col": col, "expected": expected_value(v)})
        target = next(wanted, None)
        if target is None:
            break
    return {"name": name, "numRows": n, "columns": columns, "checks": checks}


def write_expected(path, tables):
    Path(str(path) + ".expected.json").write_text(json.dumps({"tables": tables}))
    print("wrote", path, path.stat().st_size, flush=True)


def fresh(path, page_size=None, encoding=None, journal=None, auto_vacuum=None):
    for suffix in ("", "-wal", "-shm", "-journal"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    con = sqlite3.connect(path)
    if page_size:
        con.execute(f"PRAGMA page_size = {page_size}")
    if encoding:
        con.execute(f"PRAGMA encoding = '{encoding}'")
    if auto_vacuum:
        con.execute(f"PRAGMA auto_vacuum = {auto_vacuum}")
    if journal:
        con.execute(f"PRAGMA journal_mode = {journal}")
    return con


def value_row(k):
    ints = [0, 1, -1, 127, -128, 128, 32767, -32768, 2**23 - 1, -(2**23), 2**31 - 1, -(2**31), 2**47 - 1, -(2**47), 2**62, 2**63 - 1, -(2**63)]
    floats = [0.0, -0.0, 1.0, -2.5, 1e-300, 1e300, math.inf, -math.inf, 0.1, 123456789.125]
    texts = ["", "plain", "ünïcødé ✓ 日本", "emoji 🎉", "tab\there", "new\nline", "quote's \"x\""]
    mixed = [None, k, k * 0.5, f"text{k}", bytes([k % 256, 0, 255]), "12"][k % 6]
    big_text = ("lorem ipsum " * (400 + (k * 37) % 17000)) if k % 97 == 3 else None
    big_blob = bytes(rnd.getrandbits(8) for _ in range(5000 + k % 70000)) if k % 131 == 5 else None
    return (
        ints[k % len(ints)] if k % 11 else None,
        floats[k % len(floats)] if k % 13 else None,
        texts[k % len(texts)] + str(k),
        bytes([k % 256, (k * 7) % 256, 1, 2]) if k % 5 else None,
        [k, k / 4, str(k), None][k % 4],
        mixed,
        big_text,
        big_blob,
    )


# ---- types.sqlite: value types, overflow, WITHOUT ROWID, ALTER TABLE, generated columns, odd schemas
path = out / "types.sqlite"
con = fresh(path)
con.executescript("""
CREATE TABLE t (
  id INTEGER PRIMARY KEY,  -- rowid alias
  i INTEGER,
  r REAL,
  s TEXT NOT NULL,
  b BLOB,
  n NUMERIC,
  mixed,
  big_text TEXT,
  big_blob BLOB
);
CREATE TABLE wr (k TEXT, n INTEGER, val REAL, note TEXT, PRIMARY KEY (k, n)) WITHOUT ROWID;
CREATE TABLE altered (a INTEGER);
CREATE TABLE gen (a INTEGER, v INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL, s INTEGER AS (a * 3) STORED, z TEXT);
CREATE TABLE "weird name" (
  "col one" TEXT /* a comment, with a comma */,
  [col two] INTEGER DEFAULT -7,
  `col three` REAL,
  "quote""d" TEXT COLLATE NOCASE
);
CREATE TABLE empty_t (x, y);
CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
CREATE TABLE child (
  id INTEGER PRIMARY KEY DESC,
  parent_id INTEGER REFERENCES parent(id) ON DELETE SET NULL ON UPDATE CASCADE,
  created TEXT DEFAULT CURRENT_TIMESTAMP,
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  CONSTRAINT qty_positive CHECK (qty < 1000000)
);
CREATE INDEX t_i ON t(i);
CREATE VIEW v AS SELECT id, s FROM t WHERE id < 10;
""")
con.executemany("INSERT INTO t VALUES (NULL,?,?,?,?,?,?,?,?)", (value_row(k) for k in range(3000)))
con.execute("DELETE FROM t WHERE id % 7 = 0")
con.executemany("INSERT INTO wr VALUES (?,?,?,?)",
                ((f"key{k % 977:04d}", k, k * 1.25, "note " * (k % 30)) for k in range(30000)))
con.executemany("INSERT INTO altered VALUES (?)", ((k,) for k in range(100)))
con.execute("ALTER TABLE altered ADD COLUMN b TEXT DEFAULT 'x'")
con.execute("ALTER TABLE altered ADD COLUMN c INTEGER DEFAULT 42")
con.execute("ALTER TABLE altered ADD COLUMN d REAL DEFAULT -1.5")
con.execute("ALTER TABLE altered ADD COLUMN e")
con.executemany("INSERT INTO altered VALUES (?,?,?,?,?)", ((k, f"b{k}", k * 2, k / 3, "e") for k in range(100, 200)))
con.executemany("INSERT INTO gen (a, z) VALUES (?, ?)", ((k, f"z{k}") for k in range(500)))
con.executemany('INSERT INTO "weird name" VALUES (?,?,?,?)', ((f"one{k}", k, k + 0.5, f"Q{k}") for k in range(50)))
con.execute('INSERT INTO "weird name" ("col one") VALUES (\'defaults\')')
con.executemany("INSERT INTO parent (name) VALUES (?)", ((f"p{k}",) for k in range(20)))
con.executemany("INSERT INTO child (id, parent_id, created, qty) VALUES (?,?,?,?)", ((k, k % 20 + 1, "2024-01-01", k) for k in range(300)))
con.execute("CREATE TABLE ctas AS SELECT id, s, r FROM t WHERE id < 60")
try:
    con.execute("CREATE TABLE strict_t (a INTEGER, b TEXT, c REAL, d BLOB, e ANY) STRICT")
    con.executemany("INSERT INTO strict_t VALUES (?,?,?,?,?)", ((k, str(k), k / 2, bytes([k % 256]), k) for k in range(100)))
except sqlite3.OperationalError as error:
    print("no STRICT tables:", error)
try:
    con.execute("CREATE VIRTUAL TABLE docs USING fts5(title, body)")
    con.executemany("INSERT INTO docs VALUES (?, ?)", ((f"title {k}", "body text " * k) for k in range(50)))
except sqlite3.OperationalError as error:
    print("no FTS5:", error)
con.commit()
tables = [
    table_expectations(con, "t", "rowid"),
    table_expectations(con, "wr", "k, n"),
    table_expectations(con, "altered", "rowid"),
    table_expectations(con, "gen", "rowid", skip={"v"}),
    table_expectations(con, "weird name", "rowid"),
    table_expectations(con, "empty_t", "rowid"),
    table_expectations(con, "parent", "rowid"),
    table_expectations(con, "child", "rowid"),
    table_expectations(con, "ctas", "rowid"),
    table_expectations(con, "sqlite_sequence", "rowid"),
    table_expectations(con, "sqlite_schema", "rowid"),
]
if con.execute("SELECT 1 FROM sqlite_schema WHERE name = 'strict_t'").fetchone():
    tables.append(table_expectations(con, "strict_t", "rowid"))
con.close()
write_expected(path, tables)

# ---- text encodings
for enc in ("UTF-16le", "UTF-16be"):
    path = out / f"{enc.lower().replace('-', '')}.sqlite"
    con = fresh(path, encoding=enc)
    con.execute("CREATE TABLE u (id INTEGER PRIMARY KEY, s TEXT, n REAL)")
    con.executemany("INSERT INTO u (s, n) VALUES (?, ?)", ((f"ünïcødé {k} 日本 🎉 " + "x" * (k % 3000), k * 0.5) for k in range(800)))
    con.commit()
    tables = [table_expectations(con, "u", "rowid")]
    con.close()
    write_expected(path, tables)

# ---- page sizes, with overflow chains
for page_size in (512, 65536):
    path = out / f"pagesize{page_size}.sqlite"
    con = fresh(path, page_size=page_size)
    con.execute("CREATE TABLE p (id INTEGER PRIMARY KEY, s TEXT, b BLOB)")
    con.executemany("INSERT INTO p (s, b) VALUES (?, ?)", (("y" * (k * 53 % 200000), bytes(k % 256 for _ in range(k * 31 % 100000))) for k in range(400)))
    con.commit()
    tables = [table_expectations(con, "p", "rowid")]
    con.close()
    write_expected(path, tables)

# ---- auto-vacuum (pointer map pages) with deletions
path = out / "autovacuum.sqlite"
con = fresh(path, auto_vacuum="FULL")
con.execute("CREATE TABLE a (id INTEGER PRIMARY KEY, s TEXT)")
con.executemany("INSERT INTO a (s) VALUES (?)", ((f"row {k} " + "z" * (k % 500),) for k in range(20000)))
con.execute("DELETE FROM a WHERE id % 3 = 0")
con.commit()
tables = [table_expectations(con, "a", "rowid")]
con.close()
write_expected(path, tables)

# ---- WAL: committed transactions that are still only in the -wal file
path = out / "wal.sqlite"
src = out / "wal_src.sqlite"
con = fresh(src, journal="WAL")
con.execute("PRAGMA wal_autocheckpoint = 0")
con.execute("CREATE TABLE w (id INTEGER PRIMARY KEY, s TEXT)")
con.executemany("INSERT INTO w (s) VALUES (?)", ((f"checkpointed {k}",) for k in range(1000)))
con.commit()
con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
con.executemany("INSERT INTO w (s) VALUES (?)", ((f"in wal {k}",) for k in range(1000, 3000)))
con.execute("UPDATE w SET s = 'updated in wal' WHERE id % 100 = 0")
con.execute("DELETE FROM w WHERE id % 250 = 1")
con.commit()
con.execute("CREATE TABLE only_in_wal (x INTEGER, y TEXT)")
con.executemany("INSERT INTO only_in_wal VALUES (?, ?)", ((k, f"y{k}") for k in range(100)))
con.commit()
# copy the database and its WAL while the connection keeps them from being checkpointed
for suffix in ("", "-wal"):
    shutil.copyfile(str(src) + suffix, str(path) + suffix)
tables = [table_expectations(con, "w", "rowid"), table_expectations(con, "only_in_wal", "rowid")]
con.close()
for suffix in ("", "-wal", "-shm"):
    Path(str(src) + suffix).unlink(missing_ok=True)
write_expected(path, tables)

# ---- wide: 1500 columns
path = out / "wide.sqlite"
con = fresh(path)
ncol = 1500
con.execute("CREATE TABLE wide (" + ", ".join(f"c{c:04d} REAL" for c in range(ncol)) + ")")
con.executemany(f"INSERT INTO wide VALUES ({','.join('?' * ncol)})", ([rnd.random() if (r + c) % 9 else None for c in range(ncol)] for r in range(2000)))
con.commit()
tables = [table_expectations(con, "wide", "rowid", samples=40)]
con.close()
write_expected(path, tables)

if big:
    # ---- big: 5 million rows
    path = out / "big.sqlite"
    con = fresh(path)
    con.execute("CREATE TABLE big (id INTEGER PRIMARY KEY, x REAL, s TEXT, cat TEXT, k INTEGER)")
    cats = ["alpha", "beta", "gamma", "delta"]
    con.executemany("INSERT INTO big (x, s, cat, k) VALUES (?, ?, ?, ?)",
                    ((rnd.random(), f"row-{k}", cats[k % 4], k * 7 % 1000) for k in range(5_000_000)))
    con.commit()
    tables = [table_expectations(con, "big", "rowid", samples=300)]
    con.close()
    write_expected(path, tables)

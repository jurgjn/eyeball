"""Generate SquashFS images (and a SIF image) for test/check.mjs, with expected listings.

Needs mksquashfs (squashfs-tools).

Usage: python make_squashfs_fixtures.py OUTDIR
"""
import hashlib
import json
import os
import random
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
rnd = random.Random(7)
BLOCK = 128 * 1024

src = Path(tempfile.mkdtemp(prefix="eyeball-squashfs-")) / "tree"
src.mkdir()


def write(path, data):
    p = src / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data if isinstance(data, bytes) else data.encode())


write("hello.txt", "hello squashfs\n")
write("empty.txt", b"")
write("dir/nested/deep/file.txt", "deep down\n" * 100)
write("exact.bin", rnd.randbytes(BLOCK))  # exactly one block
write("random.bin", rnd.randbytes(3 * BLOCK + 12345))  # incompressible: stored uncompressed; ends in a fragment
write("text.txt", "".join(f"line {i}: the quick brown fox jumps over the lazy dog\n" for i in range(20000)))
# sparse: a block of data, two blocks of zeros (holes), and a tail
write("sparse.bin", rnd.randbytes(BLOCK) + bytes(2 * BLOCK) + rnd.randbytes(5000))
for i in range(1000):
    write(f"many/f{i:04d}.txt", f"file {i}\n")
write("unicode/ünïcødé ✓ 日本.txt", "unicode name\n")
write("spaces in name.txt", "spaces\n")
# empty directories: they have no listing, and may share its position with the next directory's
for name in ("empty-a", "empty-b/inner-empty"):
    (src / name).mkdir(parents=True)
write("empty-b/z.txt", "after an empty directory\n")
os.symlink("hello.txt", src / "link-to-hello")
os.symlink("dir/nested", src / "link-to-dir")
os.symlink("/dir/nested/deep/file.txt", src / "abs-link")
os.symlink("nowhere", src / "dangling")
os.symlink("loop2", src / "loop1")
os.symlink("loop1", src / "loop2")
os.link(src / "hello.txt", src / "hard-hello")
# data files for Eyeball's readers
(src / "data").mkdir()
pq.write_table(pa.table({"x": list(range(5000)), "s": [f"row {i}" for i in range(5000)]}), src / "data/table.parquet", row_group_size=1000)
con = sqlite3.connect(src / "data/db.sqlite")
con.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)")
con.executemany("INSERT INTO t (s) VALUES (?)", ((f"value {i}",) for i in range(3000)))
con.commit()
con.close()

# the expected listing
expected = {}
for root, dirs, files in os.walk(src):
    for name in dirs + files:
        p = Path(root) / name
        rel = "/" + str(p.relative_to(src))
        if p.is_symlink():
            expected[rel] = {"kind": "symlink", "target": os.readlink(p)}
        elif p.is_dir():
            expected[rel] = {"kind": "directory"}
        else:
            data = p.read_bytes()
            expected[rel] = {"kind": "file", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def mksquashfs(name, *options):
    path = out / name
    path.unlink(missing_ok=True)
    subprocess.run(["mksquashfs", str(src), str(path), "-noappend", "-quiet", "-no-progress", *options], check=True)
    return path


def write_expected(path, **extra):
    Path(str(path) + ".expected.json").write_text(json.dumps({"files": expected, **extra}))
    print("wrote", path, path.stat().st_size, flush=True)


for comp in ("gzip", "zstd", "lz4"):
    write_expected(mksquashfs(f"tree-{comp}.sqfs", "-comp", comp))
write_expected(mksquashfs("tree-zstd-4k.sqfs", "-comp", "zstd", "-b", "4096"))
write_expected(mksquashfs("tree-uncompressed.sqfs", "-noI", "-noD", "-noF", "-noX"))
write_expected(mksquashfs("tree-no-fragments.sqfs", "-comp", "zstd", "-no-fragments"))
write_expected(mksquashfs("tree-xz.sqfs", "-comp", "xz"), unsupported="xz")


def sif(image, path):
    """A minimal SIF image (https://github.com/sylabs/sif) whose primary system partition is image."""
    data = image.read_bytes()
    descriptors, offset = 4096, 32768
    header = b"#!/usr/bin/env run-singularity\n".ljust(32, b"\0") + b"SIF_MAGIC\0" + b"01\0" + b"\0\0\0" + uuid.uuid4().bytes
    header += struct.pack("<8q", 0, 0, 0, 1, descriptors, 585, offset, len(data))
    extra = struct.pack("<ii", 1, 2) + b"02\0"  # Squash, PrimSys, amd64
    descriptor = struct.pack("<i?III7q", 0x4004, True, 1, 0, 0, offset, len(data), len(data), 0, 0, 0, 0)
    descriptor += b"rootfs".ljust(128, b"\0") + extra.ljust(384, b"\0")
    assert len(header) == 128 and len(descriptor) == 585
    path.write_bytes(header.ljust(descriptors, b"\0") + descriptor.ljust(offset - descriptors, b"\0") + data)


sif(out / "tree-gzip.sqfs", out / "tree.sif")
write_expected(out / "tree.sif")
shutil.rmtree(src.parent)

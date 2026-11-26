"""Generate zip archives, SquashFS images and a SIF image of a tree of files for test/check.mjs,
with the expected listings.

SquashFS images need mksquashfs (squashfs-tools); without it, only the zip archives are made.

Usage: python make_archive_fixtures.py OUTDIR
"""
import bz2
import hashlib
import io
import json
import os
import random
import shutil
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import uuid
import zipfile
import zlib
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
rnd = random.Random(7)
BLOCK = 128 * 1024

src = Path(tempfile.mkdtemp(prefix="eyeball-archives-")) / "tree"
src.mkdir()


def write(path, data):
    p = src / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data if isinstance(data, bytes) else data.encode())


write("hello.txt", "hello archives\n")
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


def write_expected(path, files=None, **extra):
    """The expected listing (the tree's, by default), and what else check.mjs checks: info, the
    archive's details, or error, a word in the message it can't be opened with."""
    Path(str(path) + ".expected.json").write_text(json.dumps({"files": expected if files is None else files, **extra}))
    print("wrote", path, path.stat().st_size, flush=True)


# ---- SquashFS and SIF images ----


def mksquashfs(name, *options):
    path = out / name
    path.unlink(missing_ok=True)
    subprocess.run(["mksquashfs", str(src), str(path), "-noappend", "-quiet", "-no-progress", *options], check=True)
    return path


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


if shutil.which("mksquashfs"):
    for comp in ("gzip", "zstd", "lz4"):
        write_expected(mksquashfs(f"tree-{comp}.sqfs", "-comp", comp))
    write_expected(mksquashfs("tree-zstd-4k.sqfs", "-comp", "zstd", "-b", "4096"))
    write_expected(mksquashfs("tree-uncompressed.sqfs", "-noI", "-noD", "-noF", "-noX"))
    write_expected(mksquashfs("tree-no-fragments.sqfs", "-comp", "zstd", "-no-fragments"))
    write_expected(mksquashfs("tree-xz.sqfs", "-comp", "xz"), error="xz")
    sif(out / "tree-gzip.sqfs", out / "tree.sif")
    write_expected(out / "tree.sif")
else:
    print("mksquashfs not found: no SquashFS images", flush=True)


# ---- zip archives ----


def zip_tree(file, compression, directories=True):
    """The tree in a zip archive, written by zipfile, with symbolic links as on Unix."""
    with zipfile.ZipFile(file, "w", compression) as zf:
        for rel, entry in expected.items():
            if entry["kind"] == "symlink":
                info = zipfile.ZipInfo(rel[1:])
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                zf.writestr(info, os.readlink(src / rel[1:]), compression)
            elif entry["kind"] == "file" or directories:
                zf.write(src / rel[1:], rel[1:])


zip_tree(out / "tree-deflate.zip", zipfile.ZIP_DEFLATED)
write_expected(out / "tree-deflate.zip", info={"zip64": False, "offset": 0})
# without entries for directories, they are implied by the paths of the files in them, and empty ones are missing
zip_tree(out / "tree-stored.zip", zipfile.ZIP_STORED, directories=False)
not_directories = [p for p, e in expected.items() if e["kind"] != "directory"]
write_expected(out / "tree-stored.zip", {p: e for p, e in expected.items() if e["kind"] != "directory" or any(q.startswith(p + "/") for q in not_directories)})

# ZIP64 records, and ZIP64 fields for the sizes of files over 200 bytes and the positions of all
# but the first (zipfile writes them where values don't fit, so lower the limits; below 200, it
# would refuse small files that deflate makes larger), and other data before the archive that
# positions in it don't count (as in a self-extracting archive)
buffer = io.BytesIO()
limits = zipfile.ZIP64_LIMIT, zipfile.ZIP_FILECOUNT_LIMIT
zipfile.ZIP64_LIMIT, zipfile.ZIP_FILECOUNT_LIMIT = 200, 0
try:
    zip_tree(buffer, zipfile.ZIP_DEFLATED)
finally:
    zipfile.ZIP64_LIMIT, zipfile.ZIP_FILECOUNT_LIMIT = limits
prefix = b"#!/bin/sh\necho 'a self-extracting archive'\nexit 0\n" + bytes(1000)
(out / "tree-zip64.zip").write_bytes(prefix + buffer.getvalue())
assert zipfile.ZipFile(out / "tree-zip64.zip").testzip() is None
write_expected(out / "tree-zip64.zip", info={"zip64": True, "offset": len(prefix)})


def raw_zip(path, entries, prefix=b"", comment=b""):
    """A zip archive written by hand, for what zipfile doesn't write. Entries are dicts of name (bytes)
    and data, and optionally compressed (the data as stored), method, flags, host, external and extra."""
    local = central = b""
    for e in entries:
        compressed = e.get("compressed", e["data"])
        head = struct.pack("<HHHHHIII", 20, e.get("flags", 0), e.get("method", 0), 0, 0x5B21, zlib.crc32(e["data"]), len(compressed), len(e["data"]))
        name, extra = e["name"], e.get("extra", b"")
        central += struct.pack("<IH", 0x02014B50, e.get("host", 3) << 8 | 20) + head + struct.pack("<HHHHHII", len(name), len(extra), 0, 0, 0, e.get("external", 0o100644 << 16), len(local)) + name + extra
        local += struct.pack("<I", 0x04034B50) + head + struct.pack("<HH", len(name), 0) + name + compressed
    n = len(entries)
    path.write_bytes(prefix + local + central + struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, n, n, len(central), len(local), len(comment)) + comment)


def file_entry(data, **extra):
    return {"kind": "file", "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), **extra}


text = b"compressible text\n" * 1000
special = [
    # zstd (zipfile writes it from Python 3.14)
    ({"name": b"zstd.txt", "data": text, "method": 93, "compressed": pa.Codec("zstd").compress(text, asbytes=True)}, "/zstd.txt"),
    # names: in code page 437 without the UTF-8 flag, in UTF-8 without the flag (as Info-ZIP's zip
    # writes them) and with it, and in UTF-8 in an extra field, with the CRC-32 of the name it replaces
    ({"name": "café ñ.txt".encode("cp437"), "data": b"cp437\n"}, "/café ñ.txt"),
    ({"name": "naïve 日本.txt".encode(), "data": b"utf-8\n"}, "/naïve 日本.txt"),
    ({"name": "flagged ✓.txt".encode(), "data": b"flagged\n", "flags": 0x800}, "/flagged ✓.txt"),
    ({"name": b"unicode-extra.txt", "data": b"extra field\n",
      "extra": struct.pack("<HHBI", 0x7075, 5 + len("unicode Ω.txt".encode()), 1, zlib.crc32(b"unicode-extra.txt")) + "unicode Ω.txt".encode()}, "/unicode Ω.txt"),
    # backslashes from Windows, '..' that would leave the archive, and a modification time in UTC
    ({"name": b"win\\sub\\file.txt", "data": b"windows\n", "host": 0, "external": 0x20}, "/win/sub/file.txt"),
    ({"name": b"../escape.txt", "data": b"escape\n"}, "/escape.txt"),
    ({"name": b"timestamp.txt", "data": b"utc\n", "extra": struct.pack("<HHBI", 0x5455, 5, 1, 1700000000)}, "/timestamp.txt"),
    # files that can't be read
    ({"name": b"bzip2.txt", "data": text, "method": 12, "compressed": bz2.compress(text)}, "/bzip2.txt"),
    ({"name": b"encrypted.txt", "data": text, "flags": 1, "compressed": bytes(12) + text}, "/encrypted.txt"),
]
files = {"/win": {"kind": "directory"}, "/win/sub": {"kind": "directory"}}
for entry, path in special:
    files[path] = file_entry(entry["data"])
files["/timestamp.txt"]["mtime"] = 1700000000
files["/bzip2.txt"]["error"] = "bzip2"
files["/encrypted.txt"]["error"] = "encrypted"
prefix = b"data before the archive" * 10
raw_zip(out / "special.zip", [e for e, _ in special], prefix, "a comment ✓".encode())
write_expected(out / "special.zip", files, info={"offset": len(prefix), "unreadable": 2, "comment": "a comment ✓"})

with zipfile.ZipFile(out / "empty.zip", "w"):
    pass
write_expected(out / "empty.zip", {})
(out / "not-a.zip").write_bytes(rnd.randbytes(100000))
write_expected(out / "not-a.zip", {}, error="not a zip archive")
shutil.rmtree(src.parent)

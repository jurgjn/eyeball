# Eyeball: Parquet and SQLite viewer for VS Code, VSCodium and Positron

Eyeball opens Parquet files and SQLite databases in a scrollable grid. It is built for large
files, with hundreds of millions of rows or tens of thousands of columns, and only reads the
parts of the file that are on screen. Opening a Parquet file reads just its footer, and
scrolling to any row, even in the middle of a single huge row group, decodes only the pages
that hold the visible rows. SQLite tables open immediately, and any row can be reached once
it has been counted. Tables that have an index and whose rowids have no gaps (tables that rows
were only added to) can be scrolled in full as soon as the index has been counted: seconds to
minutes for a table of tens of millions of rows on a network file system.

![icon](media/icon.png)

## Installing

Download `eyeball-<version>.vsix` from the [latest release](https://github.com/jurgjn/eyeball/releases)
and install it with **Extensions: Install from VSIX...** in VS Code, VSCodium or Positron, or from
the command line with `code --install-extension eyeball-<version>.vsix` (or `codium`/`positron`).
Builds of every commit are available as artifacts of the [CI runs](https://github.com/jurgjn/eyeball/actions).

## Features

- Opens `.parquet`, `.parq` and `.pq` files, and SQLite databases (`.sqlite`, `.sqlite3`, `.db`,
  `.db3`, `.s3db`, `.sl3`), in a read-only viewer (double-click in the explorer).
- Virtual grid in both directions, with smooth scrolling for any number of rows and columns.
- All Parquet types, including nested lists, structs and maps, decimals at full precision,
  timestamps at full (nanosecond) precision, intervals and binary data. Files from pyarrow,
  polars, DuckDB, fastparquet and other writers; Snappy, gzip, zstd, Brotli and LZ4 compression.
- SQLite: all tables of a database, including `WITHOUT ROWID` tables, `STRICT` tables and the
  `sqlite_schema` table; committed changes still in the write-ahead log (`-wal` file); UTF-16
  databases; any page size.
- Column list with filtering (substring or `/regex/`), jumping to a column, and showing or
  hiding columns.
- Column details: for Parquet, physical and logical types, compression, encodings, sizes, null
  counts and min/max statistics; for SQLite, declared type, affinity, keys, defaults and
  generated columns.
- File details: for Parquet, row groups, sizes, writer and key-value metadata (e.g. the pandas
  or Arrow schema); for SQLite, the database header and the schema with its SQL.
- Cell detail panel with the full value; nested values are pretty-printed.
- Copy a cell or range as tab-separated text (up to 2 million cells), with or without the header.
- Reloads automatically when the file changes on disk.
- Fast on network file systems (NFS, Lustre, GPFS): many reads are issued at once, and a
  progress bar shows how far reading and counting rows has got.
- Works over Remote SSH, WSL and in containers: the extension runs where the file is, and
  only the visible values are sent to the viewer.

## Usage

| Action | Keys / mouse |
| --- | --- |
| Move | arrow keys, Page Up/Down, Home/End, Ctrl+arrows (to the edge) |
| Select a range | Shift+arrows, Shift+click, or drag |
| Select a row / column / everything | click a row number / column header / the top-left corner |
| Copy (with header) | Ctrl+C (Ctrl+Shift+C) |
| Show the full value | Enter, double-click, or the **Cell value** button |
| Go to row | Ctrl+G |
| Find a column | Ctrl+F opens the column list; Enter cycles through the matches |
| Resize / fit a column | drag / double-click the right edge of its header |
| More | right-click |

Row numbers start at 0, like in pandas and polars.

Commands:

- **Eyeball: Open Parquet File or SQLite Database...** opens files through a file dialog.
- **Open with Eyeball** in the explorer context menu, for when another viewer or editor is the default.

Settings:

- `eyeball.cacheSizeMB` (default 512): memory for decoded pages, shared by all open files.
- `eyeball.maxCellChars` (default 300): longer values are truncated in the grid, but shown in
  full in the cell detail panel and copied in full.
- `eyeball.parallelReads` (default 64): reads issued at once. On network file systems each read
  waits for the server, so more reads at once are faster. Above 4, files are read through a
  helper process (Node reads files on 4 threads); 4 or less reads in the extension host only.

If another extension also opens these files (Positron's Data Explorer, or another SQLite
viewer), VS Code asks which one to use. To make Eyeball the default, add this to your settings:

```json
"workbench.editorAssociations": { "*.parquet": "eyeball.parquet", "*.db": "eyeball.sqlite" }
```

Eyeball also opens `.db` files by default. If yours aren't SQLite databases, associate `*.db`
with another editor (`"*.db": "default"` for the text editor).

## How it works

The extension host reads the file footer with [hyparquet](https://github.com/hyparam/hyparquet),
a pure JavaScript Parquet reader, so there are no native dependencies and one package works on
every platform. For each column chunk, Eyeball builds an index of its data pages. It uses the
offset index if the file has one (`write_page_index=True` in pyarrow). Otherwise it scans the
page headers on demand, stopping at the rows that are needed. The webview asks for blocks of
128 rows of the visible columns. The extension decodes the pages that hold those rows and
sends back the formatted text. Decoded pages are kept in an LRU cache.

SQLite databases are read directly from the [file format](https://www.sqlite.org/fileformat2.html),
also without native dependencies. A SQL engine can't jump to the n-th row of a table (`OFFSET n`
steps through all the rows before it), so Eyeball lists a table's leaf pages from its interior
b-tree pages, counts the rows of each leaf in the background, and maps row positions to leaf
pages. The first rows show immediately, and the row count grows while the rest are counted.
A table whose rows are large (e.g. blobs) has about as many leaf pages as rows, so if one of
its indexes is much smaller, Eyeball counts the index entries instead. If there are as many
rows as the span of the rowids, the rowids have no gaps, so row n has rowid min + n and is
found directly from the interior pages, without counting the table. Otherwise the table's rows
are counted, towards the total from the index. Column names and types come from the `CREATE
TABLE` statements. Committed pages in the write-ahead log take precedence over the database
file, as in SQLite. The grid reads the first kilobyte of each value; the detail panel and
copying read values in full.

Counting runs in the background, and reads for the rows on screen go first. Node reads files on
a pool of 4 threads, while network file systems take milliseconds per read and many reads at
once are much faster, so Eyeball reads through a small helper process with a larger pool
(`eyeball.parallelReads`). If the helper can't be started, files are read in the extension host.

Requests that are superseded while scrolling are dropped, so fast scrolling through a large
file stays responsive.

Limitations: encrypted Parquet files and Parquet files whose column chunks live in other files
are not supported. Because Eyeball has no SQL engine, SQLite views, virtual tables (e.g. FTS;
their data is in the tables named after them) and the values of `VIRTUAL` generated columns
can't be shown. Files outside the local file system (in virtual workspaces) are read into
memory in full.

## Building

```sh
npm install
npm run build        # bundle to dist/
npm run typecheck
npm run package      # creates eyeball-<version>.vsix
```

Tests compare the values read by Eyeball with pyarrow and Python's sqlite3 for a set of
generated files:

```sh
pip install -r test/requirements.txt
python test/fixtures/make_fixtures.py /tmp/eyeball-data [--big]
python test/fixtures/make_sqlite_fixtures.py /tmp/eyeball-data [--big]
node test/check.mjs /tmp/eyeball-data [--perf]
```

`--big` adds large files (30 million rows and 5000 columns of Parquet, 5 million rows of
SQLite); `--perf` times random access on them. `--parallel=N` sets the reads at once, as
`eyeball.parallelReads` does (4 or less reads without the helper process).

`test/e2e.mjs` drives the packaged extension in [openvscode-server](https://github.com/gitpod-io/openvscode-server)
with Playwright (`npm install playwright`): it opens the fixtures, scrolls, jumps, filters columns,
copies and checks the results, and saves screenshots.

```sh
openvscode-server --install-extension eyeball-*.vsix
openvscode-server --port 3123 --without-connection-token &
node test/e2e.mjs http://127.0.0.1:3123 /tmp/eyeball-data /tmp/eyeball-shots
```

## Releasing

`main` carries the next version with a `-dev` suffix (`0.1.0-dev`). The [CI workflow](.github/workflows/ci.yml)
tests and packages every push; the VSIX of each run is kept as an artifact, versioned with the run
number (`0.1.0-dev.42`) so that each build installs as an update.

To make a release:

1. In `CHANGELOG.md` (in the [Keep a Changelog](https://keepachangelog.com/) format), rename
   `## [Unreleased]` to the version and date, e.g. `## [0.1.0] - 2026-12-01`, and add an empty
   `## [Unreleased]` above it. At the bottom, point `[Unreleased]` at `compare/v0.1.0...HEAD` and
   add a link for the new version (`releases/tag/v0.1.0` for the first release,
   `compare/vPREVIOUS...v0.1.0` after that).
2. Publish a GitHub release with a new tag `vX.Y.Z`, e.g. `gh release create v0.1.0 --generate-notes`.
   CI takes the version from the tag, runs the tests, and attaches `eyeball-X.Y.Z.vsix` to the release.
3. Set the version on `main` to the next `-dev` version.

Releases marked as pre-releases on GitHub, or with a pre-release tag such as `v0.2.0-beta.1`, are
only attached to the GitHub release.

Publishing to the extension registries is set up but off until their tokens are added as
repository secrets (**Settings > Secrets and variables > Actions**); from then on, releases are
also published there:

- VS Code Marketplace: create the publisher `jurgjn` at https://marketplace.visualstudio.com/manage
  and an Azure DevOps personal access token with the **Marketplace (Manage)** scope, and add the
  token as `VSCE_PAT`.
- Open VSX (VSCodium, Positron): sign in at https://open-vsx.org, create an access token, create the
  namespace with `npx ovsx create-namespace jurgjn -p <token>`, and add the token as `OVSX_PAT`.

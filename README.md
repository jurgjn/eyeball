# Eyeball: Parquet viewer for VS Code, VSCodium and Positron

Eyeball opens Parquet files in a scrollable grid. It is built for large files, with hundreds of
millions of rows or tens of thousands of columns, and only reads the parts of the file that
are on screen. Opening a file reads just its footer. Scrolling to any row, even in the middle of
a single huge row group, decodes only the pages that hold the visible rows.

![icon](media/icon.png)

## Features

- Opens `.parquet`, `.parq` and `.pq` files as a custom editor (double-click in the explorer).
- Virtual grid in both directions, with smooth scrolling for any number of rows and columns.
- All Parquet types, including nested lists, structs and maps, decimals at full precision,
  timestamps at full (nanosecond) precision, intervals and binary data. Files from pyarrow,
  polars, DuckDB, fastparquet and other writers; Snappy, gzip, zstd, Brotli and LZ4 compression.
- Column list with filtering (substring or `/regex/`), jumping to a column, and showing or
  hiding columns.
- Column details from the file metadata: physical and logical types, compression, encodings,
  sizes, null counts and min/max statistics.
- File details: row groups, sizes, writer and key-value metadata (e.g. the pandas or Arrow schema).
- Cell detail panel with the full value; nested values are pretty-printed.
- Copy a cell or range as tab-separated text (up to 2 million cells), with or without the header.
- Reloads automatically when the file changes on disk.
- Works over Remote SSH, WSL and in containers: the extension runs where the file is, and
  only the visible values are sent to the editor.

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

- **Eyeball: Open Parquet File...** opens files through a file dialog.
- **Open with Eyeball** in the explorer context menu, for when another editor is the default.

Settings:

- `eyeball.cacheSizeMB` (default 512): memory for decoded pages, shared by all open files.
- `eyeball.maxCellChars` (default 300): longer values are truncated in the grid, but shown in
  full in the cell detail panel and copied in full.

If another extension also opens Parquet files (Positron's Data Explorer, for example), VS Code
asks which one to use. To make Eyeball the default, add this to your settings:

```json
"workbench.editorAssociations": { "*.parquet": "eyeball.parquet" }
```

## How it works

The extension host reads the file footer with [hyparquet](https://github.com/hyparam/hyparquet),
a pure JavaScript Parquet reader, so there are no native dependencies and one package works on
every platform. For each column chunk, Eyeball builds an index of its data pages. It uses the
offset index if the file has one (`write_page_index=True` in pyarrow). Otherwise it scans the
page headers on demand, stopping at the rows that are needed. The webview asks for blocks of
128 rows of the visible columns. The extension decodes the pages that hold those rows and
sends back the formatted text. Decoded pages are kept in an LRU cache.

Requests that are superseded while scrolling are dropped, so fast scrolling through a large
file stays responsive.

Limitations: encrypted files and files whose column chunks live in other files are not
supported. Files outside the local file system (in virtual workspaces) are read into memory
in full.

## Building

```sh
npm install
npm run build        # bundle to dist/
npm run typecheck
npm run package      # creates eyeball-<version>.vsix
```

Install the package with **Extensions: Install from VSIX...**, or from the command line with
`code --install-extension eyeball-0.1.0.vsix` (or `codium`/`positron`).

Tests compare the values read by Eyeball with pyarrow for a set of generated files:

```sh
python test/fixtures/make_fixtures.py /tmp/eyeball-data [--big]
node test/check.mjs /tmp/eyeball-data [--perf]
```

`--big` adds multi-GB files (30 million rows, 5000 columns); `--perf` times random access on them.

`test/e2e.mjs` drives the packaged extension in [openvscode-server](https://github.com/gitpod-io/openvscode-server)
with Playwright (`npm install playwright`): it opens the fixtures, scrolls, jumps, filters columns,
copies and checks the results, and saves screenshots.

```sh
openvscode-server --install-extension eyeball-0.1.0.vsix
openvscode-server --port 3123 --without-connection-token &
node test/e2e.mjs http://127.0.0.1:3123 /tmp/eyeball-data /tmp/eyeball-shots
```

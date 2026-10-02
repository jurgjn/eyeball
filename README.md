# Eyeball

A read-only data viewer for VS Code, VSCodium and Positron. Open a CSV, TSV,
Parquet or SQLite file and scroll through it like a spreadsheet — no editing,
no loading the whole thing into memory first.

## Why

Text editors choke on multi-gigabyte data files, and spreadsheet apps choke
even sooner. Eyeball never reads a whole file into memory: every screen of
rows is fetched on demand from an embedded query engine, so opening a 10GB
Parquet file is as fast as opening a 10KB one.

## Installation

Eyeball isn't published to a marketplace yet, so install it from a `.vsix`
file — either a prebuilt one from GitHub, or one you build yourself.

### Option A: download a prebuilt release

1. Grab the `.vsix` for your platform from the
   [latest release](https://github.com/jurgjn/eyeball/releases/latest):
   - `eyeball-linux-x64.vsix`
   - `eyeball-win32-x64.vsix`
   - `eyeball-darwin-x64.vsix` (Intel Mac)
   - `eyeball-darwin-arm64.vsix` (Apple Silicon)
2. Install it:
   - **GUI** (VS Code, VSCodium or Positron): open the Extensions view, click
     the `...` menu at the top, choose **Install from VSIX...**, and select
     the downloaded file.
   - **Command line**:
     ```bash
     code --install-extension eyeball-linux-x64.vsix       # VS Code
     codium --install-extension eyeball-linux-x64.vsix     # VSCodium
     positron --install-extension eyeball-linux-x64.vsix   # Positron
     ```

No tagged release yet? Every push to `main` also uploads per-OS `.vsix`
files as artifacts on the [CI workflow run](https://github.com/jurgjn/eyeball/actions/workflows/ci.yml)
(requires a GitHub sign-in to download) — grab one of those instead.

### Option B: build from source

```bash
git clone git@github.com:jurgjn/eyeball.git
cd eyeball
npm install
npm run build
npx vsce package           # writes eyeball-<version>.vsix
code --install-extension eyeball-<version>.vsix
```

`duckdb` and `better-sqlite3` are native addons — `npm install` fetches a
prebuilt binary matching the machine you run it on, so build (or at least
run `npm install`) on the same OS/architecture you intend to use the
extension on.

## Supported files

| Extension | Backend |
|---|---|
| `.csv`, `.csv.gz` | DuckDB (`read_csv_auto`) |
| `.tsv`, `.tsv.gz` | DuckDB (`read_csv_auto`, tab delimiter) |
| `.parquet` | DuckDB (`read_parquet`) |
| `.sqlite`, `.sqlite3`, `.db`, `.db3` | better-sqlite3 |

Gzip-compressed CSV/TSV is handled transparently — DuckDB decompresses on the
fly, there's nothing to configure. SQLite files with multiple tables show a
table picker in the toolbar.

No parsing is reimplemented here: all format handling is delegated to
[DuckDB](https://duckdb.org) (CSV/TSV/Parquet, including gzip, delimiter
sniffing, type inference and Parquet row-group pushdown) and
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (SQLite).

## Using it

Right-click a supported file in the Explorer and choose **Open with
Eyeball**, or run **Eyeball: Open Data File...** from the Command Palette.
Eyeball doesn't take over your default CSV/TSV editor — it registers as an
option, so plain-text files stay plain text unless you ask for the Eyeball
view.

The viewer shows:
- a virtualized, scroll-on-demand table (only visible rows are ever fetched)
- click a column header to sort by it (click again to reverse, a third time
  to clear)
- a status bar with row/column counts
- a table picker, for SQLite files with more than one table

## How large files stay fast

- **Parquet**: DuckDB reads only the row groups and columns needed to answer
  a query, so paging and sorting stay fast regardless of file size — this is
  the best format for very large (10GB+) files.
- **CSV/TSV (including `.gz`)**: DuckDB streams the file rather than loading
  it whole, but these formats have no index. Paging (`LIMIT`/`OFFSET`) and
  sorting over a huge CSV require scanning from the start each time, so deep
  scrolling and sorting get progressively slower as the file grows. The
  total row count is therefore computed in the background after the first
  page of rows is shown, rather than up front.
- **SQLite**: pagination uses `LIMIT`/`OFFSET` against the table as stored;
  tables without a suitable index will see the same `OFFSET`-scales-with-depth
  behavior as CSV.

If you control the format and the file is large, Parquet will give the best
experience.

## Development

```bash
npm install
npm run build       # bundle extension.js + webview.js via esbuild
npm run watch        # rebuild on change
npm run typecheck    # tsc --noEmit
```

Press F5 to launch an Extension Development Host with Eyeball loaded against
your checkout — faster than packaging and sideloading a `.vsix` while
iterating. See [Installation](#installation) for producing and installing a
`.vsix` directly.

`duckdb` and `better-sqlite3` are native Node addons, kept external to the
esbuild bundle (see `esbuild.js`) and shipped inside the extension's
`node_modules` instead. `.vscodeignore` strips each package down to its
compiled binary and JS glue, dropping their full C++ source trees (DuckDB's
amalgamation, SQLite's amalgamation) that are only needed to build from
source when no prebuild matches — that's never the case for a packaged
release here.

## Continuous integration & releases

- **`.github/workflows/ci.yml`** runs on every push to `main` and every pull
  request: installs, typechecks, builds, and packages a `.vsix` on Ubuntu,
  Windows and macOS. Running on all three catches native-dependency
  install/build breakage per platform, not just on whichever OS a
  contributor happens to use. Each `.vsix` is uploaded as a short-lived
  workflow artifact.
- **`.github/workflows/release.yml`** runs when a `v*.*.*` tag is pushed. It
  builds a platform-specific `.vsix` for `linux-x64`, `win32-x64`,
  `darwin-x64` and `darwin-arm64` — each on a runner matching that platform,
  since duckdb/better-sqlite3 are native addons that can't be
  cross-compiled — and attaches all four to a GitHub Release.

To cut a release:

```bash
npm version patch   # or minor/major — bumps package.json and tags it
git push --follow-tags
```

Neither workflow publishes to the VS Code Marketplace or Open VSX Registry;
that would need a publisher access token added as a repository secret, which
isn't set up here.

## Architecture

```
src/
  extension.ts            activation, command registration
  editorProvider.ts        CustomReadonlyEditorProvider: wires a DataSource
                            to a webview over postMessage
  dataSources/
    types.ts               DataSource interface
    duckdbSource.ts         CSV/TSV/Parquet via an in-memory DuckDB view
    sqliteSource.ts         SQLite via better-sqlite3
    index.ts                picks a DataSource by file extension
  shared/protocol.ts        message types shared by host and webview
  webview/
    main.ts                 virtual-scroll table, sort UI, request cache
    getHtml.ts               webview HTML shell
    main.css
```

The webview never receives more than a couple hundred rows at a time: it
renders only the rows currently scrolled into view (plus a small buffer),
fetching new blocks as you scroll and discarding stale requests when you
sort or switch tables.

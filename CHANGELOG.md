# Changelog

All notable changes to Eyeball are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-27

### Added

- SquashFS images and Apptainer/Singularity images (`.sif`) as read-only folders in the explorer,
  compressed with gzip, zstd or lz4: opening an image shows its details, and **Show in Explorer**
  or **Open SquashFS Image as Folder** adds it to the workspace. The files in images open like any
  other, and Parquet files and SQLite databases in them are read in place.
- Zip archives (`.zip`) as read-only folders in the explorer, in the same way (**Open Zip Archive
  as Folder**), also ZIP64 and self-extracting archives. Files stored without compression are read
  in place; files compressed with deflate or zstd are decompressed into memory when they are opened.

## [0.2.0] - 2026-11-25

### Added

- Viewer for molecular structures, volumes and trajectories, with [Mol*](https://molstar.org) 5.13:
  all the formats Mol* reads (PDB, PDBx/mmCIF, BinaryCIF, SDF, MOL2, GRO, XYZ, CCP4/MRC, DCD,
  XTC, ...), also gzipped. Binary and gzipped files open in it by default, text formats with
  **Open with Eyeball** or **Reopen Editor With...**. A trajectory opens with the topology or
  structure of the same name next to it. Follows the color theme, and reloads when the file
  changes on disk.

## [0.1.0] - 2026-11-24

### Added

- Viewer for Parquet files (`.parquet`, `.parq`, `.pq`) and SQLite databases (`.sqlite`,
  `.sqlite3`, `.db`, `.db3`, `.s3db`, `.sl3`), with the commands **Open Parquet File or SQLite
  Database...** and **Open with Eyeball**.
- Parquet: reads only the data pages needed for the rows on screen, using the page index when the
  file has one and scanning page headers otherwise.
- SQLite: all tables (including WITHOUT ROWID and STRICT tables), read directly from the file
  format; the write-ahead log is applied; table selector, column and schema details.
- SQLite: tables open immediately, and rows are counted in the background. Rows are counted with
  a much smaller index if the table has one; if the rowids have no gaps, every row can then be
  reached without counting the table.
- Many reads at once (`eyeball.parallelReads`, through a helper process), which makes counting
  and scrolling much faster on network file systems; reads for the screen go before counting.
- Progress bar while opening a file or table and while counting rows; the share of the rows
  counted, and the amount read while opening.
- Virtual grid for any number of rows and columns.
- Column list with filtering and hiding, column statistics, file and row group metadata.
- Cell detail panel, copying ranges as tab-separated text.
- Reloads when the file changes on disk.

[Unreleased]: https://github.com/jurgjn/eyeball/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jurgjn/eyeball/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jurgjn/eyeball/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jurgjn/eyeball/releases/tag/v0.1.0

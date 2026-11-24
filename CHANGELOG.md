# Changelog

## 0.1.0 (unreleased)

First release.

- Custom editor for `.parquet`, `.parq` and `.pq` files.
- Reads only the data pages needed for the rows on screen, using the page index when the file
  has one and scanning page headers otherwise.
- Virtual grid for any number of rows and columns.
- Column list with filtering and hiding, column statistics, file and row group metadata.
- Cell detail panel, copying ranges as tab-separated text.
- SQLite databases: all tables (including WITHOUT ROWID and STRICT tables), read directly from
  the file format with rows counted in the background; the write-ahead log is applied; table
  selector, column and schema details.
- Large SQLite databases open immediately: the b-tree is listed while rows are counted, instead
  of before the first rows are shown. Rows are counted with a smaller index if there is one; if
  the rowids have no gaps, every row can then be reached without counting the table.
- Many reads at once (`eyeball.parallelReads`, through a helper process), which makes counting
  and scrolling much faster on network file systems; reads for the screen go before counting.
- Progress bar while opening a file or table and while counting rows; the share of the rows
  counted, and the amount read while opening.

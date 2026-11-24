# Changelog

## 0.1.0

First release.

- Custom editor for `.parquet`, `.parq` and `.pq` files.
- Reads only the data pages needed for the rows on screen, using the page index when the file
  has one and scanning page headers otherwise.
- Virtual grid for any number of rows and columns.
- Column list with filtering and hiding, column statistics, file and row group metadata.
- Cell detail panel, copying ranges as tab-separated text.

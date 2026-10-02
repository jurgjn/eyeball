import type { ColumnInfo, SortSpec } from '../shared/protocol';

export type { ColumnInfo, SortSpec };

/**
 * A read-only handle onto one data file. A source may expose multiple
 * selectable tables (sqlite) or a single implicit relation (csv/tsv/parquet),
 * in which case `table` arguments are ignored.
 */
export interface DataSource {
  /** Human-readable label shown in the status bar, e.g. "DuckDB (Parquet)". */
  readonly kind: string;

  /** Selectable table names, or undefined when the source is a single relation. */
  listTables(): Promise<string[] | undefined>;

  getColumns(table?: string): Promise<ColumnInfo[]>;

  /** Resolves to null when an exact count is too expensive to compute eagerly. */
  getRowCount(table?: string): Promise<number | null>;

  getRows(table: string | undefined, offset: number, limit: number, sort?: SortSpec): Promise<unknown[][]>;

  dispose(): void;
}

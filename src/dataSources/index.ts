import type { DataSource } from './types';
import { DuckDbSource } from './duckdbSource';
import { SqliteSource } from './sqliteSource';

export type { DataSource } from './types';

const SQLITE_EXTENSIONS = ['.sqlite', '.sqlite3', '.db', '.db3'];
const DUCKDB_EXTENSIONS = ['.parquet', '.csv', '.csv.gz', '.tsv', '.tsv.gz'];

export function createDataSource(filePath: string): DataSource {
  const lower = filePath.toLowerCase();
  if (SQLITE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return new SqliteSource(filePath);
  }
  if (DUCKDB_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return new DuckDbSource(filePath);
  }
  throw new Error(`Eyeball does not know how to open: ${filePath}`);
}

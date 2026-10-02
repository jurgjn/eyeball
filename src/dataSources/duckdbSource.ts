import * as duckdb from 'duckdb';
import type { ColumnInfo, DataSource, SortSpec } from './types';
import { quoteIdent, quoteLiteral } from './sqlEscape';

/**
 * Backs CSV/TSV (optionally gzip-compressed) and Parquet files with an
 * in-memory DuckDB connection. DuckDB's own readers handle delimiter
 * sniffing, type inference, gzip decompression and Parquet row-group
 * pushdown, so no parsing happens in this extension.
 */
export class DuckDbSource implements DataSource {
  readonly kind: string;
  private readonly conn: duckdb.Connection;
  private readonly ready: Promise<void>;

  constructor(filePath: string) {
    const lower = filePath.toLowerCase();
    let relation: string;
    if (lower.endsWith('.parquet')) {
      this.kind = 'DuckDB (Parquet)';
      relation = `read_parquet(${quoteLiteral(filePath)})`;
    } else if (lower.endsWith('.tsv') || lower.endsWith('.tsv.gz')) {
      this.kind = 'DuckDB (TSV)';
      relation = `read_csv_auto(${quoteLiteral(filePath)}, delim='\t')`;
    } else {
      this.kind = 'DuckDB (CSV)';
      relation = `read_csv_auto(${quoteLiteral(filePath)})`;
    }

    const db = new duckdb.Database(':memory:');
    this.conn = db.connect();
    this.ready = this.run(`CREATE VIEW data AS SELECT * FROM ${relation}`).then(() => undefined);
  }

  private run(sql: string): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      this.conn.all(sql, (err: Error | null, rows: Record<string, unknown>[]) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  async listTables(): Promise<string[] | undefined> {
    return undefined;
  }

  async getColumns(): Promise<ColumnInfo[]> {
    await this.ready;
    const rows = await this.run('DESCRIBE data');
    return rows.map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
  }

  async getRowCount(): Promise<number | null> {
    await this.ready;
    const rows = await this.run('SELECT COUNT(*)::BIGINT AS c FROM data');
    return Number(rows[0]?.c ?? 0);
  }

  async getRows(_table: string | undefined, offset: number, limit: number, sort?: SortSpec): Promise<unknown[][]> {
    await this.ready;
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(0, Math.floor(limit));
    const orderClause = sort ? ` ORDER BY ${quoteIdent(sort.column)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}` : '';
    const rows = await this.run(`SELECT * FROM data${orderClause} LIMIT ${safeLimit} OFFSET ${safeOffset}`);
    return rows.map((r) => Object.values(r).map(toSerializable));
  }

  dispose(): void {
    try {
      this.conn.close?.(() => undefined);
    } catch {
      // connection already gone; nothing to clean up
    }
  }
}

/**
 * DuckDB returns BIGINT/HUGEINT columns as native BigInt, which the
 * extension-host <-> webview message channel cannot transport. Downgrade to
 * a plain number where that's lossless, otherwise to a decimal string.
 */
function toSerializable(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  return value;
}

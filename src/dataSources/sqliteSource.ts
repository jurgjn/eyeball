import Database from 'better-sqlite3';
import type { ColumnInfo, DataSource, SortSpec } from './types';
import { quoteIdent } from './sqlEscape';

/** Backs .sqlite/.sqlite3/.db/.db3 files via better-sqlite3 (read-only). */
export class SqliteSource implements DataSource {
  readonly kind = 'SQLite';
  private readonly db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath, { readonly: true, fileMustExist: true });
  }

  async listTables(): Promise<string[] | undefined> {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  async getColumns(table?: string): Promise<ColumnInfo[]> {
    if (!table) throw new Error('No table selected');
    const rows = this.db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string; type: string }[];
    return rows.map((r) => ({ name: r.name, type: r.type || 'TEXT' }));
  }

  async getRowCount(table?: string): Promise<number | null> {
    if (!table) return null;
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).get() as { c: number };
    return row.c;
  }

  async getRows(table: string | undefined, offset: number, limit: number, sort?: SortSpec): Promise<unknown[][]> {
    if (!table) throw new Error('No table selected');
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(0, Math.floor(limit));
    const orderClause = sort ? ` ORDER BY ${quoteIdent(sort.column)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}` : '';
    const stmt = this.db.prepare(`SELECT * FROM ${quoteIdent(table)}${orderClause} LIMIT ? OFFSET ?`);
    const rows = stmt.all(safeLimit, safeOffset) as Record<string, unknown>[];
    return rows.map((r) => Object.values(r));
  }

  dispose(): void {
    this.db.close();
  }
}

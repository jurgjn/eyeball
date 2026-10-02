export interface ColumnInfo {
  name: string;
  type: string;
}

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export type HostToWebviewMessage =
  | {
      type: 'init';
      kind: string;
      fileName: string;
      tables?: string[];
      currentTable?: string;
      columns: ColumnInfo[];
    }
  | { type: 'columns'; columns: ColumnInfo[]; currentTable?: string }
  | { type: 'rowCount'; count: number | null }
  | { type: 'rows'; requestId: number; offset: number; rows: unknown[][] }
  | { type: 'error'; requestId?: number; message: string };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'selectTable'; table: string }
  | { type: 'getRows'; requestId: number; offset: number; limit: number; sort?: SortSpec };

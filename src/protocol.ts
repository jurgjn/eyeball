// Messages exchanged between the extension host and the webview.
// Shared by both bundles, so this file must not import anything.

/** Rows per data block; the webview requests and caches data in blocks of this many rows. */
export const BLOCK_ROWS = 128

export interface ColumnMeta {
  name: string
  /** Short type label, e.g. "int64", "timestamp[us, UTC]", "list<string>". */
  type: string
  /** Right-align numbers. */
  numeric: boolean
}

/** A table in a file (Parquet files have one; SQLite databases have several). */
export interface TableEntry {
  name: string
  /** "table", "view", "virtual table", ... */
  kind: string
  /** False for entries that can't be shown, such as SQLite views. */
  supported: boolean
  note?: string
}

export interface TableInit {
  format: 'parquet' | 'sqlite'
  fileName: string
  fileSize: number
  tables: TableEntry[]
  /** Name of the table shown. */
  table: string
  numRows: number
  /** numRows is a lower bound; rowCount messages follow while rows are being counted. */
  counting: boolean
  /** While counting: the fraction of the work done. */
  progress?: number
  /** While counting: the total number of rows, if it is already known. */
  totalRows?: number
  columns: ColumnMeta[]
}

/** A block of the file info panel: key-value items, collapsible long values, and/or a table. */
export interface InfoSection {
  title?: string
  items?: KeyValue[]
  details?: KeyValue[]
  table?: string[][]
}

/** A cell value as sent to the webview: display text, or null for a null value. */
export type CellText = string | null

export interface KeyValue {
  key: string
  value: string
}

// host -> webview

export type HostMessage =
  /** Opening the file, or a table of it (table is set when switching tables). */
  | { type: 'loading'; fileName: string; table?: string }
  /** While opening: how much has been read so far. */
  | { type: 'activity'; reads: number; bytes: number }
  | { type: 'init'; table: TableInit; reloaded: boolean }
  | { type: 'fatal'; message: string }
  | {
    type: 'data'
    block: number
    cols: number[]
    /** values[i] holds the block's rows for column cols[i]. */
    values: CellText[][]
    /** Decoding errors by column index; such columns have no entry in values. */
    errors?: Record<number, string>
  }
  | { type: 'cell'; requestId: number; row: number; col: number; text: string; isNull: boolean }
  | { type: 'columnInfo'; col: number; items: KeyValue[] }
  | { type: 'fileInfo'; sections: InfoSection[] }
  | { type: 'rowCount'; numRows: number; counting: boolean; progress?: number; totalRows?: number }
  | { type: 'status'; message: string }

// webview -> host

export interface BlockRequest {
  block: number
  cols: number[]
}

export type WebviewMessage =
  | { type: 'ready' }
  /** Replaces any previously requested, not yet started blocks. */
  | { type: 'fetch'; requests: BlockRequest[] }
  | { type: 'cell'; requestId: number; row: number; col: number }
  | { type: 'copy'; rowStart: number; rowEnd: number; cols: number[]; header: boolean }
  | { type: 'copyText'; text: string }
  | { type: 'columnInfo'; col: number }
  | { type: 'fileInfo' }
  | { type: 'selectTable'; name: string }

// ---- the structure viewer (Mol*) ----

/** A file for Mol* to read. */
export interface StructureFile {
  name: string
  data: Uint8Array
  /** For the files of a trajectory: which part it is, and its Mol* format. */
  part?: 'model' | 'topology' | 'coordinates'
  format?: string
}

export type StructureHostMessage =
  /** Show these files; note explains what's missing, e.g. the topology of a trajectory. */
  | { type: 'load'; files: StructureFile[]; note?: string; reloaded: boolean }
  | { type: 'fatal'; message: string }

export type StructureWebviewMessage = { type: 'ready' }

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

export interface TableInit {
  fileName: string
  fileSize: number
  numRows: number
  numRowGroups: number
  columns: ColumnMeta[]
}

/** A cell value as sent to the webview: display text, or null for a null value. */
export type CellText = string | null

export interface KeyValue {
  key: string
  value: string
}

// host -> webview

export type HostMessage =
  | { type: 'loading'; fileName: string }
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
  | { type: 'fileInfo'; items: KeyValue[]; keyValueMetadata: KeyValue[]; rowGroups: string[][] }
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

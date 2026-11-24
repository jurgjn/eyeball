import type { CellText, ColumnMeta, InfoSection, KeyValue, TableEntry } from '../protocol'
import { formatCopy, formatDisplay, formatFull, type ValueFormat } from './format'

/** A column as the readers describe it. */
export interface ReaderColumn {
  name: string
  meta: ColumnMeta
  format: ValueFormat
}

/** Random access to the rows of one table. Subclasses read columns; display, copy and detail text are shared. */
export abstract class TableReader {
  abstract readonly columns: ReaderColumn[]
  /** Rows known so far. Grows while `counting` is true. */
  abstract readonly numRows: number
  counting = false
  /** While counting: the fraction of the work done. */
  progress = 0
  /** While counting: the total number of rows, if it is already known. */
  totalRows?: number
  private readonly listeners = new Set<() => void>()

  /**
   * Values of a column for rows [start, end). Readers may shorten very large values
   * unless `full` is set (used for the detail panel and copying).
   */
  abstract readColumn(col: number, start: number, end: number, full?: boolean): Promise<unknown[]>

  abstract columnInfo(col: number): KeyValue[]

  /** Called whenever numRows, counting or progress change. Returns a function that unsubscribes. */
  onRowCount(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected rowCountChanged(): void {
    for (const listener of this.listeners) listener()
  }

  /** Display text for rows [start, end) of a column. */
  async displayColumn(col: number, start: number, end: number, maxChars: number): Promise<CellText[]> {
    const values = await this.readColumn(col, start, end)
    const { format } = this.columns[col]
    return values.map(v => formatDisplay(v, format, maxChars))
  }

  async fullValue(row: number, col: number): Promise<{ text: string; isNull: boolean }> {
    const [value] = await this.readColumn(col, row, row + 1, true)
    return { text: formatFull(value, this.columns[col].format), isNull: value === null || value === undefined }
  }

  /** Tab-separated text of a rectangular range, quoted like spreadsheet applications do. */
  async copyText(rowStart: number, rowEnd: number, cols: number[], header: boolean): Promise<string> {
    const columns = await Promise.all(cols.map(c => this.readColumn(c, rowStart, rowEnd, true)))
    const quote = (text: string) => /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    const lines: string[] = []
    if (header) lines.push(cols.map(c => quote(this.columns[c].name)).join('\t'))
    for (let r = 0; r < rowEnd - rowStart; r++) {
      lines.push(cols.map((c, i) => quote(formatCopy(columns[i][r], this.columns[c].format) ?? '')).join('\t'))
    }
    return lines.join('\n')
  }

  dispose(): void {
    this.listeners.clear()
  }
}

/** An open file holding one or more tables. */
export interface TableFile {
  readonly format: 'parquet' | 'sqlite'
  readonly size: number
  readonly tables: TableEntry[]
  /** The table to show first. */
  readonly defaultTable: string
  openTable(name: string): Promise<TableReader>
  fileInfo(fileName: string): InfoSection[]
  /** Stop work in the background, such as counting rows: the file has changed and is replaced. */
  stopCounting?(): void
  dispose(): void
}

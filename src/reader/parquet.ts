// Random access to the rows of a Parquet file, decoding only the pages that are needed.
//
// For every column chunk we keep an index of its data pages (from the offset index if the
// file has one, otherwise by scanning page headers on demand). Reading rows [a, b) of a
// column then decodes just the pages that hold those rows, using hyparquet's page decoder.
// Decoded pages and dictionaries are kept in a shared LRU cache.

import { parquetMetadataAsync, parquetSchema, readOffsetIndex } from 'hyparquet'
import type { ColumnChunk, DecodedArray, FileMetaData, PageHeader, ParquetParsers, SchemaTree } from 'hyparquet'
import { assembleNested } from 'hyparquet/src/assemble.js'
import { parquetHeader, readPage } from 'hyparquet/src/column.js'
import { DEFAULT_PARSERS, convert } from 'hyparquet/src/convert.js'
import { decompressPage } from 'hyparquet/src/datapage.js'
import { readRleBitPackedHybrid } from 'hyparquet/src/encoding.js'
import { getMaxRepetitionLevel } from 'hyparquet/src/schema.js'
import type { ColumnMeta, InfoSection, KeyValue, TableEntry } from '../protocol'
import { compressors } from './compressors'
import { DateValue, TimestampValue, UuidValue, formatBytes, formatDisplay, type ValueFormat } from './format'
import { LruCache, estimateSize } from './lru'
import { isNumeric, leafDecoding, typeLabel, valueFormat } from './schema'
import type { ByteSource } from './source'
import { TableReader, type TableFile } from './types'

type ColumnDecoder = Parameters<typeof readPage>[2]

const textDecoder = new TextDecoder()

/** Parsers that keep full timestamp precision, defer formatting, and keep JSON as text. */
export const parsers: ParquetParsers = {
  ...DEFAULT_PARSERS,
  timestampFromMilliseconds: (v: bigint) => new TimestampValue(BigInt(v), 3),
  timestampFromMicroseconds: (v: bigint) => new TimestampValue(BigInt(v), 6),
  timestampFromNanoseconds: (v: bigint) => new TimestampValue(BigInt(v), 9),
  dateFromDays: (days: number) => new DateValue(days),
  uuidFromBytes: (bytes: Uint8Array) => bytes && new UuidValue(bytes),
  jsonFromBytes: (bytes: Uint8Array) => bytes && textDecoder.decode(bytes),
}

/** A physical (leaf) column. */
interface Leaf {
  index: number
  path: string[]
  key: string
  schemaPath: SchemaTree[]
  maxRep: number
  element: SchemaTree['element']
  utf8: boolean
}

/** A top-level column, as shown in the grid. */
export interface Column {
  index: number
  name: string
  node: SchemaTree
  leaves: number[]
  format: ValueFormat
  meta: ColumnMeta
}

/** A data page, or for nested columns written without row-aligned pages, a page fragment. */
interface PageRef {
  offset: number
  /** Bytes including the page header. */
  size: number
  /** Row (within the row group) of the first row that starts in this page. */
  firstRow: number
  /** Number of rows that start in this page. */
  numRows: number
  /** Page starts at a row boundary. Pages that don't continue the last row of the previous page. */
  clean: boolean
}

/** Page index of one column chunk, built incrementally. */
interface ChunkIndex {
  start: number
  end: number
  numRows: number
  /** All pages start at row boundaries (non-repeated column, DataPageV2 or offset index). */
  allClean: boolean
  dict?: { offset: number; size: number }
  pages: PageRef[]
  scanPos: number
  rowsSeen: number
  complete: boolean
  lock: Promise<void>
  /** Read-ahead buffer for header scanning. */
  window?: { start: number; bytes: Uint8Array }
}

const HEADER_WINDOW = 1 << 16
let tableCounter = 0

/** A Parquet file: one table. */
export class ParquetFile implements TableFile {
  readonly format = 'parquet'
  readonly defaultTable = 'data'
  readonly tables: TableEntry[] = [{ name: 'data', kind: 'table', supported: true }]

  private constructor(private readonly table: ParquetTable) {}

  static async open(source: ByteSource, cache: LruCache<unknown>): Promise<ParquetFile> {
    return new ParquetFile(await ParquetTable.open(source, cache))
  }

  get size(): number {
    return this.table.source.size
  }

  async openTable(): Promise<ParquetTable> {
    return this.table
  }

  fileInfo(fileName: string): InfoSection[] {
    return this.table.fileInfo(fileName)
  }

  dispose(): void {
    this.table.dispose()
  }
}

export class ParquetTable extends TableReader {
  readonly numRows: number
  readonly columns: Column[]
  readonly leaves: Leaf[]
  readonly rowGroupStarts: number[]
  private readonly prefix = `t${++tableCounter}:`
  private readonly chunkIndexes = new Map<string, Promise<ChunkIndex>>()
  private readonly pending = new Map<string, Promise<unknown>>()

  private constructor(
    readonly source: ByteSource,
    readonly metadata: FileMetaData,
    private readonly cache: LruCache<unknown>,
  ) {
    super()
    const schema = parquetSchema(metadata)
    this.leaves = []
    this.columns = schema.children.map((node, index) => {
      const leaves: number[] = []
      const collect = (n: SchemaTree, path: SchemaTree[]) => {
        if (n.children.length) {
          for (const child of n.children) collect(child, [...path, child])
          return
        }
        const { element, utf8 } = leafDecoding(n.element, path.length === 2)
        leaves.push(this.leaves.length)
        this.leaves.push({
          index: this.leaves.length,
          path: n.path,
          key: n.path.join('\u0000'),
          schemaPath: path,
          maxRep: getMaxRepetitionLevel(path),
          element,
          utf8,
        })
      }
      collect(node, [schema, node])
      return {
        index,
        name: node.element.name,
        node,
        leaves,
        format: valueFormat(node),
        meta: { name: node.element.name, type: typeLabel(node), numeric: isNumeric(node) },
      }
    })
    this.rowGroupStarts = [0]
    for (const rg of metadata.row_groups) {
      this.rowGroupStarts.push(this.rowGroupStarts[this.rowGroupStarts.length - 1] + Number(rg.num_rows))
    }
    this.numRows = this.rowGroupStarts[this.rowGroupStarts.length - 1]
  }

  static async open(source: ByteSource, cache: LruCache<unknown>): Promise<ParquetTable> {
    if (source.size < 12) throw new Error(`not a Parquet file (only ${source.size} bytes)`)
    const tail = await source.read(source.size - 4, source.size)
    const magic = textDecoder.decode(tail)
    if (magic === 'PARE') throw new Error('encrypted Parquet files are not supported')
    if (magic !== 'PAR1') throw new Error('not a Parquet file (missing PAR1 footer)')
    const file = {
      byteLength: source.size,
      slice: async (start: number, end?: number) => (await source.read(start, end ?? source.size)).buffer as ArrayBuffer,
    }
    const metadata = await parquetMetadataAsync(file, { parsers })
    return new ParquetTable(source, metadata, cache)
  }

  /** Drop cached pages and close the file. */
  override dispose(): void {
    super.dispose()
    this.cache.deletePrefix(this.prefix)
    this.chunkIndexes.clear()
    this.pending.clear()
    this.source.close().catch(() => {})
  }

  /** Decoded values of a top-level column for rows [start, end). */
  async readColumn(col: number, start: number, end: number): Promise<unknown[]> {
    const column = this.columns[col]
    if (!column) throw new RangeError(`no column ${col}`)
    start = Math.max(0, start)
    end = Math.min(this.numRows, end)
    const out: unknown[] = []
    for (let rg = this.rowGroupAt(start); rg < this.metadata.row_groups.length && start < end; rg++) {
      const groupStart = this.rowGroupStarts[rg]
      const groupEnd = this.rowGroupStarts[rg + 1]
      if (groupEnd <= start) continue
      const values = await this.readColumnInGroup(column, rg, start - groupStart, Math.min(end, groupEnd) - groupStart)
      for (let i = 0; i < values.length; i++) out.push(values[i])
      start = groupEnd
    }
    return out
  }

  rowGroupAt(row: number): number {
    // last row group starting at or before row
    let lo = 0
    let hi = this.metadata.row_groups.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.rowGroupStarts[mid] <= row) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  private async readColumnInGroup(column: Column, rg: number, start: number, end: number): Promise<unknown[]> {
    if (!column.node.children.length) return this.readLeafRows(rg, column.leaves[0], start, end)
    // nested column: read each leaf for the same rows, then assemble with hyparquet
    const subcolumns = new Map<string, DecodedArray>()
    await Promise.all(column.leaves.map(async l => {
      const rows = await this.readLeafRows(rg, l, start, end)
      // assembly modifies nested arrays in place, and these are shared with the page cache
      subcolumns.set(this.leaves[l].path.join('.'), rows.map(cloneArrays))
    }))
    assembleNested(subcolumns, column.node, parsers)
    const assembled = subcolumns.get(column.name)
    if (!assembled) throw new Error(`could not assemble nested column ${column.name}`)
    return Array.from(assembled as ArrayLike<unknown>)
  }

  /** Rows [start, end) of a leaf column within a row group. */
  private async readLeafRows(rg: number, l: number, start: number, end: number): Promise<unknown[]> {
    const out = new Array<unknown>(end - start)
    if (end <= start) return out
    const index = await this.chunkIndex(rg, l)
    await this.ensureIndexed(rg, l, index, end)
    let i = this.groupAt(index, start)
    let row = start
    while (row < end) {
      if (i < 0 || i >= index.pages.length) throw new Error(`no page for row ${row} of ${this.leaves[l].path.join('.')}`)
      const { data, firstRow, next } = await this.pageGroup(rg, l, index, i)
      const from = row - firstRow
      if (from < 0) throw new Error(`page index out of step at row ${row} of ${this.leaves[l].path.join('.')}`)
      const count = Math.min(end - row, data.length - from)
      for (let k = 0; k < count; k++) out[row - start + k] = data[from + k]
      if (count > 0) row += count
      i = next
    }
    return out
  }

  /** Index of the clean page whose group contains row. */
  private groupAt(index: ChunkIndex, row: number): number {
    const { pages } = index
    let lo = 0
    let hi = pages.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (pages[mid].firstRow <= row) lo = mid
      else hi = mid - 1
    }
    // a group starts at a clean page; earlier pages continue rows from before
    while (lo > 0 && !pages[lo].clean) lo--
    return lo
  }

  private chunk(rg: number, l: number): ColumnChunk {
    const leaf = this.leaves[l]
    const columns = this.metadata.row_groups[rg].columns
    let chunk = columns[leaf.index]
    if (chunk?.meta_data?.path_in_schema.join('\u0000') !== leaf.key) {
      chunk = columns.find(c => c.meta_data?.path_in_schema.join('\u0000') === leaf.key) as ColumnChunk
    }
    if (!chunk?.meta_data) throw new Error(`column chunk ${leaf.path.join('.')} missing in row group ${rg}`)
    if (chunk.file_path) throw new Error('Parquet files with external column chunks are not supported')
    return chunk
  }

  private decoder(rg: number, l: number): ColumnDecoder {
    const leaf = this.leaves[l]
    const meta = this.chunk(rg, l).meta_data!
    return {
      ...meta,
      pathInSchema: meta.path_in_schema,
      type: meta.type,
      element: leaf.element,
      schemaPath: leaf.schemaPath,
      codec: meta.codec,
      parsers,
      compressors,
      utf8: leaf.utf8,
    }
  }

  private chunkIndex(rg: number, l: number): Promise<ChunkIndex> {
    const key = `${rg}:${l}`
    let index = this.chunkIndexes.get(key)
    if (!index) {
      index = this.createChunkIndex(rg, l)
      index.catch(() => this.chunkIndexes.delete(key))
      this.chunkIndexes.set(key, index)
    }
    return index
  }

  private async createChunkIndex(rg: number, l: number): Promise<ChunkIndex> {
    const chunk = this.chunk(rg, l)
    const meta = chunk.meta_data!
    const dataOffset = Number(meta.data_page_offset)
    const dictOffset = meta.dictionary_page_offset ? Number(meta.dictionary_page_offset) : undefined
    const start = dictOffset !== undefined && dictOffset < dataOffset ? dictOffset : dataOffset
    const end = start + Number(meta.total_compressed_size)
    const numRows = Number(this.metadata.row_groups[rg].num_rows)
    const leaf = this.leaves[l]
    const index: ChunkIndex = {
      start,
      end,
      numRows,
      allClean: leaf.maxRep === 0,
      pages: [],
      scanPos: start,
      rowsSeen: 0,
      complete: false,
      lock: Promise.resolve(),
    }
    if (chunk.offset_index_offset !== undefined && chunk.offset_index_length) {
      try {
        const offset = Number(chunk.offset_index_offset)
        const bytes = await this.source.read(offset, offset + chunk.offset_index_length)
        const { page_locations } = readOffsetIndex({ view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 })
        if (page_locations.length) {
          index.pages = page_locations.map((loc, i) => {
            const firstRow = Number(loc.first_row_index)
            const nextRow = i + 1 < page_locations.length ? Number(page_locations[i + 1].first_row_index) : numRows
            return { offset: Number(loc.offset), size: loc.compressed_page_size, firstRow, numRows: nextRow - firstRow, clean: true }
          })
          // pages in an offset index start at row boundaries; anything before the first page is the dictionary
          const firstPage = index.pages[0].offset
          if (start < firstPage) index.dict = { offset: start, size: firstPage - start }
          index.allClean = true
          index.complete = true
          index.rowsSeen = numRows
          return index
        }
      } catch {
        // unreadable offset index: fall back to scanning page headers
      }
    }
    return index
  }

  /** Make sure the page index covers rows up to end (exclusive), including the end of the page group holding row end-1. */
  private ensureIndexed(rg: number, l: number, index: ChunkIndex, end: number): Promise<void> {
    if (this.isIndexed(index, end)) return Promise.resolve()
    const run = index.lock.then(() => this.scanPages(rg, l, index, end))
    index.lock = run.catch(() => {})
    return run
  }

  private isIndexed(index: ChunkIndex, end: number): boolean {
    if (index.complete) return true
    if (index.allClean) return index.rowsSeen >= end
    const last = index.pages[index.pages.length - 1]
    return !!last && last.clean && last.firstRow >= end
  }

  private async scanPages(rg: number, l: number, index: ChunkIndex, end: number): Promise<void> {
    const leaf = this.leaves[l]
    let decoder: ColumnDecoder | undefined
    while (!this.isIndexed(index, end)) {
      if (index.scanPos >= index.end) {
        index.complete = true
        break
      }
      const pos = index.scanPos
      const { header, headerLength } = await this.readPageHeader(index, pos)
      const size = headerLength + header.compressed_page_size
      if (size <= 0 || pos + size > index.end) throw new Error(`corrupt page header at byte ${pos}`)
      if (header.type === 'DICTIONARY_PAGE') {
        index.dict = { offset: pos, size }
      } else if (header.type === 'DATA_PAGE' || header.type === 'DATA_PAGE_V2') {
        let numRows: number
        let clean = true
        if (header.type === 'DATA_PAGE_V2') {
          numRows = header.data_page_header_v2!.num_rows
        } else if (leaf.maxRep === 0) {
          numRows = header.data_page_header!.num_values
        } else {
          // V1 page of a repeated column: count rows from the repetition levels
          decoder ??= this.decoder(rg, l)
          const bytes = await this.source.read(pos + headerLength, pos + size)
          ;[numRows, clean] = countRows(bytes, header, leaf.maxRep, decoder)
        }
        index.pages.push({ offset: pos, size, firstRow: index.rowsSeen, numRows, clean })
        index.rowsSeen += numRows
      }
      index.scanPos = pos + size
      if (index.scanPos >= index.end) index.complete = true
    }
    index.window = undefined
    if (index.complete && index.rowsSeen !== index.numRows) {
      throw new Error(`column ${leaf.path.join('.')} has ${index.rowsSeen} rows in row group ${rg}, expected ${index.numRows}`)
    }
  }

  private async readPageHeader(index: ChunkIndex, pos: number): Promise<{ header: PageHeader; headerLength: number }> {
    let length = Math.min(HEADER_WINDOW, index.end - pos)
    for (;;) {
      let { window } = index
      if (!window || pos < window.start || pos + length > window.start + window.bytes.length) {
        window = { start: pos, bytes: await this.source.read(pos, pos + length) }
        index.window = window
      }
      const offset = pos - window.start
      const view = new DataView(window.bytes.buffer, window.bytes.byteOffset + offset, window.bytes.byteLength - offset)
      const reader = { view, offset: 0 }
      try {
        const header = parquetHeader(reader)
        return { header, headerLength: reader.offset }
      } catch (error) {
        // header larger than the window (e.g. long statistics): retry with more bytes
        if (pos + length >= index.end) throw error
        length = Math.min(length * 16, index.end - pos)
        index.window = undefined
      }
    }
  }

  /** Decoded rows of the page group starting at clean page i. */
  private async pageGroup(rg: number, l: number, index: ChunkIndex, i: number): Promise<{ data: DecodedArray; firstRow: number; next: number }> {
    const { pages } = index
    let j = i
    while (j + 1 < pages.length && !pages[j + 1].clean) j++
    const firstRow = pages[i].firstRow
    const next = j + 1
    const key = `${this.prefix}p:${rg}:${l}:${i}`
    const data = await this.cached(key, async () => {
      const dictionary = index.dict ? await this.dictionary(rg, l, index) : undefined
      const decoder = this.decoder(rg, l)
      const bytes = await this.source.read(pages[i].offset, pages[j].offset + pages[j].size)
      const reader = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 }
      let output: DecodedArray | undefined
      for (let k = i; k <= j; k++) {
        const header = parquetHeader(reader)
        if (header.type === 'DATA_PAGE' || header.type === 'DATA_PAGE_V2') {
          output = readPage(reader, header, decoder, dictionary, output, 0).data
        } else {
          reader.offset += header.compressed_page_size
        }
      }
      output ??= []
      const groupEnd = next < pages.length ? pages[next].firstRow : pages[j].firstRow + pages[j].numRows
      if (output.length !== groupEnd - firstRow) {
        throw new Error(`decoded ${output.length} rows from page at byte ${pages[i].offset}, expected ${groupEnd - firstRow}`)
      }
      return output
    })
    return { data, firstRow, next }
  }

  private dictionary(rg: number, l: number, index: ChunkIndex): Promise<DecodedArray> {
    return this.cached(`${this.prefix}d:${rg}:${l}`, async () => {
      const { offset, size } = index.dict!
      const bytes = await this.source.read(offset, offset + size)
      const reader = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 }
      const header = parquetHeader(reader)
      const decoder = this.decoder(rg, l)
      const { data } = readPage(reader, header, decoder, undefined, undefined, 0)
      if (!data) throw new Error(`could not read dictionary page at byte ${offset}`)
      return convert(data, decoder)
    })
  }

  /** Get from the cache, or compute once (concurrent callers share the computation) and cache. */
  private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit as T
    let pending = this.pending.get(key) as Promise<T> | undefined
    if (!pending) {
      pending = compute()
      this.pending.set(key, pending)
      pending.then(
        value => {
          this.pending.delete(key)
          this.cache.set(key, value, estimateSize(value))
        },
        () => this.pending.delete(key),
      )
    }
    return pending
  }

  // ---- metadata summaries for the info panels ----

  columnInfo(col: number): KeyValue[] {
    const column = this.columns[col]
    const items: KeyValue[] = [
      { key: 'Name', value: column.name },
      { key: 'Type', value: typeLabel(column.node, 10_000) },
      { key: 'Repetition', value: column.node.element.repetition_type ?? 'REQUIRED' },
    ]
    const groups = this.metadata.row_groups
    const flat = !column.node.children.length
    for (const l of column.leaves) {
      const leaf = this.leaves[l]
      const prefix = flat ? '' : `${leaf.path.slice(1).join('.')}: `
      const codecs = new Set<string>()
      const encodings = new Set<string>()
      let compressed = 0
      let uncompressed = 0
      let nullCount = 0n
      let nullsKnown = true
      let withIndex = 0
      let min: unknown
      let max: unknown
      let minMaxKnown = true
      for (let rg = 0; rg < groups.length; rg++) {
        const chunk = this.chunk(rg, l)
        const meta = chunk.meta_data!
        codecs.add(meta.codec)
        for (const e of meta.encodings) encodings.add(e)
        compressed += Number(meta.total_compressed_size)
        uncompressed += Number(meta.total_uncompressed_size)
        if (chunk.offset_index_offset !== undefined) withIndex++
        const stats = meta.statistics
        if (stats?.null_count !== undefined) nullCount += BigInt(stats.null_count)
        else nullsKnown = false
        const lo = stats?.min_value ?? stats?.min
        const hi = stats?.max_value ?? stats?.max
        if (lo === undefined || hi === undefined || lo === null || hi === null) {
          if (Number(groups[rg].num_rows) > 0 && !(stats?.null_count !== undefined && BigInt(stats.null_count) === BigInt(groups[rg].num_rows))) minMaxKnown = false
          continue
        }
        if (min === undefined || compare(lo, min) < 0) min = lo
        if (max === undefined || compare(hi, max) > 0) max = hi
      }
      const element = leaf.schemaPath[leaf.schemaPath.length - 1].element
      items.push({ key: `${prefix}Physical type`, value: element.type === 'FIXED_LEN_BYTE_ARRAY' ? `FIXED_LEN_BYTE_ARRAY(${element.type_length})` : String(element.type) })
      const logical = element.logical_type ? JSON.stringify(element.logical_type) : element.converted_type
      if (logical) items.push({ key: `${prefix}Logical type`, value: logical })
      items.push({ key: `${prefix}Compression`, value: [...codecs].join(', ') })
      items.push({ key: `${prefix}Encodings`, value: [...encodings].join(', ') })
      items.push({ key: `${prefix}Size`, value: `${formatBytes(compressed)} compressed, ${formatBytes(uncompressed)} uncompressed` })
      if (nullsKnown && groups.length) items.push({ key: `${prefix}Nulls`, value: nullCount.toLocaleString('en-US') })
      if (flat && minMaxKnown && min !== undefined) {
        const statsFormat: ValueFormat = column.format.kind === 'decimal' ? { kind: 'generic' } : column.format
        items.push({ key: 'Min', value: formatDisplay(min, statsFormat, 200) ?? 'null' })
        items.push({ key: 'Max', value: formatDisplay(max, statsFormat, 200) ?? 'null' })
      }
      items.push({ key: `${prefix}Page index`, value: `${withIndex} of ${groups.length} row groups` })
    }
    return items
  }

  fileInfo(fileName: string): InfoSection[] {
    const m = this.metadata
    let compressed = 0
    let uncompressed = 0
    const codecs = new Set<string>()
    const rowGroups: string[][] = [['#', 'Rows', 'First row', 'Compressed', 'Uncompressed']]
    m.row_groups.forEach((rg, i) => {
      let c = 0
      let u = 0
      for (const chunk of rg.columns) {
        if (!chunk.meta_data) continue
        c += Number(chunk.meta_data.total_compressed_size)
        u += Number(chunk.meta_data.total_uncompressed_size)
        codecs.add(chunk.meta_data.codec)
      }
      compressed += c
      uncompressed += u
      if (i < 2000) {
        rowGroups.push([String(i), Number(rg.num_rows).toLocaleString('en-US'), this.rowGroupStarts[i].toLocaleString('en-US'), formatBytes(c), formatBytes(u)])
      }
    })
    if (m.row_groups.length > 2000) rowGroups.push(['…', `${m.row_groups.length - 2000} more`, '', '', ''])
    const items: KeyValue[] = [
      { key: 'File', value: fileName },
      { key: 'File size', value: formatBytes(this.source.size) },
      { key: 'Rows', value: this.numRows.toLocaleString('en-US') },
      { key: 'Columns', value: `${this.columns.length.toLocaleString('en-US')} (${this.leaves.length.toLocaleString('en-US')} leaf columns)` },
      { key: 'Row groups', value: m.row_groups.length.toLocaleString('en-US') },
      { key: 'Data size', value: `${formatBytes(compressed)} compressed, ${formatBytes(uncompressed)} uncompressed` },
      { key: 'Compression', value: [...codecs].join(', ') || '-' },
      { key: 'Created by', value: m.created_by ?? '-' },
      { key: 'Format version', value: String(m.version) },
      { key: 'Footer size', value: formatBytes(m.metadata_length) },
    ]
    const keyValueMetadata = (m.key_value_metadata ?? []).map(({ key, value }) => ({
      key,
      value: value === undefined ? '' : value.length > 20000 ? value.slice(0, 20000) + '…' : value,
    }))
    const sections: InfoSection[] = [{ items }]
    if (keyValueMetadata.length) sections.push({ title: 'Key-value metadata', details: keyValueMetadata })
    sections.push({ title: 'Row groups', table: rowGroups })
    return sections
  }
}

function cloneArrays(value: unknown): unknown {
  return Array.isArray(value) ? value.map(cloneArrays) : value
}

/** Number of rows starting in a V1 data page, and whether the page starts at a row boundary. */
function countRows(compressed: Uint8Array, header: PageHeader, maxRep: number, decoder: ColumnDecoder): [number, boolean] {
  const daph = header.data_page_header!
  const page = decompressPage(compressed, Number(header.uncompressed_page_size), decoder.codec, decoder.compressors)
  const levels = new Array<number>(daph.num_values)
  if (!levels.length) return [0, false]
  readRleBitPackedHybrid({ view: new DataView(page.buffer, page.byteOffset, page.byteLength), offset: 0 }, 32 - Math.clz32(maxRep), levels)
  let rows = 0
  for (let i = 0; i < levels.length; i++) if (levels[i] === 0) rows++
  return [rows, levels[0] === 0]
}

function compare(a: unknown, b: unknown): number {
  if ((typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint')) {
    return a < b ? -1 : a > b ? 1 : 0
  }
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

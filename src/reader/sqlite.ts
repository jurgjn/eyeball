// Random access to the tables of a SQLite database, read straight from the file format
// (https://www.sqlite.org/fileformat2.html) without a SQL engine.
//
// SQL can't seek to the n-th row (OFFSET steps through all rows before it), so instead we
// list the leaf pages of a table's b-tree from its interior pages, count the cells of each
// leaf in the background, and map row positions to leaf pages with prefix sums. Committed
// pages in the write-ahead log (-wal file) take precedence over the database file.

import type { InfoSection, KeyValue, TableEntry } from '../protocol'
import { Deferred, bytesToText, formatBytes } from './format'
import { LruCache, estimateSize } from './lru'
import type { ByteSource } from './source'
import { parseCreateTable, rowidAlias, type SqlColumn, type SqlTable } from './sqlschema'
import { TableReader, type ReaderColumn, type TableFile } from './types'

export const SQLITE_MAGIC = 'SQLite format 3\u0000'
/** Bytes of a value read for the grid; longer values are cut. */
const DISPLAY_CAP = 1 << 20
/** Bytes of a value read for the detail panel and copying. */
const FULL_CAP = 64 << 20
const READ_CONCURRENCY = 64
/** Largest read when counting rows from runs of adjacent leaf pages. */
const MAX_RUN_BYTES = 8 << 20

const PAGE_INTERIOR_INDEX = 2
const PAGE_INTERIOR_TABLE = 5
const PAGE_LEAF_INDEX = 10
const PAGE_LEAF_TABLE = 13

/** A REAL value. Shown with a decimal point even when integral, as SQLite does. */
export class RealValue extends Deferred {
  constructor(readonly value: number) {
    super()
  }

  toString(): string {
    const text = String(this.value)
    return Number.isInteger(this.value) && !/e/i.test(text) ? text + '.0' : text
  }
}

/** A REAL as a plain number, or wrapped when integral (so that 1.0 doesn't show as 1). */
const real = (value: number): number | RealValue => Number.isInteger(value) ? new RealValue(value) : value

/** The start of a TEXT or BLOB value too large to read in full. */
class TruncatedValue extends Deferred {
  constructor(readonly prefix: string, readonly totalBytes: number) {
    super()
  }

  toString(): string {
    return `${this.prefix}… (${formatBytes(this.totalBytes)} in total)`
  }
}

/** Value of a VIRTUAL generated column, which SQLite computes when reading and doesn't store. */
class NotStoredValue extends Deferred {
  toString(): string {
    return '(computed, not stored)'
  }
}

const NOT_STORED = new NotStoredValue()

const u16 = (b: Uint8Array, i: number) => b[i] << 8 | b[i + 1]
const u32 = (b: Uint8Array, i: number) => (b[i] << 24 >>> 0) + (b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3])

/** Varint as a number (exact up to 2^53) and its length in bytes. */
function readVarint(b: Uint8Array, pos: number): [number, number] {
  let value = 0
  for (let i = 0; i < 8; i++) {
    const byte = b[pos + i]
    value = value * 128 + (byte & 0x7f)
    if (byte < 0x80) return [value, i + 1]
  }
  return [value * 256 + b[pos + 8], 9]
}

/** Varint as a signed 64-bit integer: a number when exact, otherwise a bigint. */
function readSignedVarint(b: Uint8Array, pos: number): [number | bigint, number] {
  const [value, length] = readVarint(b, pos)
  if (length < 9 && value <= Number.MAX_SAFE_INTEGER) return [value, length]
  let big = 0n
  for (let i = 0; i < 8; i++) {
    big = big << 7n | BigInt(b[pos + i] & 0x7f)
    if (b[pos + i] < 0x80) return [toNumber(BigInt.asIntN(64, big)), i + 1]
  }
  big = big << 8n | BigInt(b[pos + 8])
  return [toNumber(BigInt.asIntN(64, big)), 9]
}

function toNumber(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
}

function serialSize(type: number): number {
  if (type >= 12) return Math.floor((type - 12) / 2)
  return [0, 1, 2, 3, 4, 6, 8, 8, 0, 0, 0, 0][type]
}

/** Header offset of a b-tree page (page 1 starts with the 100-byte file header). */
const headerOffset = (pgno: number) => pgno === 1 ? 100 : 0

interface Wal {
  source: ByteSource
  /** Page number -> offset of its latest committed copy in the WAL file. */
  frames: Map<number, number>
  /** Database size in pages after the last commit. */
  pages: number
  frameCount: number
}

/** Read the committed frames of a write-ahead log, checking salts and checksums like SQLite does. */
async function readWal(source: ByteSource, pageSize: number): Promise<Wal | undefined> {
  if (source.size < 32) return undefined
  const header = await source.read(0, 32)
  const view = new DataView(header.buffer, header.byteOffset, 32)
  const magic = view.getUint32(0)
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return undefined
  const bigEndian = (magic & 1) === 1
  if (view.getUint32(8) !== pageSize) return undefined
  const salt1 = view.getUint32(16)
  const salt2 = view.getUint32(20)
  let [s0, s1] = walChecksum(header.subarray(0, 24), bigEndian, 0, 0)
  if (s0 !== view.getUint32(24) || s1 !== view.getUint32(28)) return undefined
  const frameSize = 24 + pageSize
  const frames = new Map<number, number>()
  const pending = new Map<number, number>()
  let pages = 0
  let frameCount = 0
  let frame = 0
  const perRead = Math.max(1, Math.floor((4 << 20) / frameSize))
  outer:
  for (let offset = 32; offset + frameSize <= source.size;) {
    const n = Math.min(perRead, Math.floor((source.size - offset) / frameSize))
    const buf = await source.read(offset, offset + n * frameSize)
    for (let k = 0; k < n; k++, frame++) {
      const at = k * frameSize
      const fv = new DataView(buf.buffer, buf.byteOffset + at, 24)
      if (fv.getUint32(8) !== salt1 || fv.getUint32(12) !== salt2) break outer
      ;[s0, s1] = walChecksum(buf.subarray(at, at + 8), bigEndian, s0, s1)
      ;[s0, s1] = walChecksum(buf.subarray(at + 24, at + frameSize), bigEndian, s0, s1)
      if (s0 !== fv.getUint32(16) || s1 !== fv.getUint32(20)) break outer
      pending.set(fv.getUint32(0), offset + at + 24)
      const commit = fv.getUint32(4)
      if (commit) {
        for (const [pgno, frameOffset] of pending) frames.set(pgno, frameOffset)
        pending.clear()
        pages = commit
        frameCount = frame + 1
      }
    }
    offset += n * frameSize
  }
  return frames.size ? { source, frames, pages, frameCount } : undefined
}

function walChecksum(bytes: Uint8Array, bigEndian: boolean, s0: number, s1: number): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < bytes.byteLength; i += 8) {
    s0 = (s0 + view.getUint32(i, !bigEndian) + s1) >>> 0
    s1 = (s1 + view.getUint32(i + 4, !bigEndian) + s0) >>> 0
  }
  return [s0, s1]
}

interface SchemaRow {
  type: string
  name: string
  tableName: string
  rootPage: number
  sql: string
}

/** How the values of a record map to the columns of a table. */
interface Layout {
  columns: SqlColumn[]
  /** Record position of each column, or -1 for columns that aren't stored. */
  recordIndex: number[]
  rowidColumn: number
}

function layoutFor(table: SqlTable): Layout {
  const stored = table.columns.map((_, i) => i).filter(i => table.columns[i].generated !== 'virtual')
  let order = stored
  if (table.withoutRowid) {
    // WITHOUT ROWID records start with the primary key columns, in key order
    const key = table.primaryKey.map(name => table.columns.findIndex(c => c.name.toLowerCase() === name.toLowerCase())).filter(i => i >= 0)
    order = [...key, ...stored.filter(i => !key.includes(i))]
  }
  const recordIndex = table.columns.map(() => -1)
  order.forEach((col, pos) => (recordIndex[col] = pos))
  return { columns: table.columns, recordIndex, rowidColumn: rowidAlias(table) }
}

export class SqliteFile implements TableFile {
  readonly format = 'sqlite'
  readonly tables: TableEntry[] = []
  defaultTable = 'sqlite_schema'
  readonly prefix: string
  pageSize = 4096
  usable = 4096
  pages = 0
  encoding = 'utf-8'
  private textDecoder = new TextDecoder()
  private header: Uint8Array = new Uint8Array(100)
  private schema: SchemaRow[] = []
  private readonly openTables = new Map<string, Promise<SqliteTable>>()
  private readonly pending = new Map<string, Promise<unknown>>()
  private static counter = 0

  private constructor(readonly source: ByteSource, readonly cache: LruCache<unknown>, private wal?: Wal) {
    this.prefix = `s${++SqliteFile.counter}:`
  }

  get size(): number {
    return this.source.size
  }

  static async open(source: ByteSource, cache: LruCache<unknown>, walSource?: ByteSource): Promise<SqliteFile> {
    const file = new SqliteFile(source, cache)
    try {
      await file.init(walSource)
    } catch (error) {
      await walSource?.close()
      throw error
    }
    return file
  }

  private async init(walSource?: ByteSource): Promise<void> {
    if (this.source.size < 512) throw new Error('not a SQLite database (file too small)')
    let header = await this.source.read(0, 100)
    if (new TextDecoder().decode(header.subarray(0, 16)) !== SQLITE_MAGIC) throw new Error('not a SQLite database')
    const rawPageSize = u16(header, 16)
    this.pageSize = rawPageSize === 1 ? 65536 : rawPageSize
    if (this.pageSize < 512 || this.pageSize > 65536 || (this.pageSize & (this.pageSize - 1))) {
      throw new Error(`unsupported SQLite page size ${this.pageSize}`)
    }
    this.usable = this.pageSize - header[20]
    // apply the write-ahead log only in WAL mode, as SQLite does
    if (walSource && header[18] === 2) this.wal = await readWal(walSource, this.pageSize)
    if (walSource && !this.wal) await walSource.close()
    if (this.wal) header = (await this.readPage(1)).slice(0, 100)
    this.header = header
    const encoding = u32(header, 56)
    this.encoding = encoding === 2 ? 'utf-16le' : encoding === 3 ? 'utf-16be' : 'utf-8'
    this.textDecoder = new TextDecoder(this.encoding)
    const headerPages = u32(header, 28)
    const validFor = u32(header, 92) === u32(header, 24)
    this.pages = this.wal?.pages || (headerPages && validFor ? headerPages : Math.floor(this.source.size / this.pageSize))
    await this.readSchema()
  }

  private async readSchema(): Promise<void> {
    const columns = ['type', 'name', 'tbl_name', 'rootpage', 'sql']
    const layout = layoutFor({
      name: 'sqlite_schema',
      columns: columns.map(name => ({ name, type: '', affinity: 'BLOB', notNull: false, pkDesc: false })),
      primaryKey: [],
      withoutRowid: false,
      strict: false,
    })
    const units = await this.enumerate(1)
    for (let u = 0; u < units.pages.length; u++) {
      for (const row of await this.decodeLeaf(units.pages[u], layout, FULL_CAP)) {
        this.schema.push({
          type: String(row[0] ?? ''),
          name: String(row[1] ?? ''),
          tableName: String(row[2] ?? ''),
          rootPage: Number(row[3] ?? 0),
          sql: String(row[4] ?? ''),
        })
      }
    }
    const byName = (a: TableEntry, b: TableEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    const user: TableEntry[] = []
    const internal: TableEntry[] = []
    const other: TableEntry[] = []
    for (const row of this.schema) {
      if (row.type === 'table' && row.rootPage > 0) {
        ;(row.name.startsWith('sqlite_') ? internal : user).push({ name: row.name, kind: 'table', supported: true })
      } else if (row.type === 'table') {
        other.push({
          name: row.name,
          kind: 'virtual table',
          supported: false,
          note: 'Virtual tables are computed by SQLite modules (e.g. FTS) and can\'t be read directly. Their data is in the tables named after them.',
        })
      } else if (row.type === 'view') {
        other.push({ name: row.name, kind: 'view', supported: false, note: 'Views are stored queries; Eyeball reads tables directly and has no SQL engine.' })
      }
    }
    internal.push({ name: 'sqlite_schema', kind: 'table', supported: true })
    this.tables.push(...user.sort(byName), ...internal.sort(byName), ...other.sort(byName))
    this.defaultTable = user[0]?.name ?? 'sqlite_schema'
  }

  openTable(name: string): Promise<SqliteTable> {
    let table = this.openTables.get(name)
    if (!table) {
      table = this.createTable(name)
      table.catch(() => this.openTables.delete(name))
      this.openTables.set(name, table)
    }
    return table
  }

  private async createTable(name: string): Promise<SqliteTable> {
    const entry = this.tables.find(t => t.name === name)
    if (!entry) throw new Error(`no table ${name}`)
    if (!entry.supported) throw new Error(`${entry.name} is a ${entry.kind}: ${entry.note ?? 'not supported'}`)
    let sqlTable: SqlTable
    let root: number
    let sql = ''
    if (name === 'sqlite_schema') {
      root = 1
      sqlTable = {
        name,
        columns: [['type', 'TEXT'], ['name', 'TEXT'], ['tbl_name', 'TEXT'], ['rootpage', 'INT'], ['sql', 'TEXT']].map(([n, t]) => ({
          name: n, type: t, affinity: t === 'INT' ? 'INTEGER' : 'TEXT', notNull: false, pkDesc: false,
        })),
        primaryKey: [],
        withoutRowid: false,
        strict: false,
      }
    } else {
      const row = this.schema.find(r => r.type === 'table' && r.name === name)!
      root = row.rootPage
      sql = row.sql
      try {
        sqlTable = parseCreateTable(sql)
      } catch {
        sqlTable = { name, columns: [], primaryKey: [], withoutRowid: /without\s+rowid/i.test(sql), strict: false }
      }
    }
    const table = new SqliteTable(this, name, root, sqlTable, sql)
    await table.start()
    return table
  }

  // ---- pages ----

  async readPage(pgno: number): Promise<Uint8Array> {
    if (pgno < 1 || (this.pages && pgno > this.pages)) throw new Error(`page ${pgno} is outside the database (${this.pages} pages)`)
    const walOffset = this.wal?.frames.get(pgno)
    if (walOffset !== undefined) return this.wal!.source.read(walOffset, walOffset + this.pageSize)
    const start = (pgno - 1) * this.pageSize
    if (start + this.pageSize > this.source.size) {
      throw new Error(`page ${pgno} is beyond the end of the file; the database may be truncated`)
    }
    return this.source.read(start, start + this.pageSize)
  }

  async readPages(pgnos: number[]): Promise<Uint8Array[]> {
    const out: Uint8Array[] = new Array(pgnos.length)
    for (let i = 0; i < pgnos.length; i += READ_CONCURRENCY) {
      const chunk = pgnos.slice(i, i + READ_CONCURRENCY)
      const pages = await Promise.all(chunk.map(p => this.readPage(p)))
      pages.forEach((page, k) => (out[i + k] = page))
    }
    return out
  }

  /** Number of cells in each of the given leaf pages, reading runs of adjacent pages at once. */
  async leafCellCounts(pgnos: number[]): Promise<Map<number, number>> {
    const counts = new Map<number, number>()
    const check = (page: Uint8Array, at: number, pgno: number) => {
      const type = page[at]
      if (type !== PAGE_LEAF_TABLE && type !== PAGE_LEAF_INDEX) throw new Error(`page ${pgno} is not a b-tree leaf (type ${type})`)
      counts.set(pgno, u16(page, at + 3))
    }
    const fromFile: number[] = []
    const fromWal: number[] = []
    for (const pgno of pgnos) (this.wal?.frames.has(pgno) ? fromWal : fromFile).push(pgno)
    const walPages = await this.readPages(fromWal)
    walPages.forEach((page, i) => check(page, headerOffset(fromWal[i]), fromWal[i]))
    // group pages that are close together in the file into single reads
    const sorted = [...new Set(fromFile)].sort((a, b) => a - b)
    const runs: number[][] = []
    const maxPages = Math.max(1, Math.floor(MAX_RUN_BYTES / this.pageSize))
    for (const pgno of sorted) {
      const run = runs[runs.length - 1]
      if (run && pgno - run[run.length - 1] <= 4 && pgno - run[0] < maxPages) run.push(pgno)
      else runs.push([pgno])
    }
    for (let i = 0; i < runs.length; i += 16) {
      await Promise.all(runs.slice(i, i + 16).map(async run => {
        const first = run[0]
        const bytes = await this.source.read((first - 1) * this.pageSize, run[run.length - 1] * this.pageSize)
        for (const pgno of run) check(bytes, (pgno - first) * this.pageSize + headerOffset(pgno), pgno)
      }))
    }
    return counts
  }

  /**
   * The b-tree under root in order: leaf pages (cell -1) and, for index b-trees
   * (WITHOUT ROWID tables), the entries of interior pages (cell >= 0) between them.
   */
  async enumerate(root: number): Promise<{ pages: Int32Array; cells: Int32Array; depth: number }> {
    const SUBTREE = -2
    let pages = [root]
    let cells = [SUBTREE]
    let depth = 1
    for (;;) {
      const subtrees: number[] = []
      for (let i = 0; i < pages.length; i++) if (cells[i] === SUBTREE) subtrees.push(pages[i])
      if (!subtrees.length) break
      // all leaves of a SQLite b-tree are at the same depth
      const first = await this.readPage(subtrees[0])
      const firstType = first[headerOffset(subtrees[0])]
      if (firstType === PAGE_LEAF_TABLE || firstType === PAGE_LEAF_INDEX) {
        cells = cells.map(c => c === SUBTREE ? -1 : c)
        break
      }
      const read = await this.readPages(subtrees)
      const nextPages: number[] = []
      const nextCells: number[] = []
      let k = 0
      for (let i = 0; i < pages.length; i++) {
        if (cells[i] !== SUBTREE) {
          nextPages.push(pages[i])
          nextCells.push(cells[i])
          continue
        }
        const pgno = pages[i]
        const page = read[k++]
        const h = headerOffset(pgno)
        const type = page[h]
        if (type !== PAGE_INTERIOR_TABLE && type !== PAGE_INTERIOR_INDEX) {
          throw new Error(`page ${pgno} should be an interior b-tree page (type ${type})`)
        }
        const n = u16(page, h + 3)
        for (let c = 0; c < n; c++) {
          nextPages.push(u32(page, u16(page, h + 12 + 2 * c)))
          nextCells.push(SUBTREE)
          if (type === PAGE_INTERIOR_INDEX) {
            nextPages.push(pgno)
            nextCells.push(c)
          }
        }
        nextPages.push(u32(page, h + 8))
        nextCells.push(SUBTREE)
      }
      pages = nextPages
      cells = nextCells
      // SQLite never builds b-trees deeper than 20 levels; deeper means a corrupt (cyclic) tree
      if (++depth > 20) throw new Error(`b-tree at page ${root} is too deep; the database may be corrupt`)
    }
    return { pages: Int32Array.from(pages), cells: Int32Array.from(cells), depth }
  }

  // ---- cells and records ----

  /** Rows of cells [from, to) of a leaf page (all cells by default). */
  async decodeLeaf(pgno: number, layout: Layout, cap: number, from = 0, to = Infinity): Promise<unknown[][]> {
    const page = await this.readPage(pgno)
    const h = headerOffset(pgno)
    const type = page[h]
    if (type !== PAGE_LEAF_TABLE && type !== PAGE_LEAF_INDEX) throw new Error(`page ${pgno} is not a b-tree leaf (type ${type})`)
    const n = Math.min(u16(page, h + 3), to)
    // cells are decoded concurrently, so that the overflow chains of large rows are read in parallel
    const cells: Promise<unknown[]>[] = []
    for (let c = from; c < n; c++) cells.push(this.decodeCell(page, u16(page, h + 8 + 2 * c), type, layout, cap))
    return Promise.all(cells)
  }

  /** The entry stored in cell c of an interior index page (WITHOUT ROWID tables). */
  async decodeInteriorEntry(pgno: number, cell: number, layout: Layout, cap: number): Promise<unknown[]> {
    const page = await this.readPage(pgno)
    const h = headerOffset(pgno)
    return this.decodeCell(page, u16(page, h + 12 + 2 * cell), page[h], layout, cap)
  }

  private async decodeCell(page: Uint8Array, pos: number, type: number, layout: Layout, cap: number): Promise<unknown[]> {
    if (type === PAGE_INTERIOR_INDEX) pos += 4 // left child pointer
    const [payloadSize, n] = readVarint(page, pos)
    pos += n
    let rowid: number | bigint | undefined
    if (type === PAGE_LEAF_TABLE) {
      const [value, m] = readSignedVarint(page, pos)
      rowid = value
      pos += m
    }
    const local = this.localPayload(payloadSize, type === PAGE_LEAF_TABLE)
    const payload = local >= payloadSize
      ? page.subarray(pos, pos + payloadSize)
      : await this.readOverflow(page.subarray(pos, pos + local), u32(page, pos + local), payloadSize, cap)
    return this.decodeRecord(payload, layout, rowid)
  }

  /** Bytes of a payload stored on the b-tree page itself (https://www.sqlite.org/fileformat2.html#b_tree_pages). */
  private localPayload(size: number, tableLeaf: boolean): number {
    const u = this.usable
    const x = tableLeaf ? u - 35 : Math.floor((u - 12) * 64 / 255) - 23
    if (size <= x) return size
    const m = Math.floor((u - 12) * 32 / 255) - 23
    const k = m + ((size - m) % (u - 4))
    return k <= x ? k : m
  }

  /** A payload continued in overflow pages, read up to cap bytes. */
  private async readOverflow(local: Uint8Array, first: number, size: number, cap: number): Promise<Uint8Array> {
    const want = Math.min(size, Math.max(cap, local.length))
    const out = new Uint8Array(want)
    out.set(local.subarray(0, want))
    let filled = Math.min(local.length, want)
    let pgno = first
    let guard = 0
    while (filled < want && pgno) {
      if (++guard > this.pages + 1) throw new Error('overflow chain loops')
      const page = await this.readPage(pgno)
      const chunk = page.subarray(4, this.usable)
      const take = Math.min(chunk.length, want - filled)
      out.set(chunk.subarray(0, take), filled)
      filled += take
      pgno = u32(page, 0)
    }
    return filled === want ? out : out.subarray(0, filled)
  }

  private decodeRecord(payload: Uint8Array, layout: Layout, rowid: number | bigint | undefined): unknown[] {
    const [headerSize, n] = readVarint(payload, 0)
    const types: number[] = []
    for (let p = n; p < headerSize && p < payload.length;) {
      const [type, m] = readVarint(payload, p)
      types.push(type)
      p += m
    }
    const values: unknown[] = new Array(types.length)
    let body = headerSize
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    for (let i = 0; i < types.length; i++) {
      const type = types[i]
      const size = serialSize(type)
      if (body + size > payload.length) {
        values[i] = this.truncated(payload.subarray(Math.min(body, payload.length)), type, size)
      } else {
        values[i] = this.decodeValue(payload, view, body, type, size)
      }
      body += size
    }
    const { columns, recordIndex, rowidColumn } = layout
    if (!columns.length) return values
    const row: unknown[] = new Array(columns.length)
    for (let c = 0; c < columns.length; c++) {
      const index = recordIndex[c]
      let value: unknown
      if (c === rowidColumn) value = rowid
      else if (index < 0) value = NOT_STORED
      else if (index < values.length) value = values[index]
      else value = columns[c].defaultValue ?? null // added by ALTER TABLE after this row was written
      // SQLite stores integral REAL values as integers and converts them back when reading
      if (columns[c].affinity === 'REAL' && (typeof value === 'number' || typeof value === 'bigint')) value = real(Number(value))
      row[c] = value
    }
    return row
  }

  private decodeValue(b: Uint8Array, view: DataView, at: number, type: number, size: number): unknown {
    switch (type) {
      case 0: return null
      case 1: return view.getInt8(at)
      case 2: return view.getInt16(at)
      case 3: return (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8) >> 8
      case 4: return view.getInt32(at)
      case 5: return view.getInt16(at) * 4294967296 + view.getUint32(at + 2)
      case 6: return toNumber(view.getBigInt64(at))
      case 7: return real(view.getFloat64(at))
      case 8: return 0
      case 9: return 1
      case 10:
      case 11: return null
    }
    const bytes = b.subarray(at, at + size)
    return type % 2 === 0 ? bytes.slice() : this.textDecoder.decode(bytes)
  }

  private truncated(available: Uint8Array, type: number, size: number): unknown {
    if (type < 12) return null
    const prefix = available.subarray(0, 4096)
    return new TruncatedValue(type % 2 === 0 ? bytesToText(prefix, 2000) : this.textDecoder.decode(prefix), size)
  }

  /** Get from the cache, or compute once (concurrent callers share the computation) and cache. */
  async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
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

  fileInfo(fileName: string): InfoSection[] {
    const h = this.header
    const version = u32(h, 96)
    const items: KeyValue[] = [
      { key: 'File', value: fileName },
      { key: 'File size', value: formatBytes(this.source.size) },
      { key: 'Page size', value: `${this.pageSize.toLocaleString('en-US')} bytes${h[20] ? ` (${h[20]} reserved)` : ''}` },
      { key: 'Pages', value: this.pages.toLocaleString('en-US') },
      { key: 'Text encoding', value: this.encoding.toUpperCase() },
      { key: 'Journal mode', value: h[18] === 2 ? 'WAL' : 'rollback journal' },
      {
        key: 'Write-ahead log',
        value: this.wal ? `${this.wal.frameCount.toLocaleString('en-US')} committed frames applied (${this.wal.frames.size.toLocaleString('en-US')} pages)` : 'none',
      },
      { key: 'Free pages', value: u32(h, 36).toLocaleString('en-US') },
      { key: 'Auto-vacuum', value: u32(h, 52) ? (u32(h, 64) ? 'incremental' : 'full') : 'off' },
      { key: 'Written by', value: version ? `SQLite ${Math.floor(version / 1e6)}.${Math.floor(version / 1e3) % 1000}.${version % 1000}` : '-' },
      { key: 'Schema format', value: String(u32(h, 44)) },
      { key: 'User version', value: String(u32(h, 60) | 0) },
      { key: 'Application ID', value: `0x${u32(h, 68).toString(16).padStart(8, '0')}` },
    ]
    const rows = [['Type', 'Name', 'Table', 'Root page']]
    for (const row of this.schema) rows.push([row.type, row.name, row.tableName, row.rootPage ? String(row.rootPage) : ''])
    return [
      { items },
      { title: 'Schema', table: rows },
      { title: 'SQL', details: this.schema.filter(r => r.sql).map(r => ({ key: `${r.type} ${r.name}`, value: r.sql })) },
    ]
  }

  dispose(): void {
    for (const table of this.openTables.values()) table.then(t => t.dispose(), () => {})
    this.openTables.clear()
    this.cache.deletePrefix(this.prefix)
    this.source.close().catch(() => {})
    this.wal?.source.close().catch(() => {})
  }
}

/** One table (or WITHOUT ROWID table) of a database. */
export class SqliteTable extends TableReader {
  columns: ReaderColumn[] = []
  numRows = 0
  private layout: Layout
  private unitPages: Int32Array = new Int32Array(0)
  private unitCells: Int32Array = new Int32Array(0)
  /** prefix[u] = rows before unit u, known for u <= countedUnits. */
  private prefix = new Float64Array(1)
  private countedUnits = 0
  private depth = 0
  private leafPages = 0
  private disposed = false
  private countError?: string
  private waiters: { rows: number; resolve: () => void; reject: (error: Error) => void }[] = []

  constructor(
    private readonly file: SqliteFile,
    readonly name: string,
    private readonly root: number,
    private readonly sqlTable: SqlTable,
    private readonly sql: string,
  ) {
    super()
    this.layout = layoutFor(sqlTable)
  }

  /** List the b-tree's pages and count the first rows; the rest are counted in the background. */
  async start(): Promise<void> {
    const units = await this.file.enumerate(this.root)
    this.unitPages = units.pages
    this.unitCells = units.cells
    this.depth = units.depth
    this.leafPages = units.cells.filter(c => c === -1).length
    this.prefix = new Float64Array(units.pages.length + 1)
    if (!this.sqlTable.columns.length) await this.guessColumns()
    this.columns = this.layout.columns.map((c, i) => ({
      name: c.name,
      meta: {
        name: c.name,
        type: (c.type ? c.type.toLowerCase() : 'any') + (this.isKey(i) ? ' · key' : ''),
        numeric: c.affinity === 'INTEGER' || c.affinity === 'REAL' || c.affinity === 'NUMERIC',
      },
      format: { kind: 'generic' },
    }))
    this.counting = true
    const first = this.count()
    // wait for the first batch, so the table opens with its first rows counted
    await Promise.race([first, new Promise<void>(resolve => this.onRowCount(resolve))])
  }

  /** CREATE TABLE ... AS SELECT and unparseable schemas: name columns after the first row's values. */
  private async guessColumns(): Promise<void> {
    const leaf = this.unitCells.indexOf(-1)
    const rows = leaf >= 0 ? await this.file.decodeLeaf(this.unitPages[leaf], this.layout, DISPLAY_CAP, 0, 1) : []
    const n = rows[0]?.length ?? 0
    this.sqlTable.columns = Array.from({ length: n }, (_, i) => ({ name: `column${i + 1}`, type: '', affinity: 'BLOB' as const, notNull: false, pkDesc: false }))
    this.layout = layoutFor(this.sqlTable)
  }

  private isKey(col: number): boolean {
    const name = this.layout.columns[col].name.toLowerCase()
    return this.sqlTable.primaryKey.some(k => k.toLowerCase() === name)
  }

  private async count(): Promise<void> {
    const n = this.unitPages.length
    let batch = 32
    let lastNotified = 0
    try {
      while (this.countedUnits < n && !this.disposed) {
        const leaves: number[] = []
        let end = this.countedUnits
        while (end < n && leaves.length < batch) {
          if (this.unitCells[end] === -1) leaves.push(this.unitPages[end])
          end++
        }
        const counts = await this.file.leafCellCounts(leaves)
        for (let u = this.countedUnits; u < end; u++) {
          this.prefix[u + 1] = this.prefix[u] + (this.unitCells[u] === -1 ? counts.get(this.unitPages[u])! : 1)
        }
        this.countedUnits = end
        this.numRows = this.prefix[end]
        this.wake()
        const now = Date.now()
        if (now - lastNotified > 200 || end === n) {
          lastNotified = now
          if (end < n) this.rowCountChanged()
        }
        batch = Math.min(batch * 2, 4096)
      }
    } catch (error) {
      this.countError = error instanceof Error ? error.message : String(error)
    }
    this.counting = false
    this.wake()
    this.rowCountChanged()
  }

  private wake(): void {
    this.waiters = this.waiters.filter(w => {
      if (w.rows <= this.numRows) w.resolve()
      else if (!this.counting) w.reject(new Error(this.countError ?? `row ${w.rows - 1} is beyond the end of the table`))
      else return true
      return false
    })
  }

  private waitForRows(rows: number): Promise<void> {
    if (rows <= this.numRows) return Promise.resolve()
    if (!this.counting) return Promise.reject(new Error(this.countError ?? `row ${rows - 1} is beyond the end of the table`))
    return new Promise((resolve, reject) => this.waiters.push({ rows, resolve, reject }))
  }

  /** Unit holding row (row < numRows). */
  private unitAt(row: number): number {
    let lo = 0
    let hi = this.countedUnits - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.prefix[mid + 1] > row) hi = mid
      else lo = mid + 1
    }
    return lo
  }

  async readRows(start: number, end: number, full = false): Promise<unknown[][]> {
    if (end <= start) return []
    await this.waitForRows(end)
    // the units (leaf pages) holding the rows, read concurrently
    const parts: Promise<unknown[][]>[] = []
    let u = this.unitAt(start)
    let offset = start - this.prefix[u]
    for (let remaining = end - start; remaining > 0; u++, offset = 0) {
      const take = Math.min(this.prefix[u + 1] - this.prefix[u] - offset, remaining)
      if (take > 0) {
        parts.push(this.unitRows(u, offset, offset + take, full))
        remaining -= take
      }
    }
    return (await Promise.all(parts)).flat()
  }

  private async unitRows(u: number, from: number, to: number, full: boolean): Promise<unknown[][]> {
    const pgno = this.unitPages[u]
    const cell = this.unitCells[u]
    const cap = full ? FULL_CAP : DISPLAY_CAP
    if (cell >= 0) return [await this.file.decodeInteriorEntry(pgno, cell, this.layout, cap)]
    if (full) return this.file.decodeLeaf(pgno, this.layout, cap, from, to)
    const rows = await this.file.cached(`${this.file.prefix}${pgno}`, () => this.file.decodeLeaf(pgno, this.layout, cap))
    return rows.slice(from, to)
  }

  async readColumn(col: number, start: number, end: number, full = false): Promise<unknown[]> {
    const rows = await this.readRows(start, Math.min(end, Math.max(this.numRows, start)), full)
    return rows.map(row => row[col])
  }

  columnInfo(col: number): KeyValue[] {
    const c = this.layout.columns[col]
    const key = this.sqlTable.primaryKey.findIndex(k => k.toLowerCase() === c.name.toLowerCase())
    let primaryKey = 'no'
    if (col === this.layout.rowidColumn) primaryKey = 'yes, alias for the rowid'
    else if (key >= 0) primaryKey = this.sqlTable.primaryKey.length > 1 ? `yes, column ${key + 1} of ${this.sqlTable.primaryKey.length}` : 'yes'
    const items: KeyValue[] = [
      { key: 'Name', value: c.name },
      { key: 'Declared type', value: c.type || '(none)' },
      { key: 'Affinity', value: c.affinity },
      { key: 'Primary key', value: primaryKey },
      { key: 'Not null', value: c.notNull ? 'yes' : 'no' },
    ]
    if (c.defaultText !== undefined) items.push({ key: 'Default', value: c.defaultText })
    if (c.collate) items.push({ key: 'Collation', value: c.collate })
    if (c.generated) items.push({ key: 'Generated', value: c.generated === 'virtual' ? 'virtual (computed by SQLite, not stored in the file)' : 'stored' })
    const kind = [this.sqlTable.withoutRowid ? 'WITHOUT ROWID table' : 'table', this.sqlTable.strict ? 'STRICT' : ''].filter(Boolean).join(', ')
    items.push(
      { key: 'Table', value: `${this.name} (${kind})` },
      { key: 'Rows', value: `${this.numRows.toLocaleString('en-US')}${this.counting ? '+ (counting)' : ''}` },
      { key: 'B-tree', value: `root page ${this.root}, depth ${this.depth}, ${this.leafPages.toLocaleString('en-US')} leaf pages` },
    )
    if (this.countError) items.push({ key: 'Error', value: this.countError })
    return items
  }

  get schemaSql(): string {
    return this.sql
  }

  override dispose(): void {
    this.disposed = true
    super.dispose()
  }
}

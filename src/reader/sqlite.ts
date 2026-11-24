// Random access to the tables of a SQLite database, read straight from the file format
// (https://www.sqlite.org/fileformat2.html) without a SQL engine.
//
// SQL can't seek to the n-th row (OFFSET steps through all rows before it), so instead we
// list the leaf pages of a table's b-tree from its interior pages, count the cells of each
// leaf in the background, and map row positions to leaf pages with prefix sums. If an index
// of the table is much smaller than the table, its entries are counted instead: when there
// are as many rows as the span of the rowids, the rowids have no gaps, and row n is found
// directly as rowid min + n. Committed pages in the write-ahead log (-wal file) take
// precedence over the database file.

import type { InfoSection, KeyValue, TableEntry } from '../protocol'
import { Deferred, bytesToText, formatBytes } from './format'
import { LruCache, estimateSize } from './lru'
import type { ByteSource } from './source'
import { parseCreateTable, rowidAlias, type SqlColumn, type SqlTable } from './sqlschema'
import { TableReader, type ReaderColumn, type TableFile } from './types'

export const SQLITE_MAGIC = 'SQLite format 3\u0000'
/** Bytes of each value read for the grid; longer values are cut (and shown with their size). */
const DISPLAY_PREFIX = 1024
/** Bytes of a record read for the grid when its header doesn't fit on the b-tree page. */
const DISPLAY_CAP = 1 << 20
/** Bytes of a value read for the detail panel and copying. */
const FULL_CAP = 64 << 20
/** Largest read when counting rows from runs of adjacent leaf pages. */
const MAX_RUN_BYTES = 8 << 20
/** Units (leaf pages) counted at once, at most. */
const MAX_BATCH = 1024
/** Count with an index only for tables with at least this many leaf pages... */
const INDEX_MIN_LEAVES = 2048
/** ...and only if the index has at most this fraction of them. */
const INDEX_MAX_RATIO = 0.25

const PAGE_INTERIOR_INDEX = 2
const PAGE_INTERIOR_TABLE = 5
const PAGE_LEAF_INDEX = 10
const PAGE_LEAF_TABLE = 13

/** Unit kinds in a b-tree walk; cells >= 0 are entries of interior index pages. */
const LEAF = -1
const SUBTREE = -2

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

/**
 * Bytes of a record to read for the grid: all of its values, each cut after DISPLAY_PREFIX
 * bytes. Without overflow pages for the rest of large values, a screenful of a table with
 * large blobs is read in a fraction of the time.
 */
function displayBytes(local: Uint8Array, payloadSize: number): number {
  const [headerSize, n] = readVarint(local, 0)
  // a header that doesn't fit on the page (thousands of columns): read most of the record
  if (headerSize > local.length) return Math.min(payloadSize, DISPLAY_CAP)
  let body = headerSize
  let want = headerSize
  for (let p = n; p < headerSize;) {
    const [type, m] = readVarint(local, p)
    p += m
    const size = serialSize(type)
    want = Math.max(want, body + Math.min(size, DISPLAY_PREFIX))
    body += size
  }
  return Math.min(payloadSize, want)
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

/**
 * A b-tree down to the level above its leaves (the bottom interior level), whose pages are
 * read as the walk over the leaves gets to them.
 */
interface Spine {
  depth: number
  /**
   * The bottom interior level in order: its pages (cell SUBTREE), and for index b-trees the
   * entries of the interior pages above, in between (cell >= 0). For a b-tree of depth 1, the
   * root leaf (cell LEAF).
   */
  pages: number[]
  cells: number[]
  /** Pages in the bottom interior level. */
  subtrees: number
  /** Children of its first page; with subtrees, an estimate of the number of leaf pages. */
  fanout: number
}

/** Consecutive units of a b-tree: leaf pages (cell LEAF) and entries of interior index pages (cell >= 0). */
interface Units {
  pages: number[]
  cells: number[]
  /** Fraction of the b-tree walked once these units are counted. */
  progress: number
}

interface CountedUnits extends Units {
  /** Rows in each unit: the cells of a leaf page, or 1 for an interior entry. */
  counts: number[]
}

/** A leaf page of a table b-tree, with the bounds (low, high] of its rowids from the interior pages. */
interface RowidLeaf {
  pgno: number
  low: number
  high: number
}

/** An interior page of a table b-tree: child pages, and the largest rowid in each but the last. */
interface Interior {
  children: number[]
  keys: number[]
}

const estimatedLeaves = (spine: Spine) => spine.subtrees * spine.fanout || 1

/** Bytes up to the end of the last complete UTF-8 character. */
function completeUtf8(bytes: Uint8Array): Uint8Array {
  let lead = bytes.length - 1
  while (lead > 0 && bytes.length - lead < 4 && (bytes[lead] & 0xc0) === 0x80) lead--
  const byte = bytes[lead]
  const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
  return lead >= 0 && bytes.length - lead < length ? bytes.subarray(0, lead) : bytes
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
    const leaves = await this.listLeaves(1)
    for (const rows of await Promise.all(leaves.map(pgno => this.decodeLeaf(pgno, layout, true)))) {
      for (const row of rows) {
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

  /**
   * A page of the database. Pages read for the screen are cached (records are read again for
   * each column when copying, and the cells of a row for the detail panel); pages read in the
   * background, for counting rows, are not, so that they don't push out the rows on screen.
   */
  readPage(pgno: number, background = false): Promise<Uint8Array> {
    if (background) return this.loadPage(pgno, true)
    return this.cached(`${this.prefix}p${pgno}`, () => this.loadPage(pgno, false))
  }

  private async loadPage(pgno: number, background: boolean): Promise<Uint8Array> {
    if (pgno < 1 || (this.pages && pgno > this.pages)) throw new Error(`page ${pgno} is outside the database (${this.pages} pages)`)
    const walOffset = this.wal?.frames.get(pgno)
    if (walOffset !== undefined) return this.wal!.source.read(walOffset, walOffset + this.pageSize, background)
    const start = (pgno - 1) * this.pageSize
    if (start + this.pageSize > this.source.size) {
      throw new Error(`page ${pgno} is beyond the end of the file; the database may be truncated`)
    }
    return this.source.read(start, start + this.pageSize, background)
  }

  readPages(pgnos: number[], background = false): Promise<Uint8Array[]> {
    // the byte source limits how many reads run at once
    return Promise.all(pgnos.map(pgno => this.readPage(pgno, background)))
  }

  /** Number of cells in each of the given leaf pages, reading runs of adjacent pages at once. */
  async leafCellCounts(pgnos: number[], background = false): Promise<Map<number, number>> {
    const counts = new Map<number, number>()
    const check = (page: Uint8Array, at: number, pgno: number) => {
      const type = page[at]
      if (type !== PAGE_LEAF_TABLE && type !== PAGE_LEAF_INDEX) throw new Error(`page ${pgno} is not a b-tree leaf (type ${type})`)
      counts.set(pgno, u16(page, at + 3))
    }
    const fromFile: number[] = []
    const fromWal: number[] = []
    for (const pgno of pgnos) (this.wal?.frames.has(pgno) ? fromWal : fromFile).push(pgno)
    // group pages that are close together in the file into single reads
    const sorted = [...new Set(fromFile)].sort((a, b) => a - b)
    const runs: number[][] = []
    const maxPages = Math.max(1, Math.floor(MAX_RUN_BYTES / this.pageSize))
    for (const pgno of sorted) {
      const run = runs[runs.length - 1]
      if (run && pgno - run[run.length - 1] <= 4 && pgno - run[0] < maxPages) run.push(pgno)
      else runs.push([pgno])
    }
    await Promise.all([
      ...fromWal.map(async pgno => check(await this.readPage(pgno, background), headerOffset(pgno), pgno)),
      ...runs.map(async run => {
        const first = run[0]
        const bytes = await this.source.read((first - 1) * this.pageSize, run[run.length - 1] * this.pageSize, background)
        for (const pgno of run) check(bytes, (pgno - first) * this.pageSize + headerOffset(pgno), pgno)
      }),
    ])
    return counts
  }

  // ---- b-trees ----

  /** Children of an interior page in order, with the entries between them for index b-trees. */
  private expandInterior(pgno: number, page: Uint8Array, childCell: number, pages: number[], cells: number[]): void {
    const h = headerOffset(pgno)
    const type = page[h]
    if (type !== PAGE_INTERIOR_TABLE && type !== PAGE_INTERIOR_INDEX) {
      throw new Error(`page ${pgno} should be an interior b-tree page (type ${type})`)
    }
    const n = u16(page, h + 3)
    for (let c = 0; c < n; c++) {
      pages.push(u32(page, u16(page, h + 12 + 2 * c)))
      cells.push(childCell)
      if (type === PAGE_INTERIOR_INDEX) {
        pages.push(pgno)
        cells.push(c)
      }
    }
    pages.push(u32(page, h + 8))
    cells.push(childCell)
  }

  /** The b-tree under root down to its bottom interior level. */
  async spine(root: number, background = false): Promise<Spine> {
    // all leaves of a SQLite b-tree are at the same depth: follow the first children down
    let depth = 1
    let fanout = 1
    for (let pgno = root; ; depth++) {
      // SQLite never builds b-trees deeper than 20 levels; deeper means a corrupt (cyclic) tree
      if (depth > 20) throw new Error(`b-tree at page ${root} is too deep; the database may be corrupt`)
      const page = await this.readPage(pgno, background)
      const h = headerOffset(pgno)
      const type = page[h]
      if (type === PAGE_LEAF_TABLE || type === PAGE_LEAF_INDEX) break
      if (type !== PAGE_INTERIOR_TABLE && type !== PAGE_INTERIOR_INDEX) {
        throw new Error(`page ${pgno} should be a b-tree page (type ${type})`)
      }
      const n = u16(page, h + 3)
      fanout = n + 1
      pgno = n ? u32(page, u16(page, h + 12)) : u32(page, h + 8)
    }
    let pages = [root]
    let cells = [depth === 1 ? LEAF : SUBTREE]
    for (let level = 1; level < depth - 1; level++) {
      const subtrees = pages.filter((_, i) => cells[i] === SUBTREE)
      const read = await this.readPages(subtrees, background)
      const nextPages: number[] = []
      const nextCells: number[] = []
      let k = 0
      for (let i = 0; i < pages.length; i++) {
        if (cells[i] === SUBTREE) {
          this.expandInterior(pages[i], read[k++], SUBTREE, nextPages, nextCells)
        } else {
          nextPages.push(pages[i])
          nextCells.push(cells[i])
        }
      }
      pages = nextPages
      cells = nextCells
    }
    return { depth, pages, cells, subtrees: depth === 1 ? 0 : cells.filter(c => c === SUBTREE).length, fanout }
  }

  /** All leaf pages of a table b-tree, in order. */
  private async listLeaves(root: number): Promise<number[]> {
    const spine = await this.spine(root)
    if (spine.depth === 1) return spine.pages
    const read = await this.readPages(spine.pages)
    const pages: number[] = []
    spine.pages.forEach((pgno, i) => this.expandInterior(pgno, read[i], LEAF, pages, []))
    return pages
  }

  /**
   * Units of a b-tree in order, in batches that grow from a few pages (so that the first rows
   * are counted quickly) to MAX_BATCH. The pages of the bottom interior level are read a few
   * ahead of the batches.
   */
  private async *units(spine: Spine): AsyncGenerator<Units> {
    if (spine.depth === 1) {
      yield { pages: spine.pages, cells: spine.cells, progress: 1 }
      return
    }
    const total = spine.pages.length
    // about MAX_BATCH leaf pages per chunk of the bottom interior level
    const perChunk = Math.max(1, Math.ceil(MAX_BATCH / spine.fanout))
    const chunks: { from: number; to: number; units: Promise<{ pages: number[]; cells: number[] }> }[] = []
    let next = 0
    let size = 32
    for (;;) {
      while (chunks.length < 4 && next < total) {
        const from = next
        let subtrees = 0
        // the first chunk is a single page, for the first rows
        while (next < total && subtrees < (from ? perChunk : 1)) if (spine.cells[next++] === SUBTREE) subtrees++
        const units = this.expandSpine(spine, from, next)
        units.catch(() => {})
        chunks.push({ from, to: next, units })
      }
      const chunk = chunks.shift()
      if (!chunk) return
      const { pages, cells } = await chunk.units
      for (let i = 0; i < pages.length;) {
        const end = Math.min(pages.length, i + size)
        const progress = (chunk.from + (chunk.to - chunk.from) * end / pages.length) / total
        yield { pages: pages.slice(i, end), cells: cells.slice(i, end), progress }
        i = end
        size = Math.min(size * 2, MAX_BATCH)
      }
    }
  }

  private async expandSpine(spine: Spine, from: number, to: number): Promise<{ pages: number[]; cells: number[] }> {
    const subtrees: number[] = []
    for (let i = from; i < to; i++) if (spine.cells[i] === SUBTREE) subtrees.push(spine.pages[i])
    const read = await this.readPages(subtrees, true)
    const pages: number[] = []
    const cells: number[] = []
    for (let i = from, k = 0; i < to; i++) {
      if (spine.cells[i] === SUBTREE) {
        this.expandInterior(spine.pages[i], read[k++], LEAF, pages, cells)
      } else {
        pages.push(spine.pages[i])
        cells.push(spine.cells[i])
      }
    }
    return { pages, cells }
  }

  private async countUnits(units: Units): Promise<CountedUnits> {
    const counts = await this.leafCellCounts(units.pages.filter((_, i) => units.cells[i] === LEAF), true)
    return { ...units, counts: units.pages.map((pgno, i) => units.cells[i] === LEAF ? counts.get(pgno)! : 1) }
  }

  /**
   * Walk a b-tree in the background: list its units in order and count their rows, calling
   * onBatch for consecutive batches until it returns false. The next batch is read while
   * onBatch runs.
   */
  async walk(spine: Spine, onBatch: (batch: CountedUnits) => boolean | Promise<boolean>): Promise<void> {
    const units = this.units(spine)
    const count = (item: IteratorResult<Units>) => {
      if (item.done) return undefined
      const counted = this.countUnits(item.value)
      counted.catch(() => {})
      return counted
    }
    try {
      let counting = count(await units.next())
      while (counting) {
        const next = count(await units.next())
        if (!await onBatch(await counting)) return
        counting = next
      }
    } finally {
      await units.return(undefined)
    }
  }

  /** The first or last rowid in a table b-tree, or undefined if the table is empty. */
  async edgeRowid(root: number, last: boolean): Promise<number | bigint | undefined> {
    for (let pgno = root, depth = 1; depth <= 20; depth++) {
      const page = await this.readPage(pgno, true)
      const h = headerOffset(pgno)
      const n = u16(page, h + 3)
      if (page[h] === PAGE_INTERIOR_TABLE) {
        pgno = last || !n ? u32(page, h + 8) : u32(page, u16(page, h + 12))
        continue
      }
      if (page[h] !== PAGE_LEAF_TABLE) throw new Error(`page ${pgno} should be a table b-tree page (type ${page[h]})`)
      if (!n) return undefined
      const pos = u16(page, h + 8 + 2 * (last ? n - 1 : 0))
      return readSignedVarint(page, pos + readVarint(page, pos)[1])[0]
    }
    throw new Error(`b-tree at page ${root} is too deep; the database may be corrupt`)
  }

  private interior(pgno: number): Promise<Interior> {
    return this.cached(`${this.prefix}i${pgno}`, async () => {
      // cached parsed, not as a page
      const page = await this.loadPage(pgno, false)
      const h = headerOffset(pgno)
      if (page[h] !== PAGE_INTERIOR_TABLE) throw new Error(`page ${pgno} should be an interior table b-tree page (type ${page[h]})`)
      const n = u16(page, h + 3)
      const children: number[] = []
      const keys: number[] = []
      for (let c = 0; c < n; c++) {
        const at = u16(page, h + 12 + 2 * c)
        children.push(u32(page, at))
        keys.push(Number(readSignedVarint(page, at + 4)[0]))
      }
      children.push(u32(page, h + 8))
      return { children, keys }
    })
  }

  /** The leaf pages of a table b-tree of the given depth that can hold rowids in [lo, hi], in order. */
  async rowidLeaves(root: number, depth: number, lo: number, hi: number): Promise<RowidLeaf[]> {
    const visit = async (pgno: number, level: number, low: number, high: number): Promise<RowidLeaf[]> => {
      if (level === depth) return [{ pgno, low, high }]
      const { children, keys } = await this.interior(pgno)
      const parts: Promise<RowidLeaf[]>[] = []
      for (let i = 0; i < children.length; i++) {
        // child i holds the rowids in (keys[i - 1], keys[i]]
        const childLow = i ? keys[i - 1] : low
        const childHigh = i < keys.length ? keys[i] : high
        if (childLow >= hi) break
        if (childHigh >= lo) parts.push(visit(children[i], level + 1, childLow, childHigh))
      }
      return (await Promise.all(parts)).flat()
    }
    return visit(root, 1, -Infinity, Infinity)
  }

  /**
   * The index of a table with the fewest pages, if counting its entries is much faster than
   * counting the table's rows. Partial indexes (CREATE INDEX ... WHERE) don't have an entry
   * for every row.
   */
  async smallestIndex(table: string, tableSpine: Spine): Promise<{ name: string; spine: Spine } | undefined> {
    const tableLeaves = estimatedLeaves(tableSpine)
    if (tableLeaves < INDEX_MIN_LEAVES) return undefined
    const indexes = this.schema.filter(r => r.type === 'index' && r.rootPage > 0 &&
      r.tableName.toLowerCase() === table.toLowerCase() && !/\bwhere\b/i.test(r.sql))
    const spines = await Promise.all(indexes.map(index => this.spine(index.rootPage, true).catch(() => undefined)))
    let best: { name: string; spine: Spine } | undefined
    spines.forEach((spine, i) => {
      if (spine && (!best || estimatedLeaves(spine) < estimatedLeaves(best.spine))) best = { name: indexes[i].name, spine }
    })
    return best && estimatedLeaves(best.spine) <= tableLeaves * INDEX_MAX_RATIO ? best : undefined
  }

  // ---- cells and records ----

  /** Rows of cells [from, to) of a leaf page (all cells by default); see decodeCell for full. */
  async decodeLeaf(pgno: number, layout: Layout, full: boolean, from = 0, to = Infinity): Promise<unknown[][]> {
    const page = await this.readPage(pgno)
    const h = headerOffset(pgno)
    const type = page[h]
    if (type !== PAGE_LEAF_TABLE && type !== PAGE_LEAF_INDEX) throw new Error(`page ${pgno} is not a b-tree leaf (type ${type})`)
    const n = Math.min(u16(page, h + 3), to)
    // cells are decoded concurrently, so that the overflow chains of large rows are read in parallel
    const cells: Promise<unknown[]>[] = []
    for (let c = from; c < n; c++) cells.push(this.decodeCell(page, u16(page, h + 8 + 2 * c), type, layout, full))
    return Promise.all(cells)
  }

  /** The entry stored in cell c of an interior index page (WITHOUT ROWID tables). */
  async decodeInteriorEntry(pgno: number, cell: number, layout: Layout, full: boolean): Promise<unknown[]> {
    const page = await this.readPage(pgno)
    const h = headerOffset(pgno)
    return this.decodeCell(page, u16(page, h + 12 + 2 * cell), page[h], layout, full)
  }

  /**
   * The values of a cell: in full (up to FULL_CAP bytes) for the detail panel and copying,
   * otherwise only the first DISPLAY_PREFIX bytes of each value.
   */
  private async decodeCell(page: Uint8Array, pos: number, type: number, layout: Layout, full: boolean): Promise<unknown[]> {
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
    let payload = page.subarray(pos, pos + local)
    if (local < payloadSize) {
      const want = full ? Math.min(payloadSize, FULL_CAP) : displayBytes(payload, payloadSize)
      payload = await this.readOverflow(payload, u32(page, pos + local), want)
    }
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

  /** The first `want` bytes of a payload continued in overflow pages. */
  private async readOverflow(local: Uint8Array, first: number, want: number): Promise<Uint8Array> {
    if (want <= local.length) return local.subarray(0, want)
    const out = new Uint8Array(want)
    out.set(local)
    let filled = local.length
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
    let prefix = available.subarray(0, 4096)
    // the cut may fall inside a character
    if (type % 2 === 0 || this.encoding === 'utf-8') prefix = completeUtf8(prefix)
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

  stopCounting(): void {
    for (const table of this.openTables.values()) table.then(t => t.stopCounting(), () => {})
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
  // the units (leaf pages, or entries of interior index pages) counted so far, in order
  private unitPages = new Int32Array(256)
  private unitCells = new Int32Array(256)
  /** prefix[u] = rows before unit u, for u <= units. */
  private prefix = new Float64Array(257)
  private units = 0
  private leafPages = 0
  private depth = 0
  private estimatedLeafPages = 0
  /** Set when rows are found by rowid: the rowids run from min to max without gaps. */
  private rowids?: { min: number; max: number; index: string }
  /** The index whose entries are being counted. */
  private countingWith?: string
  /** Stop counting: the table is closed, or the database has changed. */
  private stopped = false
  private countError?: string
  private lastNotified = 0
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

  /** Count the first rows; the rest are counted in the background. */
  async start(): Promise<void> {
    const spine = await this.file.spine(this.root)
    this.depth = spine.depth
    this.estimatedLeafPages = estimatedLeaves(spine)
    this.counting = true
    let unsubscribe = () => {}
    const counted = this.count(spine)
    // wait for the first batch, so the table opens with its first rows counted
    await Promise.race([counted, new Promise<void>(resolve => (unsubscribe = this.onRowCount(resolve)))])
    unsubscribe()
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
  }

  /** CREATE TABLE ... AS SELECT and unparseable schemas: name columns after the first row's values. */
  private async guessColumns(): Promise<void> {
    const leaf = this.unitCells.subarray(0, this.units).indexOf(LEAF)
    const rows = leaf >= 0 ? await this.file.decodeLeaf(this.unitPages[leaf], this.layout, false, 0, 1) : []
    const n = rows[0]?.length ?? 0
    this.sqlTable.columns = Array.from({ length: n }, (_, i) => ({ name: `column${i + 1}`, type: '', affinity: 'BLOB' as const, notNull: false, pkDesc: false }))
    this.layout = layoutFor(this.sqlTable)
  }

  private isKey(col: number): boolean {
    const name = this.layout.columns[col].name.toLowerCase()
    return this.sqlTable.primaryKey.some(k => k.toLowerCase() === name)
  }

  private async count(spine: Spine): Promise<void> {
    let first = true
    try {
      await this.file.walk(spine, async batch => {
        if (this.stopped) return false
        this.append(batch)
        this.progress = this.totalRows ? Math.min(1, this.numRows / this.totalRows) : batch.progress
        this.wake()
        this.notify(first)
        if (first) {
          first = false
          if (await this.countWithIndex(spine)) return false
        }
        return !this.stopped
      })
    } catch (error) {
      this.countError = error instanceof Error ? error.message : String(error)
    }
    this.counting = false
    this.wake()
    this.notify(true)
  }

  private append({ pages, cells, counts }: CountedUnits): void {
    const n = this.units + pages.length
    if (n > this.unitPages.length) {
      const capacity = Math.max(n, this.unitPages.length * 2)
      const unitPages = new Int32Array(capacity)
      const unitCells = new Int32Array(capacity)
      const prefix = new Float64Array(capacity + 1)
      unitPages.set(this.unitPages)
      unitCells.set(this.unitCells)
      prefix.set(this.prefix)
      this.unitPages = unitPages
      this.unitCells = unitCells
      this.prefix = prefix
    }
    for (let i = 0, u = this.units; i < pages.length; i++, u++) {
      this.unitPages[u] = pages[i]
      this.unitCells[u] = cells[i]
      this.prefix[u + 1] = this.prefix[u] + counts[i]
      if (cells[i] === LEAF) this.leafPages++
    }
    this.units = n
    this.numRows = this.prefix[n]
  }

  /**
   * Count the rows with the table's smallest index, if that is much faster than counting its
   * leaf pages. If there are as many rows as the span of the rowids, the rowids have no gaps:
   * row n is rowid min + n, and is found directly. Otherwise the table's rows are counted, and
   * the index count is the total they are counted towards.
   */
  private async countWithIndex(spine: Spine): Promise<boolean> {
    if (this.sqlTable.withoutRowid) return false
    try {
      const index = await this.file.smallestIndex(this.name, spine)
      if (!index || this.stopped) return false
      const [min, max] = await Promise.all([this.file.edgeRowid(this.root, false), this.file.edgeRowid(this.root, true)])
      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isSafeInteger(max - min + 1)) return false
      this.countingWith = index.name
      let total = 0
      await this.file.walk(index.spine, batch => {
        for (const count of batch.counts) total += count
        this.progress = batch.progress
        this.notify()
        return !this.stopped
      })
      if (this.stopped) return false
      if (total === max - min + 1) {
        this.rowids = { min, max, index: index.name }
        this.numRows = total
        return true
      }
      this.totalRows = total
      this.progress = Math.min(1, this.numRows / total)
    } catch {
      // count the table's rows instead
    } finally {
      this.countingWith = undefined
    }
    return false
  }

  /** Report a new row count or progress, at most every 200 ms unless forced. */
  private notify(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastNotified < 200) return
    this.lastNotified = now
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
    let hi = this.units - 1
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
    if (this.rowids) return this.rowsByRowid(start, end, full)
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
    if (cell >= 0) return [await this.file.decodeInteriorEntry(pgno, cell, this.layout, full)]
    if (full) return this.file.decodeLeaf(pgno, this.layout, true, from, to)
    return (await this.leafRows(pgno)).slice(from, to)
  }

  /** Rows [start, end) when the rowids have no gaps, found by rowid. */
  private async rowsByRowid(start: number, end: number, full: boolean): Promise<unknown[][]> {
    const { min, max } = this.rowids!
    const lo = min + start
    const hi = min + end - 1
    const leaves = await this.file.rowidLeaves(this.root, this.depth, lo, hi)
    const parts = leaves.map(async ({ pgno, low, high }) => {
      // without gaps, a leaf page holds exactly the rowids within its bounds
      const first = Math.max(low + 1, min)
      const last = Math.min(high, max)
      const from = Math.max(lo, first) - first
      const to = Math.min(hi, last) - first + 1
      if (full) return this.file.decodeLeaf(pgno, this.layout, true, from, to)
      const rows = await this.leafRows(pgno)
      if (rows.length !== last - first + 1) throw new Error(`page ${pgno} doesn't hold the rowids its parent page says; the database may be corrupt`)
      return rows.slice(from, to)
    })
    const rows = (await Promise.all(parts)).flat()
    if (rows.length !== end - start) throw new Error(`rows ${start} to ${end - 1} were not found by rowid; the database may be corrupt`)
    return rows
  }

  /** All rows of a leaf page, as shown in the grid. */
  private leafRows(pgno: number): Promise<unknown[][]> {
    return this.file.cached(`${this.file.prefix}${pgno}`, () => this.file.decodeLeaf(pgno, this.layout, false))
  }

  async readColumn(col: number, start: number, end: number, full = false): Promise<unknown[]> {
    const rows = await this.readRows(start, Math.min(end, Math.max(this.numRows, start)), full)
    return rows.map(row => row[col])
  }

  /** How rows are found: 'rowid' when the rowids have no gaps, otherwise by 'position' in the b-tree. */
  get lookup(): 'rowid' | 'position' {
    return this.rowids ? 'rowid' : 'position'
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
    const fmt = (n: number) => n.toLocaleString('en-US')
    let rows = fmt(this.numRows)
    if (this.counting) {
      rows += this.totalRows ? ` of ${fmt(this.totalRows)}` : '+'
      rows += ` (counting${this.countingWith ? ` with index ${this.countingWith}` : ''}, ${Math.floor(this.progress * 100)}%)`
    }
    const leafPages = this.counting || this.rowids ? `about ${fmt(this.estimatedLeafPages)}` : fmt(this.leafPages)
    items.push(
      { key: 'Table', value: `${this.name} (${kind})` },
      { key: 'Rows', value: rows },
      { key: 'B-tree', value: `root page ${this.root}, depth ${this.depth}, ${leafPages} leaf pages` },
    )
    if (this.rowids) {
      const { min, max, index } = this.rowids
      items.push({ key: 'Row lookup', value: `by rowid: the rowids run from ${fmt(min)} to ${fmt(max)} without gaps (rows counted with index ${index})` })
    }
    if (this.countError) items.push({ key: 'Error', value: this.countError })
    return items
  }

  get schemaSql(): string {
    return this.sql
  }

  stopCounting(): void {
    this.stopped = true
  }

  override dispose(): void {
    this.stopped = true
    super.dispose()
  }
}

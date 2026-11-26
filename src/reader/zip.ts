// Read-only access to zip archives (https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT),
// also ZIP64 and archives with other data before them (self-extracting archives), without native
// dependencies. The central directory is read when the archive is opened. Files stored without
// compression are read in place; compressed files can only be read from their start, so they are
// decompressed in full when they are read (deflate and zstd, with Node's zlib).

import type { Transform } from 'node:stream'
import * as zlib from 'node:zlib'
import { ArchiveError, archiveFileSource, resolvePath, type Archive, type EntryKind } from './archive'
import { compressors } from './compressors'
import { formatBytes } from './format'
import { LruCache } from './lru'
import type { ByteSource } from './source'

// signatures of the records
const END = 0x06054b50
const END64 = 0x06064b50
const END64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
/** The end record is 22 bytes, followed by a comment of at most 65535. */
const END_SEARCH = 22 + 0xffff
/** Large reads (the central directory, compressed files) are made in pieces of this size, at once. */
const CHUNK = 1 << 20

const STORED = 0
const DEFLATE = 8
const ZSTD = 93
const METHODS: Record<number, string> = {
  0: 'stored', 1: 'shrink', 6: 'implode', 8: 'deflate', 9: 'deflate64', 12: 'bzip2', 14: 'lzma', 93: 'zstd', 95: 'xz', 98: 'PPMd', 99: 'AES',
}
// general purpose flags
const ENCRYPTED = 0x1
const UTF8 = 0x800

/** Compressed files are decompressed in memory, up to this size. */
const MAX_DECOMPRESSED = 2 ** 31 - 1
/** Decompressed files up to this size are kept in the cache. */
const MAX_CACHED = 16 << 20

export interface ZipEntry {
  name: string
  kind: EntryKind
  /** Modification time, seconds since the epoch. */
  mtime: number
  /** File size, uncompressed. */
  size: number
  /** Directories: their entries, by name. */
  children?: Map<string, ZipEntry>
  // files and links: how and where the data is stored
  method: number
  flags: number
  compressedSize: number
  /** Position of the local header in the file. */
  header: number
  /** Position of the data in the file, once the local header has been read. */
  dataStart?: Promise<number>
  /** Symbolic links: the target, once read. */
  target?: string
}

export interface ZipInfo {
  /** Files, folders and links in the central directory. */
  entries: number
  /** Total size of the files, uncompressed. */
  size: number
  /** The compression methods of the files, and how many files use each. */
  methods: Map<string, number>
  /** Files Eyeball can't read: encrypted, or compressed with a method it doesn't read. */
  unreadable: number
  zip64: boolean
  /** Bytes of other data before the archive (e.g. a self-extracting program), if positions in the archive don't count them. */
  offset: number
  comment: string
}

export function methodName(method: number): string {
  return METHODS[method] ?? `method ${method}`
}

/** Whether Eyeball can read a file's data. */
const readable = (file: { method: number; flags: number }) =>
  !(file.flags & ENCRYPTED) && (file.method === STORED || file.method === DEFLATE || file.method === ZSTD)

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true))

/** Code page 437, the encoding of names without the UTF-8 flag (in the zip specification). */
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0'
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** A name or comment: UTF-8 if the flag says so, and in practice often without it; otherwise code page 437. */
function decodeText(bytes: Uint8Array, flags = 0): string {
  if (flags & UTF8) return new TextDecoder().decode(bytes)
  try {
    return strictUtf8.decode(bytes)
  } catch {
    return Array.from(bytes, b => (b < 128 ? String.fromCharCode(b) : CP437[b - 128])).join('')
  }
}

/** A DOS date and time (local time, in steps of 2 seconds), in seconds since the epoch. */
function dosTime(date: number, time: number): number {
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime() / 1000
}

let crcTable: Int32Array | undefined

function crc32(bytes: Uint8Array): number {
  crcTable ??= Int32Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
    return n
  })
  let crc = -1
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return ~crc >>> 0
}

function directory(name: string, mtime: number): ZipEntry {
  return { name, kind: 'directory', mtime, size: 0, children: new Map(), method: STORED, flags: 0, compressedSize: 0, header: -1 }
}

/** Bytes [start, end) of a source, read in pieces at once (which is faster on network file systems). */
async function readChunked(source: ByteSource, start: number, end: number, background = false): Promise<Uint8Array> {
  if (end - start <= CHUNK) return source.read(start, end, background)
  const out = new Uint8Array(end - start)
  const reads: Promise<void>[] = []
  for (let at = start; at < end; at += CHUNK) {
    reads.push(source.read(at, Math.min(at + CHUNK, end), background).then(bytes => out.set(bytes, at - start)))
  }
  await Promise.all(reads)
  return out
}

/** A file's data, decompressed into a buffer of its size, on Node's thread pool. */
function decompress(file: ZipEntry, data: Uint8Array): Promise<Uint8Array> {
  const corrupt = (detail: string) => new Error(`${file.name} ${detail}; the archive may be corrupt`)
  const createZstd = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress
  if (file.method === ZSTD && !createZstd) {
    // Node before 22.15: a JS decoder
    const out = compressors.ZSTD!(data, file.size)
    if (out.length !== file.size) return Promise.reject(corrupt("doesn't decompress to its size"))
    return Promise.resolve(out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out : out.slice())
  }
  const stream: Transform = file.method === DEFLATE ? zlib.createInflateRaw() : createZstd!()
  return new Promise((resolve, reject) => {
    const out = new Uint8Array(file.size)
    let filled = 0
    stream.on('data', (chunk: Uint8Array) => {
      if (filled + chunk.length > file.size) {
        stream.destroy()
        reject(corrupt('decompresses to more than its size'))
        return
      }
      out.set(chunk, filled)
      filled += chunk.length
    })
    stream.on('end', () => (filled === file.size ? resolve(out) : reject(corrupt('decompresses to less than its size'))))
    stream.on('error', error => reject(corrupt(`can't be decompressed (${error.message})`)))
    stream.end(data)
  })
}

export class ZipArchive implements Archive {
  private readonly cache = new LruCache<Uint8Array>(128 << 20)
  private readonly pending = new Map<number, Promise<Uint8Array>>()

  private constructor(private readonly source: ByteSource, readonly root: ZipEntry, readonly info: ZipInfo) {}

  static async open(source: ByteSource): Promise<ZipArchive> {
    const size = source.size
    const tailStart = Math.max(0, size - END_SEARCH)
    const tail = await source.read(tailStart, size)
    const tv = view(tail)
    // the end record: the last one whose comment fits in the file
    let at = tail.length - 22
    while (at >= 0 && !(tv.getUint32(at, true) === END && at + 22 + tv.getUint16(at + 20, true) <= tail.length)) at--
    if (at < 0) throw new Error('not a zip archive')
    const end = tailStart + at
    const multipart = () => new Error("this is a part of a split (multi-part) zip archive, which Eyeball can't read")
    if (tv.getUint16(at + 4, true) !== 0 && tv.getUint16(at + 4, true) !== 0xffff) throw multipart()
    let entries = tv.getUint16(at + 10, true)
    let cdSize = tv.getUint32(at + 12, true)
    let cdOffset = tv.getUint32(at + 16, true)
    const comment = decodeText(tail.subarray(at + 22, at + 22 + tv.getUint16(at + 20, true)))
    let cdEnd = end
    let zip64 = false
    // ZIP64: a locator just before the end record points to the ZIP64 end record
    const locator = at >= 20 ? tail.subarray(at - 20, at) : end >= 20 ? await source.read(end - 20, end) : undefined
    if (locator && view(locator).getUint32(0, true) === END64_LOCATOR) {
      const lv = view(locator)
      if (lv.getUint32(16, true) > 1) throw multipart()
      // the position of the record doesn't count data before the archive; then it is usually just before the locator
      for (const position of new Set([u64(lv, 8), end - 20 - 56])) {
        if (position < 0 || position + 56 > end - 20) continue
        const record = view(await source.read(position, position + 56))
        if (record.getUint32(0, true) !== END64) continue
        entries = u64(record, 32)
        cdSize = u64(record, 40)
        cdOffset = u64(record, 48)
        cdEnd = position
        zip64 = true
        break
      }
      if (!zip64) throw new Error("the ZIP64 end record isn't where the archive says; the archive may be corrupt")
    }
    // the central directory ends where the end record starts, so positions are off by the size of
    // any data before the archive that they don't count
    const cdStart = cdEnd - cdSize
    const offset = cdStart - cdOffset
    if (cdStart < 0 || offset < 0) throw new Error("the central directory isn't where the archive says; the archive may be corrupt")
    const cd = await readChunked(source, cdStart, cdEnd)
    const cv = view(cd)

    const root = directory('', 0)
    const info: ZipInfo = { entries: 0, size: 0, methods: new Map(), unreadable: 0, zip64, offset, comment }
    for (let p = 0; p + 46 <= cd.length && cv.getUint32(p, true) === CENTRAL;) {
      const madeBy = cv.getUint16(p + 4, true)
      const flags = cv.getUint16(p + 8, true)
      const method = cv.getUint16(p + 10, true)
      let mtime = dosTime(cv.getUint16(p + 14, true), cv.getUint16(p + 12, true))
      let compressedSize = cv.getUint32(p + 20, true)
      let size = cv.getUint32(p + 24, true)
      const nameEnd = p + 46 + cv.getUint16(p + 28, true)
      const extraEnd = nameEnd + cv.getUint16(p + 30, true)
      const external = cv.getUint32(p + 38, true)
      let header = cv.getUint32(p + 42, true)
      const rawName = cd.subarray(p + 46, nameEnd)
      let unicodeName: string | undefined
      // extra fields: ZIP64 sizes and position, the modification time in UTC, the name in UTF-8
      for (let e = nameEnd; e + 4 <= extraEnd && e + 4 <= cd.length;) {
        const id = cv.getUint16(e, true)
        const data = e + 4
        const dataEnd = data + cv.getUint16(e + 2, true)
        if (dataEnd > extraEnd || dataEnd > cd.length) break
        if (id === 0x0001) {
          // the values that don't fit in their field, in this order
          let q = data
          const take = (value: number) => {
            if (value !== 0xffffffff || q + 8 > dataEnd) return value
            q += 8
            return u64(cv, q - 8)
          }
          size = take(size)
          compressedSize = take(compressedSize)
          header = take(header)
        } else if (id === 0x5455 && dataEnd - data >= 5 && cd[data] & 1) {
          mtime = cv.getUint32(data + 1, true)
        } else if (id === 0x7075 && dataEnd - data >= 5 && cd[data] === 1 && cv.getUint32(data + 1, true) === crc32(rawName)) {
          unicodeName = new TextDecoder().decode(cd.subarray(data + 5, dataEnd))
        }
        e = dataEnd
      }
      p = extraEnd + cv.getUint16(p + 32, true)
      info.entries++

      const host = madeBy >> 8
      let name = unicodeName ?? decodeText(rawName, flags)
      // archives made on Windows (FAT, NTFS, VFAT) may separate directories with backslashes
      if (host === 0 || host === 10 || host === 14) name = name.replace(/\\/g, '/')
      // the type of the file, in Unix permissions (from Unix and macOS)
      const type = host === 3 || host === 19 ? (external >>> 16) & 0o170000 : 0
      const kind: EntryKind = name.endsWith('/') || type === 0o040000 ? 'directory' : type === 0o120000 ? 'symlink' : 'file'
      if (kind === 'file') {
        info.size += size
        const label = methodName(method)
        info.methods.set(label, (info.methods.get(label) ?? 0) + 1)
        if (!readable({ method, flags })) info.unreadable++
      }

      // '..' can't take a path out of the archive, and '/' at the start is ignored (as unzip does)
      const parts = name.split('/').filter(part => part && part !== '.' && part !== '..')
      if (!parts.length) continue
      let dir = root
      for (const part of parts.slice(0, -1)) {
        let child = dir.children!.get(part)
        // directories may only be implied by the paths of the files in them; they take the place of a file of the same name
        if (child?.kind !== 'directory') dir.children!.set(part, (child = directory(part, mtime)))
        dir = child
      }
      const last = parts[parts.length - 1]
      const existing = dir.children!.get(last)
      if (kind === 'directory') {
        if (existing?.kind === 'directory') existing.mtime = mtime
        else dir.children!.set(last, directory(last, mtime))
      } else if (existing?.kind !== 'directory') {
        dir.children!.set(last, { name: last, kind, mtime, size, method, flags, compressedSize, header: header + offset })
      }
    }
    if (!info.entries && entries) throw new Error("the central directory isn't where the archive says; the archive may be corrupt")
    return new ZipArchive(source, root, info)
  }

  entries(dir: ZipEntry): Promise<Map<string, ZipEntry>> {
    if (dir.kind !== 'directory') return Promise.reject(new ArchiveError('ENOTDIR', 'not a directory'))
    return Promise.resolve(dir.children!)
  }

  /**
   * The entry at a path (absolute within the archive, '/'-separated). Symbolic links are followed
   * (see resolvePath), with links to absolute paths taken from the root of the archive.
   */
  lookup(path: string, followLast = true): Promise<ZipEntry> {
    return resolvePath(this.root, path, followLast, async (dir, name) => dir.children!.get(name), async link => {
      link.target ??= new TextDecoder().decode(await this.contents(link))
      return link.target
    })
  }

  /** Position of the data of a file, after its local header. */
  private dataStart(file: ZipEntry): Promise<number> {
    if (!file.dataStart) {
      const start = (async () => {
        const corrupt = (detail: string) => new Error(`${file.name} ${detail}; the archive may be corrupt`)
        if (file.header < 0 || file.header + 30 > this.source.size) throw corrupt('is beyond the end of the file')
        const local = view(await this.source.read(file.header, file.header + 30))
        if (local.getUint32(0, true) !== LOCAL) throw corrupt("isn't where the central directory says")
        const data = file.header + 30 + local.getUint16(26, true) + local.getUint16(28, true)
        if (data + file.compressedSize > this.source.size) throw corrupt('ends beyond the end of the file')
        return data
      })()
      file.dataStart = start
      // try again next time, if the read failed
      start.catch(() => file.dataStart === start && (file.dataStart = undefined))
    }
    return file.dataStart
  }

  /** The data of a file or link, decompressed; small ones are kept in the cache. */
  contents(file: ZipEntry, background = false): Promise<Uint8Array> {
    if (file.flags & ENCRYPTED) return Promise.reject(new Error(`${file.name} is encrypted, which Eyeball can't read`))
    if (!readable(file)) {
      return Promise.reject(new Error(`${file.name} is compressed with ${methodName(file.method)}, which Eyeball can't read (it reads deflate and zstd)`))
    }
    if (file.size > MAX_DECOMPRESSED) {
      return Promise.reject(new Error(`${file.name} is compressed, and too large (${formatBytes(file.size)}) to decompress in memory`))
    }
    const hit = this.cache.get(String(file.header))
    if (hit) return Promise.resolve(hit)
    let pending = this.pending.get(file.header)
    if (!pending) {
      pending = (async () => {
        const start = await this.dataStart(file)
        const data = await readChunked(this.source, start, start + file.compressedSize, background)
        if (file.method !== STORED) return decompress(file, data)
        if (data.length !== file.size) throw new Error(`${file.name} is stored with a size other than its own; the archive may be corrupt`)
        return data
      })()
      this.pending.set(file.header, pending)
      pending.then(
        data => {
          this.pending.delete(file.header)
          if (data.byteLength <= MAX_CACHED) this.cache.set(String(file.header), data, data.byteLength + 64)
        },
        () => this.pending.delete(file.header),
      )
    }
    return pending
  }

  /** Bytes [start, end) of a file: in place if it is stored, otherwise from the decompressed file. */
  async read(file: ZipEntry, start: number, end: number, background = false): Promise<Uint8Array> {
    if (file.kind === 'directory') throw new ArchiveError('EISDIR', 'is a directory')
    end = Math.min(end, file.size)
    if (end <= start) return new Uint8Array(0)
    if (file.method === STORED && !(file.flags & ENCRYPTED)) {
      const data = await this.dataStart(file)
      return readChunked(this.source, data + start, data + end, background)
    }
    return (await this.contents(file, background)).slice(start, end)
  }

  /**
   * A file as a byte source, for the Parquet and SQLite readers: read in place if it is stored,
   * otherwise decompressed when it is first read, and kept until the source is closed.
   */
  fileSource(file: ZipEntry): ByteSource {
    if (file.method === STORED && !(file.flags & ENCRYPTED)) return archiveFileSource(this, file)
    let contents: Promise<Uint8Array> | undefined
    return {
      size: file.size,
      read: async (start, end, background) => {
        if (start < 0 || end > file.size || start > end) throw new RangeError(`read [${start}, ${end}) outside file of ${file.size} bytes`)
        contents ??= this.contents(file, background).catch(error => {
          contents = undefined
          throw error
        })
        return (await contents).slice(start, end)
      },
      async close() {
        contents = undefined
      },
    }
  }
}

// Read-only access to SquashFS 4.0 images (https://dr-emann.github.io/squashfs/squashfs.html),
// also inside Apptainer/Singularity images (SIF), without native dependencies. Directories,
// inodes and data blocks are read and decompressed as they are needed, and cached.

import * as zlib from 'node:zlib'
import { ArchiveError, archiveFileSource, resolvePath, type Archive, type EntryKind } from './archive'
import { compressors } from './compressors'
import { LruCache, estimateSize } from './lru'
import type { ByteSource } from './source'

const MAGIC = 'hsqs'
const METADATA_SIZE = 8192
const UNCOMPRESSED_METADATA = 0x8000
const UNCOMPRESSED_BLOCK = 1 << 24
const NO_FRAGMENT = 0xffffffff
/** Raw reads of metadata are made in chunks of this size, as metadata blocks are small and consecutive. */
const RAW_CHUNK = 256 << 10

const COMPRESSION = ['', 'gzip', 'lzma', 'lzo', 'xz', 'lz4', 'zstd']

// inode types; directory entries use the basic types
const DIR = 1
const FILE = 2
const SYMLINK = 3
const EXT_DIR = 8
const EXT_FILE = 9
const EXT_SYMLINK = 10

export interface Inode {
  kind: EntryKind
  /** Permission bits. */
  mode: number
  /** Modification time, seconds since the epoch. */
  mtime: number
  /** File size; for directories, the size of their listing. */
  size: number
  // directories: where the listing is in the directory table
  listingBlock?: number
  listingOffset?: number
  // files: the data blocks and the fragment that holds the end of the file
  blocksStart?: number
  blockSizes?: Uint32Array
  fragment?: number
  fragmentOffset?: number
  // symbolic links
  target?: string
}

export interface DirEntry {
  name: string
  kind: EntryKind
  /** Reference to the inode: block (relative to the inode table) << 16 | offset. */
  ref: number
}

export interface SquashfsInfo {
  compression: string
  blockSize: number
  inodes: number
  bytesUsed: number
  created: Date
  /** Offset of the file system in the file: 0, or the partition of a SIF image. */
  offset: number
}

const KIND_OF_TYPE: Record<number, EntryKind> = { 1: 'directory', 2: 'file', 3: 'symlink', 8: 'directory', 9: 'file', 10: 'symlink' }

/**
 * Offset of the SquashFS file system in a file: 0 for SquashFS images, or the primary system
 * partition of an Apptainer/Singularity image (https://github.com/sylabs/sif).
 */
export async function squashfsOffset(source: ByteSource): Promise<number> {
  if (source.size < 96) throw new Error('not a SquashFS image (file too small)')
  const head = await source.read(0, Math.min(source.size, 128))
  if (ascii(head, 0, 4) === MAGIC) return 0
  if (head.length >= 128 && ascii(head, 32, 41) === 'SIF_MAGIC') {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    const total = Number(view.getBigInt64(88, true))
    const descriptorsOffset = Number(view.getBigInt64(96, true))
    const size = 585 // a descriptor, packed
    const descriptors = await source.read(descriptorsOffset, Math.min(source.size, descriptorsOffset + total * size))
    const dv = new DataView(descriptors.buffer, descriptors.byteOffset, descriptors.byteLength)
    const partitions: { offset: number; partType: number }[] = []
    for (let at = 0; at + size <= descriptors.length; at += size) {
      const dataType = dv.getInt32(at, true)
      const used = descriptors[at + 4]
      const fsType = dv.getInt32(at + 201, true)
      // a data partition (0x4004) holding SquashFS (1)
      if (used && dataType === 0x4004 && fsType === 1) {
        partitions.push({ offset: Number(dv.getBigInt64(at + 17, true)), partType: dv.getInt32(at + 205, true) })
      }
    }
    // the primary system partition (2) is the container's root file system
    const partition = partitions.find(p => p.partType === 2) ?? partitions[0]
    if (!partition) throw new Error('this SIF image has no SquashFS partition')
    return partition.offset
  }
  throw new Error('not a SquashFS image')
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

/** An LZ4 block (as SquashFS stores them: without a frame), of at most maxSize bytes. */
function lz4Block(input: Uint8Array, maxSize: number): Uint8Array {
  const out = new Uint8Array(maxSize)
  let i = 0
  let o = 0
  for (;;) {
    const token = input[i++]
    let literals = token >> 4
    if (literals === 15) for (let b = 255; b === 255;) literals += b = input[i++]
    out.set(input.subarray(i, i + literals), o)
    i += literals
    o += literals
    if (i >= input.length) break
    const offset = input[i] | input[i + 1] << 8
    i += 2
    let length = token & 15
    if (length === 15) for (let b = 255; b === 255;) length += b = input[i++]
    length += 4
    if (!offset || offset > o) throw new Error('corrupt LZ4 block')
    if (offset >= length) {
      out.copyWithin(o, o - offset, o - offset + length)
    } else {
      // overlapping copy: repeats the last offset bytes
      for (let k = 0; k < length; k++) out[o + k] = out[o - offset + k]
    }
    o += length
  }
  return out.subarray(0, o)
}

export class SquashfsImage implements Archive {
  readonly info: SquashfsInfo
  private readonly decompress: (data: Uint8Array, maxSize: number) => Uint8Array
  private readonly cache = new LruCache<unknown>(128 << 20)
  private readonly pending = new Map<string, Promise<unknown>>()
  private fragmentTable?: Promise<number[]>
  private readonly view: DataView

  private constructor(private readonly source: ByteSource, private readonly offset: number, superblock: Uint8Array) {
    const view = (this.view = new DataView(superblock.buffer, superblock.byteOffset, superblock.byteLength))
    if (ascii(superblock, 0, 4) !== MAGIC) throw new Error('not a SquashFS image')
    const major = view.getUint16(28, true)
    const minor = view.getUint16(30, true)
    if (major !== 4) throw new Error(`SquashFS version ${major}.${minor} isn't supported (only 4.0)`)
    const blockSize = view.getUint32(12, true)
    if (blockSize !== 1 << view.getUint16(22, true)) throw new Error('corrupt SquashFS superblock')
    const compressionId = view.getUint16(20, true)
    const compression = COMPRESSION[compressionId] ?? `unknown (${compressionId})`
    this.info = {
      compression,
      blockSize,
      inodes: view.getUint32(4, true),
      bytesUsed: this.u64(40),
      created: new Date(view.getUint32(8, true) * 1000),
      offset,
    }
    this.decompress = decompressorFor(compression)
  }

  static async open(source: ByteSource, offset = 0): Promise<SquashfsImage> {
    return new SquashfsImage(source, offset, await source.read(offset, Math.min(source.size, offset + 96)))
  }

  private u64(at: number): number {
    return Number(this.view.getBigUint64(at, true))
  }

  private get blockSize(): number {
    return this.info.blockSize
  }

  private get inodeTable(): number {
    return this.u64(64)
  }

  private get directoryTable(): number {
    return this.u64(72)
  }

  private get flags(): number {
    return this.view.getUint16(24, true)
  }

  /** Get from the cache, or compute once (concurrent callers share the computation) and cache. */
  private cached<T>(key: string, compute: () => Promise<T>, size?: (value: T) => number): Promise<T> {
    const hit = this.cache.get(key)
    if (hit !== undefined) return Promise.resolve(hit as T)
    let pending = this.pending.get(key) as Promise<T> | undefined
    if (!pending) {
      pending = compute()
      this.pending.set(key, pending)
      pending.then(
        value => {
          this.pending.delete(key)
          this.cache.set(key, value, size ? size(value) : estimateSize(value))
        },
        () => this.pending.delete(key),
      )
    }
    return pending
  }

  // ---- raw reads and metadata ----

  /** Bytes [start, end) of the file system, through a cache of chunks (for metadata). */
  private async raw(start: number, end: number): Promise<Uint8Array> {
    const last = this.offset + this.info.bytesUsed
    const chunks: Promise<Uint8Array>[] = []
    for (let c = Math.floor(start / RAW_CHUNK); c * RAW_CHUNK < end; c++) {
      chunks.push(this.cached(`raw${c}`, () => {
        const from = this.offset + c * RAW_CHUNK
        return this.source.read(from, Math.min(from + RAW_CHUNK, last, this.source.size))
      }, bytes => bytes.byteLength))
    }
    const parts = await Promise.all(chunks)
    const base = Math.floor(start / RAW_CHUNK) * RAW_CHUNK
    const out = new Uint8Array(Math.min(end, base + parts.reduce((n, p) => n + p.length, 0)) - start)
    let at = base
    for (const part of parts) {
      const from = Math.max(start - at, 0)
      const to = Math.min(part.length, end - at)
      if (to > from) out.set(part.subarray(from, to), at + from - start)
      at += part.length
    }
    return out
  }

  /** The metadata block at a position of the file system: its data, and the position of the next one. */
  private metadataBlock(position: number): Promise<{ data: Uint8Array; next: number }> {
    return this.cached(`m${position}`, async () => {
      const header = await this.raw(position, position + 2)
      if (header.length < 2) throw new Error(`metadata block at ${position} is beyond the end of the image`)
      const word = header[0] | header[1] << 8
      const size = word & ~UNCOMPRESSED_METADATA
      const stored = await this.raw(position + 2, position + 2 + size)
      const data = word & UNCOMPRESSED_METADATA ? stored.slice() : this.decompress(stored, METADATA_SIZE)
      return { data, next: position + 2 + size }
    }, value => value.data.byteLength + 64)
  }

  /** length bytes of metadata, from block (relative to table) and offset, continuing in the following blocks. */
  private async metadata(table: number, block: number, offset: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length)
    let filled = 0
    let position = table + block
    while (filled < length) {
      const { data, next } = await this.metadataBlock(position)
      const take = Math.min(data.length - offset, length - filled)
      if (take <= 0) throw new Error('metadata ends early; the image may be corrupt')
      out.set(data.subarray(offset, offset + take), filled)
      filled += take
      offset = 0
      position = next
    }
    return out
  }

  // ---- inodes and directories ----

  get rootRef(): number {
    return this.u64(32)
  }

  inode(ref: number): Promise<Inode> {
    return this.cached(`i${ref}`, async () => {
      const block = Math.floor(ref / 65536)
      const offset = ref % 65536
      // the fixed part (at most 56 bytes, for extended files), then the variable part
      const fixed = await this.metadata(this.inodeTable, block, offset, 56).catch(() => this.metadataTail(block, offset))
      const v = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength)
      const type = v.getUint16(0, true)
      const inode: Inode = { kind: KIND_OF_TYPE[type] ?? 'other', mode: v.getUint16(2, true), mtime: v.getUint32(8, true), size: 0 }
      if (type === DIR) {
        inode.listingBlock = v.getUint32(16, true)
        inode.size = v.getUint16(24, true)
        inode.listingOffset = v.getUint16(26, true)
      } else if (type === EXT_DIR) {
        inode.size = v.getUint32(20, true)
        inode.listingBlock = v.getUint32(24, true)
        inode.listingOffset = v.getUint16(34, true)
      } else if (type === FILE || type === EXT_FILE) {
        let header: number
        if (type === FILE) {
          inode.blocksStart = v.getUint32(16, true)
          inode.fragment = v.getUint32(20, true)
          inode.fragmentOffset = v.getUint32(24, true)
          inode.size = v.getUint32(28, true)
          header = 32
        } else {
          inode.blocksStart = Number(v.getBigUint64(16, true))
          inode.size = Number(v.getBigUint64(24, true))
          inode.fragment = v.getUint32(44, true)
          inode.fragmentOffset = v.getUint32(48, true)
          header = 56
        }
        const hasFragment = inode.fragment !== NO_FRAGMENT
        const blocks = hasFragment ? Math.floor(inode.size / this.blockSize) : Math.ceil(inode.size / this.blockSize)
        const all = await this.metadata(this.inodeTable, block, offset, header + 4 * blocks)
        inode.blockSizes = new Uint32Array(blocks)
        const bv = new DataView(all.buffer, all.byteOffset + header, 4 * blocks)
        for (let i = 0; i < blocks; i++) inode.blockSizes[i] = bv.getUint32(4 * i, true)
      } else if (type === SYMLINK || type === EXT_SYMLINK) {
        const length = v.getUint32(20, true)
        const all = await this.metadata(this.inodeTable, block, offset, 24 + length)
        inode.target = new TextDecoder().decode(all.subarray(24))
        inode.size = length
      }
      return inode
    })
  }

  /** The rest of the inode table from a position, when fewer than 56 bytes are left (a small last inode). */
  private async metadataTail(block: number, offset: number): Promise<Uint8Array> {
    const { data } = await this.metadataBlock(this.inodeTable + block)
    return data.slice(offset)
  }

  /** The entries of a directory, by name. */
  entries(dir: Inode): Promise<Map<string, DirEntry>> {
    if (dir.kind !== 'directory') return Promise.reject(new ArchiveError('ENOTDIR', 'not a directory'))
    // the size of a directory counts 3 bytes that aren't stored; an empty directory has no
    // listing, and its position may be that of the next directory's listing
    const length = dir.size - 3
    if (length <= 0) return Promise.resolve(new Map())
    return this.cached(`d${dir.listingBlock}:${dir.listingOffset}:${length}`, async () => {
      const entries = new Map<string, DirEntry>()
      const data = await this.metadata(this.directoryTable, dir.listingBlock!, dir.listingOffset!, length)
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const decoder = new TextDecoder()
      for (let at = 0; at + 12 <= length;) {
        const count = v.getUint32(at, true) + 1
        const start = v.getUint32(at + 4, true)
        at += 12
        for (let k = 0; k < count && at + 8 <= length; k++) {
          const offset = v.getUint16(at, true)
          const type = v.getUint16(at + 4, true)
          const nameSize = v.getUint16(at + 6, true) + 1
          const name = decoder.decode(data.subarray(at + 8, at + 8 + nameSize))
          entries.set(name, { name, kind: KIND_OF_TYPE[type] ?? 'other', ref: start * 65536 + offset })
          at += 8 + nameSize
        }
      }
      return entries
    })
  }

  /**
   * The inode at a path (absolute within the image, '/'-separated). Symbolic links are followed
   * (see resolvePath), with links to absolute paths taken from the root of the image.
   */
  async lookup(path: string, followLast = true): Promise<Inode> {
    const child = async (dir: Inode, name: string) => {
      const entry = (await this.entries(dir)).get(name)
      return entry && this.inode(entry.ref)
    }
    return resolvePath(await this.inode(this.rootRef), path, followLast, child, async link => link.target!)
  }

  // ---- file contents ----

  /** Byte position of each data block of a file, and the end of the last one. */
  private blockPositions(inode: Inode): number[] {
    const positions = [inode.blocksStart!]
    for (const size of inode.blockSizes!) positions.push(positions[positions.length - 1] + (size & ~UNCOMPRESSED_BLOCK))
    return positions
  }

  /** Data block i of a file, decompressed. */
  private dataBlock(inode: Inode, i: number, positions: number[], background: boolean): Promise<Uint8Array> {
    const stored = inode.blockSizes![i]
    const length = Math.min(this.blockSize, inode.size - i * this.blockSize)
    // a block of size 0 is a hole in a sparse file
    if ((stored & ~UNCOMPRESSED_BLOCK) === 0) return Promise.resolve(new Uint8Array(length))
    return this.cached(`b${positions[i]}`, async () => {
      const start = this.offset + positions[i]
      const bytes = await this.source.read(start, start + (stored & ~UNCOMPRESSED_BLOCK), background)
      const data = stored & UNCOMPRESSED_BLOCK ? bytes : this.decompress(bytes, this.blockSize)
      if (data.length < length) throw new Error('a data block is shorter than expected; the image may be corrupt')
      return data
    }, data => data.byteLength + 64)
  }

  private fragments(): Promise<number[]> {
    this.fragmentTable ??= (async () => {
      const count = this.view.getUint32(16, true)
      if (!count || this.flags & 0x10) return []
      // the table is a list of positions of the metadata blocks that hold the entries
      const blocks = Math.ceil(count * 16 / METADATA_SIZE)
      const table = this.u64(80)
      const pointers = await this.raw(table, table + 8 * blocks)
      const pv = new DataView(pointers.buffer, pointers.byteOffset, pointers.byteLength)
      const entries: number[] = []
      for (let b = 0; b < blocks; b++) {
        const { data } = await this.metadataBlock(Number(pv.getBigUint64(8 * b, true)))
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
        for (let at = 0; at + 16 <= data.length && entries.length < 2 * count; at += 16) {
          entries.push(Number(dv.getBigUint64(at, true)), dv.getUint32(at + 8, true))
        }
      }
      return entries
    })()
    return this.fragmentTable
  }

  /** The fragment block that holds the end of a file, decompressed. */
  private async fragmentBlock(index: number, background: boolean): Promise<Uint8Array> {
    const entries = await this.fragments()
    if (2 * index >= entries.length) throw new Error(`fragment ${index} isn't in the fragment table`)
    const start = entries[2 * index]
    const stored = entries[2 * index + 1]
    return this.cached(`b${start}`, async () => {
      const bytes = await this.source.read(this.offset + start, this.offset + start + (stored & ~UNCOMPRESSED_BLOCK), background)
      return stored & UNCOMPRESSED_BLOCK ? bytes : this.decompress(bytes, this.blockSize)
    }, data => data.byteLength + 64)
  }

  /** Bytes [start, end) of a file. */
  async read(inode: Inode, start: number, end: number, background = false): Promise<Uint8Array> {
    if (inode.kind === 'directory') throw new ArchiveError('EISDIR', 'is a directory')
    if (inode.kind !== 'file') throw new Error('not a regular file')
    end = Math.min(end, inode.size)
    if (end <= start) return new Uint8Array(0)
    const out = new Uint8Array(end - start)
    const blockSize = this.blockSize
    const blocks = inode.blockSizes!.length
    const positions = this.blockPositions(inode)
    const parts: Promise<void>[] = []
    for (let i = Math.floor(start / blockSize); i * blockSize < end; i++) {
      const blockStart = i * blockSize
      parts.push((async () => {
        let data: Uint8Array
        if (i < blocks) {
          data = await this.dataBlock(inode, i, positions, background)
        } else {
          // the end of the file is in a fragment block, shared with other small files
          const fragment = await this.fragmentBlock(inode.fragment!, background)
          data = fragment.subarray(inode.fragmentOffset!, inode.fragmentOffset! + inode.size - blockStart)
        }
        const from = Math.max(start, blockStart)
        const to = Math.min(end, blockStart + blockSize)
        out.set(data.subarray(from - blockStart, to - blockStart), from - start)
      })())
    }
    await Promise.all(parts)
    return out
  }

  /** A file in the image as a byte source, so that the Parquet and SQLite readers can read it in place. */
  fileSource(inode: Inode): ByteSource {
    return archiveFileSource(this, inode)
  }
}

/** Decompresses blocks; directories and inodes are compressed too, so other compressions can't be read at all. */
function decompressorFor(compression: string): (data: Uint8Array, maxSize: number) => Uint8Array {
  switch (compression) {
    case 'gzip':
      // zlib streams
      return data => zlib.inflateSync(data)
    case 'zstd':
      return (data, maxSize) => compressors.ZSTD!(data, maxSize)
    case 'lz4':
      return (data, maxSize) => lz4Block(data, maxSize)
    default:
      throw new Error(`this image is compressed with ${compression}, which Eyeball can't read (it reads gzip, zstd and lz4)`)
  }
}

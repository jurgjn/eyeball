// What the file system provider for archives and images (src/archive.ts) needs from a format: a
// tree of entries with paths, symbolic links in it followed, and the contents of its files.

import type { ByteSource } from './source'

export type EntryKind = 'directory' | 'file' | 'symlink' | 'other'

/** Errors with a code like those of Node's fs, so callers can map them. */
export class ArchiveError extends Error {
  constructor(readonly code: 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'ELOOP', message: string) {
    super(message)
  }
}

export interface ArchiveNode {
  kind: EntryKind
  /** Modification time, seconds since the epoch. */
  mtime: number
  /** File size. */
  size: number
}

export interface Archive {
  /** The node at a path (absolute within the archive, '/'-separated); see resolvePath. */
  lookup(path: string, followLast?: boolean): Promise<ArchiveNode>
  /** The entries of a directory, by name. */
  entries(dir: ArchiveNode): Promise<Map<string, { name: string; kind: EntryKind }>>
  /** Bytes [start, end) of a file. */
  read(file: ArchiveNode, start: number, end: number, background?: boolean): Promise<Uint8Array>
  /** A file as a byte source, so that the Parquet and SQLite readers can read it. */
  fileSource(file: ArchiveNode): ByteSource
}

/** Symbolic links followed in resolving one path, at most (as in Linux). */
const MAX_SYMLINKS = 40

/**
 * The node at a path (absolute within the archive, '/'-separated), given the root, the child of a
 * directory by name, and the target of a symbolic link. Symbolic links are followed in the
 * directories on the way, and at the end unless followLast is false; links to absolute paths
 * are taken to be relative to the root of the archive, as in a container.
 */
export async function resolvePath<N extends ArchiveNode>(
  root: N,
  path: string,
  followLast: boolean,
  child: (dir: N, name: string) => Promise<N | undefined>,
  target: (link: N) => Promise<string>,
): Promise<N> {
  let parents: N[] = []
  let current = root
  const pending = path.split('/').filter(Boolean).reverse()
  let links = 0
  while (pending.length) {
    const name = pending.pop()!
    if (name === '.') continue
    if (name === '..') {
      current = parents.pop() ?? root
      continue
    }
    if (current.kind !== 'directory') throw new ArchiveError('ENOTDIR', `${path}: not a directory`)
    const node = await child(current, name)
    if (!node) throw new ArchiveError('ENOENT', `${path}: no such file or directory`)
    if (node.kind === 'symlink' && (pending.length || followLast)) {
      if (++links > MAX_SYMLINKS) throw new ArchiveError('ELOOP', `${path}: too many levels of symbolic links`)
      const link = await target(node)
      if (link.startsWith('/')) {
        parents = []
        current = root
      }
      pending.push(...link.split('/').filter(Boolean).reverse())
      continue
    }
    parents.push(current)
    current = node
  }
  return current
}

/** A file in an archive as a byte source, read in place through the archive's read. */
export function archiveFileSource(archive: Archive, file: ArchiveNode): ByteSource {
  return {
    size: file.size,
    async read(start, end, background) {
      if (start < 0 || end > file.size || start > end) throw new RangeError(`read [${start}, ${end}) outside file of ${file.size} bytes`)
      return archive.read(file, start, end, background)
    },
    async close() {},
  }
}

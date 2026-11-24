import { ParquetFile } from './parquet'
import type { LruCache } from './lru'
import type { ByteSource } from './source'
import { SQLITE_MAGIC, SqliteFile } from './sqlite'
import type { TableFile } from './types'

/**
 * Open a Parquet file or SQLite database, detected from its contents.
 * openSibling opens a file next to it (the SQLite write-ahead log), if it exists.
 */
export async function openTableFile(
  source: ByteSource,
  cache: LruCache<unknown>,
  openSibling: (suffix: string) => Promise<ByteSource | undefined>,
): Promise<TableFile> {
  if (source.size >= 16) {
    const head = new TextDecoder().decode(await source.read(0, 16))
    if (head === SQLITE_MAGIC) return SqliteFile.open(source, cache, await openSibling('-wal'))
  }
  if (source.size >= 12) {
    const tail = new TextDecoder().decode(await source.read(source.size - 4, source.size))
    if (tail === 'PAR1' || tail === 'PARE') return ParquetFile.open(source, cache)
  }
  throw new Error('not a Parquet file or SQLite database')
}

import { promises as fs } from 'node:fs'

/** Random-access byte source for a Parquet file. */
export interface ByteSource {
  readonly size: number
  /** Read bytes [start, end). The result owns its ArrayBuffer (byteOffset 0). */
  read(start: number, end: number): Promise<Uint8Array>
  close(): Promise<void>
}

/** Reads a local file with positioned reads, so only the requested ranges are loaded. */
export async function openFileSource(path: string): Promise<ByteSource> {
  const handle = await fs.open(path, 'r')
  const { size } = await handle.stat()
  return {
    size,
    async read(start, end) {
      if (start < 0 || end > size || start > end) {
        throw new RangeError(`read [${start}, ${end}) outside file of ${size} bytes`)
      }
      const length = end - start
      // allocUnsafeSlow: not taken from Node's shared pool, so byteOffset is 0
      const buffer = Buffer.allocUnsafeSlow(length)
      let offset = 0
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset)
        if (bytesRead === 0) throw new Error(`unexpected end of file at byte ${start + offset}`)
        offset += bytesRead
      }
      return new Uint8Array(buffer.buffer, 0, length)
    },
    close: () => handle.close(),
  }
}

/** Wraps a file that has been read into memory (used for non-file URIs). */
export function memorySource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    async read(start, end) {
      if (start < 0 || end > bytes.byteLength || start > end) {
        throw new RangeError(`read [${start}, ${end}) outside file of ${bytes.byteLength} bytes`)
      }
      return bytes.slice(start, end)
    },
    async close() {},
  }
}

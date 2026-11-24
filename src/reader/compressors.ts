import { compressors as jsCompressors } from 'hyparquet-compressors'
import type { Compressors } from 'hyparquet'
import * as zlib from 'node:zlib'

// zstdDecompressSync is available from Node 22.15; older hosts fall back to the JS decoder
const zstdDecompressSync: ((input: Uint8Array) => Buffer) | undefined =
  (zlib as unknown as { zstdDecompressSync?: (input: Uint8Array) => Buffer }).zstdDecompressSync

/** Decompressors for Parquet pages, using Node's native zlib where it is available. */
export const compressors: Compressors = {
  ...jsCompressors,
  // the JS LZ4 decoders reject the single-token block that encodes an empty page
  LZ4: (input: Uint8Array, length: number) => length ? jsCompressors.LZ4!(input, length) : new Uint8Array(0),
  LZ4_RAW: (input: Uint8Array, length: number) => length ? jsCompressors.LZ4_RAW!(input, length) : new Uint8Array(0),
  // unzipSync accepts both gzip and zlib headers, and multi-member gzip streams
  GZIP: (input: Uint8Array) => zlib.unzipSync(input),
  BROTLI: (input: Uint8Array) => zlib.brotliDecompressSync(input),
  ZSTD: zstdDecompressSync ? (input: Uint8Array) => zstdDecompressSync(input) : jsCompressors.ZSTD,
}

import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'

/** Random-access byte source for a Parquet file or SQLite database. */
export interface ByteSource {
  readonly size: number
  /**
   * Read bytes [start, end). The result owns its ArrayBuffer (byteOffset 0). Background reads
   * (e.g. counting rows) start only when no foreground reads (what is on screen) are waiting.
   */
  read(start: number, end: number, background?: boolean): Promise<Uint8Array>
  close(): Promise<void>
}

export interface SourceOptions {
  /**
   * Reads to run at once. Node reads files on a pool of 4 threads, so more than
   * IN_PROCESS_READS are run in a helper process with a larger pool.
   */
  parallelReads?: number
}

export const DEFAULT_PARALLEL_READS = 64
const IN_PROCESS_READS = 4
/** Stop the helper process after it has had no open files for this long. */
const HELPER_IDLE_MS = 30_000

function checkRange(start: number, end: number, size: number): void {
  if (start < 0 || end > size || start > end) throw new RangeError(`read [${start}, ${end}) outside file of ${size} bytes`)
}

/** Runs tasks with at most `limit` at once; foreground tasks go first. */
class ReadQueue {
  private running = 0
  private readonly queues: (() => void)[][] = [[], []]
  private readonly heads = [0, 0]

  constructor(public limit: number) {}

  run<T>(task: () => Promise<T>, background = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[background ? 1 : 0].push(() => {
        this.running++
        task().then(resolve, reject).finally(() => {
          this.running--
          this.next()
        })
      })
      this.next()
    })
  }

  private next(): void {
    while (this.running < this.limit) {
      const start = this.take(0) ?? this.take(1)
      if (!start) return
      start()
    }
  }

  private take(level: number): (() => void) | undefined {
    const queue = this.queues[level]
    if (this.heads[level] >= queue.length) return undefined
    const task = queue[this.heads[level]++]
    if (this.heads[level] === queue.length) {
      queue.length = 0
      this.heads[level] = 0
    } else if (this.heads[level] > 4096) {
      queue.splice(0, this.heads[level])
      this.heads[level] = 0
    }
    return task
  }
}

async function readRange(handle: fs.FileHandle, start: number, end: number): Promise<Uint8Array> {
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
}

const localQueue = new ReadQueue(IN_PROCESS_READS)

/** Reads a local file in this process, with positioned reads, so only the requested ranges are loaded. */
async function openLocalSource(path: string, parallelReads: number): Promise<ByteSource> {
  localQueue.limit = Math.max(1, Math.min(parallelReads, IN_PROCESS_READS))
  const handle = await fs.open(path, 'r')
  const { size } = await handle.stat()
  return {
    size,
    async read(start, end, background) {
      checkRange(start, end, size)
      return localQueue.run(() => readRange(handle, start, end), background)
    },
    close: () => handle.close(),
  }
}

// The helper process: opens files and reads byte ranges for the extension. Node runs file reads
// on a pool of threads (4 by default, set by UV_THREADPOOL_SIZE when the process starts), and on
// network file systems each read waits for a round trip, so many reads at once are much faster.
const HELPER_SCRIPT = `
const fs = require('fs')
const files = new Map()
let nextHandle = 1
const fail = (id, error) => process.send({ id, error: String(error && error.message || error) })
function release(handle) {
  const file = files.get(handle)
  if (file && file.closed && !file.reads) {
    files.delete(handle)
    fs.close(file.fd, () => file.closed())
  }
}
process.on('message', m => {
  if (m.op === 'open') {
    fs.open(m.path, 'r', (error, fd) => {
      if (error) return fail(m.id, error)
      fs.fstat(fd, (error, stat) => {
        if (error) return fs.close(fd, () => fail(m.id, error))
        const handle = nextHandle++
        files.set(handle, { fd, reads: 0, closed: undefined })
        process.send({ id: m.id, handle, size: stat.size })
      })
    })
  } else if (m.op === 'read') {
    const file = files.get(m.handle)
    if (!file || file.closed) return fail(m.id, 'the file is closed')
    const bytes = new Uint8Array(m.length)
    file.reads++
    const done = error => {
      file.reads--
      if (error) fail(m.id, error)
      else process.send({ id: m.id, bytes })
      release(m.handle)
    }
    const step = offset => {
      if (offset === m.length) return done()
      fs.read(file.fd, bytes, offset, m.length - offset, m.start + offset, (error, n) => {
        if (error) return done(error)
        if (!n) return done('unexpected end of file at byte ' + (m.start + offset))
        step(offset + n)
      })
    }
    step(0)
  } else if (m.op === 'close') {
    const file = files.get(m.handle)
    if (!file) return process.send({ id: m.id })
    file.closed = () => process.send({ id: m.id })
    release(m.handle)
  }
})
process.on('disconnect', () => process.exit(0))
`

interface HelperReply {
  id: number
  error?: string
  handle?: number
  size?: number
  bytes?: Uint8Array
}

/** The helper process stopped, or could not be started. */
class HelperStopped extends Error {}

class ReadHelper {
  readonly queue: ReadQueue
  /** The helper could not be started; files are read in this process. */
  failed = false
  private child?: ChildProcess
  private started = false
  private readonly pending = new Map<number, { resolve(reply: HelperReply): void; reject(error: Error): void }>()
  private nextId = 1
  private openFiles = 0
  private idleTimer?: ReturnType<typeof setTimeout>

  constructor(private threads: number) {
    this.queue = new ReadQueue(threads)
  }

  setThreads(threads: number): void {
    // a running helper keeps its pool; the new size applies when it is restarted
    this.threads = threads
    this.queue.limit = threads
  }

  async open(path: string): Promise<{ handle: number; size: number }> {
    clearTimeout(this.idleTimer)
    try {
      const reply = await this.request({ op: 'open', path })
      this.openFiles++
      return { handle: reply.handle!, size: reply.size! }
    } finally {
      this.stopWhenIdle()
    }
  }

  async read(handle: number, start: number, end: number): Promise<Uint8Array> {
    const { bytes } = await this.request({ op: 'read', handle, start, length: end - start })
    // the result must own its ArrayBuffer
    return bytes!.byteOffset === 0 && bytes!.buffer.byteLength === bytes!.byteLength ? bytes! : bytes!.slice()
  }

  async close(handle: number): Promise<void> {
    try {
      await this.request({ op: 'close', handle })
    } catch (error) {
      if (!(error instanceof HelperStopped)) throw error
    } finally {
      this.openFiles--
      this.stopWhenIdle()
    }
  }

  private stopWhenIdle(): void {
    if (this.openFiles || !this.child) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), HELPER_IDLE_MS)
    this.idleTimer.unref?.()
  }

  stop(): void {
    const child = this.child
    this.child = undefined
    this.rejectAll('stopped')
    if (child?.connected) child.disconnect()
  }

  private request(message: object): Promise<HelperReply> {
    const child = this.child ?? this.start()
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      child.channel?.ref()
      try {
        child.send({ ...message, id })
      } catch (error) {
        this.pending.delete(id)
        reject(new HelperStopped(`Eyeball's read helper stopped (${error instanceof Error ? error.message : error})`))
      }
    })
  }

  private start(): ChildProcess {
    let child: ChildProcess
    try {
      child = spawn(process.execPath, ['-e', HELPER_SCRIPT], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        // ELECTRON_RUN_AS_NODE: in VS Code, execPath is Electron, which then runs as plain Node
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', UV_THREADPOOL_SIZE: String(this.threads) },
        windowsHide: true,
      })
    } catch (error) {
      this.failed = true
      throw new HelperStopped(`Eyeball's read helper could not be started (${error instanceof Error ? error.message : error})`)
    }
    this.child = child
    this.started = false
    child.unref()
    child.channel?.unref()
    child.on('message', (reply: HelperReply) => {
      this.started = true
      const request = this.pending.get(reply.id)
      if (!request) return
      this.pending.delete(reply.id)
      if (!this.pending.size) child.channel?.unref()
      if (reply.error !== undefined) request.reject(new Error(reply.error))
      else request.resolve(reply)
    })
    const stopped = (reason: string) => {
      if (this.child !== child) return
      this.child = undefined
      // a helper that never answered can't run here; don't try again
      if (!this.started) this.failed = true
      this.rejectAll(reason)
    }
    child.on('error', error => stopped(error.message))
    child.on('exit', (code, signal) => stopped(`exit ${signal ?? code}`))
    return child
  }

  private rejectAll(reason: string): void {
    for (const request of this.pending.values()) request.reject(new HelperStopped(`Eyeball's read helper stopped (${reason})`))
    this.pending.clear()
  }
}

let helper: ReadHelper | undefined

/** Reads through the helper process. If the helper stops, reading continues in this process. */
async function openHelperSource(path: string, threads: number): Promise<ByteSource> {
  helper ??= new ReadHelper(threads)
  helper.setThreads(threads)
  const reader = helper
  const { handle, size } = await reader.open(path)
  let local: Promise<fs.FileHandle> | undefined
  const openLocal = async () => {
    const file = await fs.open(path, 'r')
    if ((await file.stat()).size !== size) {
      await file.close()
      throw new Error('the file changed on disk')
    }
    return file
  }
  return {
    size,
    read(start, end, background) {
      checkRange(start, end, size)
      return reader.queue.run(async () => {
        if (!local) {
          try {
            return await reader.read(handle, start, end)
          } catch (error) {
            if (!(error instanceof HelperStopped)) throw error
            local ??= openLocal()
          }
        }
        return readRange(await local, start, end)
      }, background)
    },
    async close() {
      await reader.close(handle)
      if (local) await (await local).close()
    },
  }
}

/** Opens a local file for positioned reads, so only the requested ranges are loaded. */
export async function openFileSource(path: string, options: SourceOptions = {}): Promise<ByteSource> {
  const parallelReads = Math.max(1, Math.min(1024, Math.floor(options.parallelReads ?? DEFAULT_PARALLEL_READS)))
  if (parallelReads > IN_PROCESS_READS && !helper?.failed) {
    try {
      return await openHelperSource(path, parallelReads)
    } catch (error) {
      if (!(error instanceof HelperStopped)) throw error
    }
  }
  return openLocalSource(path, parallelReads)
}

/** Stops the helper process (it is restarted when needed). */
export function stopReadHelper(): void {
  helper?.stop()
}

/** Wraps a file that has been read into memory (used for non-file URIs). */
export function memorySource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    async read(start, end) {
      checkRange(start, end, bytes.byteLength)
      return bytes.slice(start, end)
    },
    async close() {},
  }
}

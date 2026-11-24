import type { BlockRequest, CellText, HostMessage, WebviewMessage } from '../src/protocol'

/** Cached values of one column for one block of rows, or the error that prevented loading them. */
export type Entry = CellText[] | { error: string }

const BUDGET_CHARS = 60_000_000
/** Resend requests that are still unanswered after this long (the host drops superseded requests). */
const RETRY_MS = 1500

/** Block cache of display values, and the requests that fill it. */
export class DataStore {
  private entries = new Map<string, { entry: Entry; size: number }>()
  private total = 0
  private lastRequest = ''
  private lastSent = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  /** Increments whenever data arrives. */
  version = 0
  /** Visible blocks are still loading. */
  loading = false

  constructor(private readonly post: (msg: WebviewMessage) => void, private readonly onRetry: () => void) {}

  reset(): void {
    this.entries.clear()
    this.total = 0
    this.lastRequest = ''
    this.loading = false
    clearTimeout(this.retryTimer)
    this.version++
  }

  get(block: number, col: number): Entry | undefined {
    return this.entries.get(`${block}:${col}`)?.entry
  }

  receive(msg: Extract<HostMessage, { type: 'data' }>): void {
    msg.cols.forEach((col, i) => this.put(`${msg.block}:${col}`, msg.values[i]))
    for (const [col, error] of Object.entries(msg.errors ?? {})) this.put(`${msg.block}:${col}`, { error })
    this.version++
  }

  private put(key: string, entry: Entry): void {
    const old = this.entries.get(key)
    if (old) this.total -= old.size
    let size = 64
    if (Array.isArray(entry)) for (const text of entry) size += 8 + (text ? text.length : 0)
    this.entries.delete(key)
    this.entries.set(key, { entry, size })
    this.total += size
    for (const [k, v] of this.entries) {
      if (this.total <= BUDGET_CHARS) break
      this.entries.delete(k)
      this.total -= v.size
    }
  }

  /**
   * Request missing data: first the visible blocks x visible columns, then the
   * surrounding blocks and columns. Repeated calls with the same need are cheap.
   */
  want(blocks: number[], cols: number[], moreBlocks: number[], moreCols: number[]): void {
    const requests: BlockRequest[] = []
    this.loading = false
    for (const block of blocks) {
      const missing: number[] = []
      for (const col of cols) {
        const key = `${block}:${col}`
        const hit = this.entries.get(key)
        if (hit) {
          // keep visible entries fresh in the LRU order
          this.entries.delete(key)
          this.entries.set(key, hit)
        } else {
          missing.push(col)
        }
      }
      if (missing.length) {
        requests.push({ block, cols: missing })
        this.loading = true
      }
    }
    const allCols = [...cols, ...moreCols]
    for (const block of [...blocks, ...moreBlocks]) {
      const extra = (blocks.includes(block) ? moreCols : allCols).filter(col => !this.entries.has(`${block}:${col}`))
      if (extra.length) requests.push({ block, cols: extra })
    }
    const signature = JSON.stringify(requests)
    const now = Date.now()
    if (signature !== this.lastRequest || (requests.length && now - this.lastSent >= RETRY_MS)) {
      this.post({ type: 'fetch', requests })
      this.lastRequest = signature
      this.lastSent = now
    }
    clearTimeout(this.retryTimer)
    if (requests.length) this.retryTimer = setTimeout(this.onRetry, RETRY_MS + 100)
  }
}

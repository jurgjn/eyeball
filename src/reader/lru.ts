/** Least-recently-used cache bounded by the total (estimated) size of its entries. */
export class LruCache<V> {
  private entries = new Map<string, { value: V; size: number }>()
  private total = 0

  constructor(public budget: number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    // move to most recently used
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: V, size: number): void {
    this.delete(key)
    this.entries.set(key, { value, size })
    this.total += size
    this.evict()
  }

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (entry) {
      this.total -= entry.size
      this.entries.delete(key)
    }
  }

  /** Delete all entries whose key starts with prefix. */
  deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.delete(key)
    }
  }

  setBudget(budget: number): void {
    this.budget = budget
    this.evict()
  }

  get size(): number {
    return this.total
  }

  private evict(): void {
    // keep at least the newest entry, even if it alone exceeds the budget
    for (const key of this.entries.keys()) {
      if (this.total <= this.budget || this.entries.size <= 1) break
      this.delete(key)
    }
  }
}

/** Rough estimate of the memory used by a decoded value or array, in bytes. */
export function estimateSize(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 8
  switch (typeof value) {
    case 'number': return 8
    case 'boolean': return 8
    case 'bigint': return 32
    case 'string': return 24 + value.length * 2
    case 'object': break
    default: return 16
  }
  if (ArrayBuffer.isView(value)) return 64 + value.byteLength
  if (depth > 6) return 64
  if (Array.isArray(value)) {
    const n = value.length
    if (n === 0) return 32
    // sample up to 32 evenly spaced elements
    const step = Math.max(1, Math.floor(n / 32))
    let sampled = 0
    let count = 0
    for (let i = 0; i < n; i += step) {
      sampled += estimateSize(value[i], depth + 1)
      count++
    }
    return 32 + 8 * n + (sampled / count) * n
  }
  let size = 64
  let keys = 0
  for (const key in value as Record<string, unknown>) {
    size += 16 + estimateSize((value as Record<string, unknown>)[key], depth + 1)
    if (++keys > 64) break
  }
  return size
}

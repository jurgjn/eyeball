// Converts decoded Parquet values to text for display, the detail panel and the clipboard.

/** How to format the values of one top-level column, beyond what the value's JS type says. */
export type ValueFormat =
  | { kind: 'generic' }
  | { kind: 'float32' }
  | { kind: 'float16' }
  /** Raw unscaled integers (number, bigint or big-endian bytes) with a decimal scale. */
  | { kind: 'decimal'; scale: number }
  /** Time of day as an integer count of 10^-digits seconds. */
  | { kind: 'time'; digits: number }
  /** 12-byte Parquet INTERVAL. */
  | { kind: 'interval' }

/**
 * A value whose text is computed only when it is displayed. Pages can hold 100k+ values, of
 * which only a screenful is shown, so dates, timestamps and UUIDs are formatted lazily.
 */
export abstract class Deferred {
  abstract toString(): string
}

export class TimestampValue extends Deferred {
  constructor(readonly value: bigint, readonly digits: number) {
    super()
  }

  toString(): string {
    return formatTimestamp(this.value, this.digits)
  }
}

export class DateValue extends Deferred {
  constructor(readonly days: number) {
    super()
  }

  toString(): string {
    return formatDate(this.days)
  }
}

export class UuidValue extends Deferred {
  constructor(readonly bytes: Uint8Array) {
    super()
  }

  toString(): string {
    let hex = ''
    for (const byte of this.bytes) hex += byte.toString(16).padStart(2, '0')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}

const GENERIC: ValueFormat = { kind: 'generic' }
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
// C0 control characters other than tab, newline and carriage return
const BINARY_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/
const DISPLAY_CONTROL = /[\x00-\x1f\x7f]/g
const TRUNCATED = Symbol('truncated')

/** Single-line text for a grid cell, at most maxChars long (plus an ellipsis). Null for null values. */
export function formatDisplay(value: unknown, format: ValueFormat = GENERIC, maxChars = 300): string | null {
  if (value === null || value === undefined) return null
  let text = isComplex(value) ? toJson(value, false, maxChars) : formatScalar(value, format, maxChars)
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…'
  return text.replace(DISPLAY_CONTROL, c => c === '\n' ? '↵' : c === '\t' ? '⇥' : c === '\r' ? '' : '·')
}

/** Full text for the detail panel; nested values are pretty-printed. */
export function formatFull(value: unknown, format: ValueFormat = GENERIC, maxChars = 5_000_000): string {
  if (value === null || value === undefined) return 'null'
  return isComplex(value) ? toJson(value, true, maxChars) : formatScalar(value, format, maxChars)
}

/** Full single-line text for copying; nested values as compact JSON. Null for null values. */
export function formatCopy(value: unknown, format: ValueFormat = GENERIC): string | null {
  if (value === null || value === undefined) return null
  return isComplex(value) ? toJson(value, false, 10_000_000) : formatScalar(value, format, 10_000_000)
}

function isComplex(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && !(value instanceof Date) &&
    !(value instanceof Deferred)
}

function formatScalar(value: unknown, format: ValueFormat, maxChars: number): string {
  switch (format.kind) {
    case 'float32':
      if (typeof value === 'number') return formatFloat32(value)
      break
    case 'float16':
      if (typeof value === 'number') return formatFloat16(value)
      break
    case 'decimal': {
      const unscaled = toBigInt(value)
      if (unscaled !== undefined) return formatDecimal(unscaled, format.scale)
      break
    }
    case 'time':
      if (typeof value === 'number' || typeof value === 'bigint') return formatTime(value, format.digits)
      break
    case 'interval':
      if (value instanceof Uint8Array && value.length === 12) {
        const view = new DataView(value.buffer, value.byteOffset, 12)
        return `${view.getUint32(0, true)} months ${view.getUint32(4, true)} days ${view.getUint32(8, true)} ms`
      }
      break
  }
  return formatGeneric(value, maxChars)
}

function formatGeneric(value: unknown, maxChars: number): string {
  switch (typeof value) {
    case 'string': return value
    case 'number': return String(value)
    case 'bigint': return value.toString()
    case 'boolean': return value ? 'true' : 'false'
  }
  if (value instanceof Deferred) return value.toString()
  if (value instanceof Uint8Array) return bytesToText(value, maxChars)
  if (value instanceof Date) return isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  return String(value)
}

/** Bytes as text if they are valid UTF-8 without control characters, otherwise as hex. */
export function bytesToText(bytes: Uint8Array, maxChars = Infinity): string {
  try {
    const text = utf8.decode(bytes)
    if (!BINARY_CONTROL.test(text)) return text
  } catch {
    // not UTF-8
  }
  const n = Math.min(bytes.length, Math.max(1, Math.floor((maxChars - 2) / 2)))
  let hex = '0x'
  for (let i = 0; i < n; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return n < bytes.length ? hex + '…' : hex
}

/** Shortest decimal representation that round-trips to the same float32. */
export function formatFloat32(value: number): string {
  if (!Number.isFinite(value) || value === 0) return String(value)
  for (let precision = 1; precision <= 9; precision++) {
    const candidate = Number(value.toPrecision(precision))
    if (Math.fround(candidate) === value) return String(candidate)
  }
  return String(value)
}

const f16round: ((x: number) => number) | undefined = (Math as unknown as { f16round?: (x: number) => number }).f16round

function formatFloat16(value: number): string {
  if (!Number.isFinite(value) || value === 0) return String(value)
  for (let precision = 1; precision <= 5; precision++) {
    const candidate = Number(value.toPrecision(precision))
    if (f16round ? f16round(candidate) === value : Math.abs(candidate - value) <= Math.abs(value) * 2 ** -11) {
      return String(candidate)
    }
  }
  return String(value)
}

function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  if (value instanceof Uint8Array) {
    // big-endian two's complement
    let result = 0n
    for (const byte of value) result = result << 8n | BigInt(byte)
    if (value.length && value[0] & 0x80) result -= 1n << BigInt(value.length * 8)
    return result
  }
  return undefined
}

export function formatDecimal(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n
  let digits = (negative ? -unscaled : unscaled).toString()
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0')
    digits = digits.slice(0, -scale) + '.' + digits.slice(-scale)
  } else if (scale < 0) {
    digits += '0'.repeat(-scale)
  }
  return negative ? '-' + digits : digits
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Splits an integer count of 10^-digits seconds into whole seconds and a non-negative fraction. */
function splitSeconds(value: bigint, digits: number): [bigint, bigint] {
  const perSecond = 10n ** BigInt(digits)
  let seconds = value / perSecond
  let fraction = value % perSecond
  if (fraction < 0n) {
    fraction += perSecond
    seconds -= 1n
  }
  return [seconds, fraction]
}

/** ".fraction" with trailing zeros removed in groups of three (milli/micro/nano), or "" if zero. */
function fractionText(fraction: bigint, digits: number): string {
  if (!fraction) return ''
  let text = fraction.toString().padStart(digits, '0')
  while (text.length > 3 && text.endsWith('000')) text = text.slice(0, -3)
  return '.' + text
}

export function formatTime(value: number | bigint, digits: number): string {
  const [seconds, fraction] = splitSeconds(BigInt(value), digits)
  const s = Number(seconds)
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}${fractionText(fraction, digits)}`
}

/** "YYYY-MM-DD HH:MM:SS[.fraction]" in UTC. */
export function formatTimestamp(value: bigint, digits: number): string {
  const [seconds, fraction] = splitSeconds(value, digits)
  const millis = Number(seconds) * 1000
  if (!(Math.abs(millis) <= 8.64e15)) return `${value} (out of range)`
  const date = new Date(millis)
  return `${formatYmd(date)} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}${fractionText(fraction, digits)}`
}

export function formatDate(days: number): string {
  const millis = days * 86400000
  if (!(Math.abs(millis) <= 8.64e15)) return `${days} (out of range)`
  return formatYmd(new Date(millis))
}

function formatYmd(date: Date): string {
  const year = date.getUTCFullYear()
  const y = year >= 0 && year <= 9999 ? String(year).padStart(4, '0') : String(year)
  return `${y}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/**
 * JSON-like text for nested values. Unlike JSON.stringify this handles bigint,
 * bytes and typed arrays, keeps NaN/Infinity, and stops after maxChars.
 * Pretty output puts arrays of scalars on one line and everything else one item per line.
 */
export function toJson(value: unknown, pretty: boolean, maxChars: number): string {
  let out = ''
  const write = (text: string) => {
    out += text
    if (out.length > maxChars) throw TRUNCATED
  }
  const isScalar = (v: unknown) => v === null || typeof v !== 'object' || v instanceof Uint8Array || v instanceof Date ||
    v instanceof Deferred

  const visit = (v: unknown, indent: string): void => {
    if (v === null || v === undefined) return write('null')
    switch (typeof v) {
      case 'string': return write(JSON.stringify(v))
      case 'number': return write(String(v))
      case 'bigint': return write(v.toString())
      case 'boolean': return write(v ? 'true' : 'false')
    }
    if (v instanceof Deferred) return write(JSON.stringify(v.toString()))
    if (v instanceof Uint8Array) return write(JSON.stringify(bytesToText(v, 2048)))
    if (v instanceof Date) return write(JSON.stringify(formatGeneric(v, maxChars)))
    const inner = indent + '  '
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      const items = v as ArrayLike<unknown>
      if (!items.length) return write('[]')
      let multiline = false
      if (pretty) {
        for (let i = 0; i < items.length; i++) {
          if (!isScalar(items[i])) {
            multiline = true
            break
          }
        }
      }
      write('[')
      for (let i = 0; i < items.length; i++) {
        if (i) write(multiline ? ',' : ', ')
        if (multiline) write('\n' + inner)
        visit(items[i], inner)
      }
      return write(multiline ? '\n' + indent + ']' : ']')
    }
    const keys = Object.keys(v as object)
    if (!keys.length) return write('{}')
    write('{')
    keys.forEach((key, i) => {
      if (i) write(pretty ? ',' : ', ')
      if (pretty) write('\n' + inner)
      write(JSON.stringify(key) + ': ')
      visit((v as Record<string, unknown>)[key], inner)
    })
    write(pretty ? '\n' + indent + '}' : '}')
  }

  try {
    visit(value, '')
  } catch (error) {
    if (error !== TRUNCATED) throw error
    out = out.slice(0, maxChars) + '…'
  }
  return out
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit++
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0)} ${units[unit]}`
}

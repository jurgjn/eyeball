import type { SchemaElement, SchemaTree } from 'hyparquet'
import type { ValueFormat } from './format'

const UNIT_LABEL = { MILLIS: 'ms', MICROS: 'us', NANOS: 'ns' } as const
const UNIT_DIGITS = { MILLIS: 3, MICROS: 6, NANOS: 9 } as const

/** Short type label for a top-level column, e.g. "int64", "list<string>", "timestamp[us, UTC]". */
export function typeLabel(node: SchemaTree, maxLength = 120): string {
  const label = nodeLabel(node)
  return label.length > maxLength ? label.slice(0, maxLength - 1) + '…' : label
}

function nodeLabel(node: SchemaTree, ignoreRepetition = false): string {
  const { element, children } = node
  const ltype = element.logical_type
  const ctype = element.converted_type
  let label: string
  if (!children.length) {
    label = primitiveLabel(element)
  } else if (ltype?.type === 'VARIANT') {
    label = 'variant'
  } else if ((ctype === 'LIST' || ltype?.type === 'LIST') && children.length === 1) {
    // standard 3-level list (list > repeated group > element) or legacy 2-level list
    const repeated = children[0]
    const item = repeated.children.length === 1 ? repeated.children[0] : repeated
    label = `list<${nodeLabel(item, true)}>`
  } else if ((ctype === 'MAP' || ctype === 'MAP_KEY_VALUE' || ltype?.type === 'MAP') && children.length === 1 &&
    children[0].children.length === 2) {
    const [key, value] = children[0].children
    label = `map<${nodeLabel(key)}, ${nodeLabel(value)}>`
  } else {
    label = `struct<${children.map(child => `${child.element.name}: ${nodeLabel(child)}`).join(', ')}>`
  }
  // a repeated field outside a LIST annotation is a legacy list
  if (element.repetition_type === 'REPEATED' && !ignoreRepetition) label = `list<${label}>`
  return label
}

function primitiveLabel(element: SchemaElement): string {
  const ltype = element.logical_type
  const ctype = element.converted_type
  switch (ltype?.type) {
    case 'STRING': return 'string'
    case 'ENUM': return 'enum'
    case 'JSON': return 'json'
    case 'BSON': return 'bson'
    case 'UUID': return 'uuid'
    case 'FLOAT16': return 'float16'
    case 'DATE': return 'date'
    case 'INTERVAL': return 'interval'
    case 'NULL': return 'null'
    case 'GEOMETRY': return 'geometry'
    case 'GEOGRAPHY': return 'geography'
    case 'DECIMAL': return `decimal(${ltype.precision},${ltype.scale})`
    case 'INTEGER': return `${ltype.isSigned ? 'int' : 'uint'}${ltype.bitWidth}`
    case 'TIME': return `time[${UNIT_LABEL[ltype.unit]}${ltype.isAdjustedToUTC ? ', UTC' : ''}]`
    case 'TIMESTAMP': return `timestamp[${UNIT_LABEL[ltype.unit]}${ltype.isAdjustedToUTC ? ', UTC' : ''}]`
  }
  switch (ctype) {
    case 'UTF8': return 'string'
    case 'ENUM': return 'enum'
    case 'JSON': return 'json'
    case 'BSON': return 'bson'
    case 'DATE': return 'date'
    case 'INTERVAL': return 'interval'
    case 'DECIMAL': return `decimal(${element.precision},${element.scale ?? 0})`
    case 'TIME_MILLIS': return 'time[ms]'
    case 'TIME_MICROS': return 'time[us]'
    case 'TIMESTAMP_MILLIS': return 'timestamp[ms, UTC]'
    case 'TIMESTAMP_MICROS': return 'timestamp[us, UTC]'
    case 'UINT_8': return 'uint8'
    case 'UINT_16': return 'uint16'
    case 'UINT_32': return 'uint32'
    case 'UINT_64': return 'uint64'
    case 'INT_8': return 'int8'
    case 'INT_16': return 'int16'
    case 'INT_32': return 'int32'
    case 'INT_64': return 'int64'
  }
  switch (element.type) {
    case 'BOOLEAN': return 'bool'
    case 'INT32': return 'int32'
    case 'INT64': return 'int64'
    case 'INT96': return 'timestamp[ns] (int96)'
    case 'FLOAT': return 'float32'
    case 'DOUBLE': return 'float64'
    case 'BYTE_ARRAY': return 'binary'
    case 'FIXED_LEN_BYTE_ARRAY': return `fixed_binary[${element.type_length}]`
  }
  return String(element.type ?? 'unknown')
}

/** True for columns whose values should be right-aligned. */
export function isNumeric(node: SchemaTree): boolean {
  if (node.children.length || node.element.repetition_type === 'REPEATED') return false
  const { element } = node
  const ltype = element.logical_type?.type
  if (ltype === 'DECIMAL' || ltype === 'INTEGER' || ltype === 'FLOAT16') return true
  if (ltype || element.converted_type) {
    return element.converted_type === 'DECIMAL' || /^U?INT_/.test(element.converted_type ?? '')
  }
  return element.type === 'INT32' || element.type === 'INT64' || element.type === 'FLOAT' || element.type === 'DOUBLE'
}

function decimalScale(element: SchemaElement): number | undefined {
  if (element.logical_type?.type === 'DECIMAL') return element.logical_type.scale
  if (element.converted_type === 'DECIMAL') return element.scale ?? 0
  return undefined
}

/**
 * How to decode one leaf column. Some types are decoded raw (by hiding their annotation from
 * hyparquet) and formatted by us instead: decimals of top-level columns (to keep full precision),
 * unannotated byte arrays (to show non-UTF-8 data as hex), and intervals/BSON (unsupported by hyparquet).
 */
export function leafDecoding(element: SchemaElement, topLevel: boolean): { element: SchemaElement; utf8: boolean } {
  const ltype = element.logical_type?.type
  const ctype = element.converted_type
  const raw = ctype === 'INTERVAL' || ltype === 'INTERVAL' || ctype === 'BSON' || ltype === 'BSON' ||
    topLevel && decimalScale(element) !== undefined
  const patched = raw ? { ...element, converted_type: undefined, logical_type: undefined } : element
  return { element: patched, utf8: false }
}

/** Value format of a top-level column (generic for nested columns). */
export function valueFormat(node: SchemaTree): ValueFormat {
  if (node.children.length || node.element.repetition_type === 'REPEATED') return { kind: 'generic' }
  const { element } = node
  const scale = decimalScale(element)
  if (scale !== undefined) return { kind: 'decimal', scale }
  const ltype = element.logical_type
  if (ltype?.type === 'TIME') return { kind: 'time', digits: UNIT_DIGITS[ltype.unit] }
  if (element.converted_type === 'TIME_MILLIS') return { kind: 'time', digits: 3 }
  if (element.converted_type === 'TIME_MICROS') return { kind: 'time', digits: 6 }
  if (ltype?.type === 'INTERVAL' || element.converted_type === 'INTERVAL') return { kind: 'interval' }
  if (ltype?.type === 'FLOAT16') return { kind: 'float16' }
  if (element.type === 'FLOAT') return { kind: 'float32' }
  return { kind: 'generic' }
}

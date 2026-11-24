// Parses SQLite CREATE TABLE statements for what a reader needs: column names, declared
// types, the primary key, literal defaults and generated columns.

export type Affinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC'

export interface SqlColumn {
  name: string
  /** Declared type as written, '' if none. */
  type: string
  affinity: Affinity
  notNull: boolean
  /** Declared as a column constraint `PRIMARY KEY DESC` (which is not a rowid alias). */
  pkDesc: boolean
  /** The DEFAULT clause as written. */
  defaultText?: string
  /** Value of a literal DEFAULT, used for rows written before `ALTER TABLE ADD COLUMN`. */
  defaultValue?: unknown
  collate?: string
  generated?: 'virtual' | 'stored'
}

export interface SqlTable {
  name: string
  columns: SqlColumn[]
  /** Primary key column names, in key order. */
  primaryKey: string[]
  withoutRowid: boolean
  strict: boolean
}

interface Token {
  kind: 'id' | 'qid' | 'str' | 'num' | 'blob' | 'punct' | 'op'
  text: string
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = sql.length
  const quoted = (close: string): string => {
    let value = ''
    i++
    while (i < n) {
      if (sql[i] === close) {
        if (sql[i + 1] === close && close !== ']') {
          value += close
          i += 2
          continue
        }
        i++
        return value
      }
      value += sql[i++]
    }
    return value
  }
  while (i < n) {
    const c = sql[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else if (c === "'") {
      tokens.push({ kind: 'str', text: quoted("'") })
    } else if (c === '"' || c === '`') {
      tokens.push({ kind: 'qid', text: quoted(c) })
    } else if (c === '[') {
      tokens.push({ kind: 'qid', text: quoted(']') })
    } else if ((c === 'x' || c === 'X') && sql[i + 1] === "'") {
      i++
      tokens.push({ kind: 'blob', text: quoted("'") })
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^(0x[0-9a-f]+|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)/i.exec(sql.slice(i))!
      tokens.push({ kind: 'num', text: m[0] })
      i += m[0].length
    } else if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      const m = /^[\w$\u0080-\uffff]+/.exec(sql.slice(i))!
      tokens.push({ kind: 'id', text: m[0] })
      i += m[0].length
    } else if ('(),;.'.includes(c)) {
      tokens.push({ kind: 'punct', text: c })
      i++
    } else {
      tokens.push({ kind: 'op', text: c })
      i++
    }
  }
  return tokens
}

/** Type affinity of a declared type (https://www.sqlite.org/datatype3.html#determination_of_column_affinity). */
export function affinity(type: string): Affinity {
  const t = type.toUpperCase()
  if (t.includes('INT')) return 'INTEGER'
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT'
  if (t.includes('BLOB') || !t) return 'BLOB'
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

const COLUMN_CONSTRAINTS = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS'])
const TABLE_CONSTRAINTS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'])

export function parseCreateTable(sql: string): SqlTable {
  const tokens = tokenize(sql)
  let p = 0
  const peek = (k = 0) => tokens[p + k]
  const isWord = (t: Token | undefined, ...words: string[]) => !!t && t.kind === 'id' && words.includes(t.text.toUpperCase())
  const expectWord = (...words: string[]) => {
    if (!isWord(peek(), ...words)) throw new Error(`expected ${words.join('/')} in: ${sql.slice(0, 200)}`)
    p++
  }
  const isPunct = (t: Token | undefined, text: string) => !!t && t.kind === 'punct' && t.text === text
  /** Index just after the parenthesised group starting at i. */
  const skipGroup = (list: Token[], i: number): number => {
    let depth = 0
    for (; i < list.length; i++) {
      if (isPunct(list[i], '(')) depth++
      else if (isPunct(list[i], ')') && --depth === 0) return i + 1
    }
    return i
  }

  expectWord('CREATE')
  if (isWord(peek(), 'TEMP', 'TEMPORARY')) p++
  expectWord('TABLE')
  if (isWord(peek(), 'IF')) p += 3 // IF NOT EXISTS
  let name = peek().text
  p++
  if (isPunct(peek(), '.')) {
    name = peek(1).text
    p += 2
  }
  const table: SqlTable = { name, columns: [], primaryKey: [], withoutRowid: false, strict: false }
  if (!isPunct(peek(), '(')) return table // CREATE TABLE ... AS SELECT: columns unknown

  // split the definitions at top-level commas
  const end = skipGroup(tokens, p)
  const elements: Token[][] = [[]]
  let depth = 0
  for (let i = p + 1; i < end - 1; i++) {
    const t = tokens[i]
    if (isPunct(t, '(')) depth++
    if (isPunct(t, ')')) depth--
    if (depth === 0 && isPunct(t, ',')) elements.push([])
    else elements[elements.length - 1].push(t)
  }
  // table options
  for (let i = end; i < tokens.length; i++) {
    if (isWord(tokens[i], 'WITHOUT') && isWord(tokens[i + 1], 'ROWID')) table.withoutRowid = true
    if (isWord(tokens[i], 'STRICT')) table.strict = true
  }

  for (const element of elements) {
    if (!element.length) continue
    if (element[0].kind === 'id' && TABLE_CONSTRAINTS.has(element[0].text.toUpperCase())) {
      parseTableConstraint(element)
    } else {
      table.columns.push(parseColumn(element))
    }
  }
  return table

  function parseTableConstraint(element: Token[]): void {
    let i = 0
    if (isWord(element[i], 'CONSTRAINT')) i += 2
    if (!(isWord(element[i], 'PRIMARY') && isWord(element[i + 1], 'KEY'))) return
    i += 2
    // indexed columns: name [COLLATE x] [ASC|DESC], ...
    const groupEnd = skipGroup(element, i)
    let expectName = true
    let level = 0
    for (let k = i + 1; k < groupEnd - 1; k++) {
      const t = element[k]
      if (isPunct(t, '(')) level++
      else if (isPunct(t, ')')) level--
      else if (level === 0 && isPunct(t, ',')) expectName = true
      else if (level === 0 && expectName && (t.kind === 'id' || t.kind === 'qid' || t.kind === 'str')) {
        table.primaryKey.push(t.text)
        expectName = false
      }
    }
  }

  function parseColumn(element: Token[]): SqlColumn {
    const column: SqlColumn = { name: element[0].text, type: '', affinity: 'BLOB', notNull: false, pkDesc: false }
    let i = 1
    // the type: identifiers up to the first constraint keyword, optionally followed by (n) or (n, m)
    const typeWords: string[] = []
    while (i < element.length && element[i].kind === 'id' && !COLUMN_CONSTRAINTS.has(element[i].text.toUpperCase())) {
      typeWords.push(element[i].text)
      i++
    }
    let type = typeWords.join(' ')
    if (typeWords.length && isPunct(element[i], '(')) {
      const groupEnd = skipGroup(element, i)
      type += '(' + element.slice(i + 1, groupEnd - 1).map(t => t.text).join('').replace(/,/g, ', ') + ')'
      i = groupEnd
    }
    column.type = type
    column.affinity = affinity(type)

    while (i < element.length) {
      const t = element[i]
      const word = t.kind === 'id' ? t.text.toUpperCase() : ''
      if (word === 'CONSTRAINT') {
        i += 2
      } else if (word === 'PRIMARY') {
        i += 2 // PRIMARY KEY
        if (isWord(element[i], 'DESC')) column.pkDesc = true
        table.primaryKey.push(column.name)
      } else if (word === 'NOT' && isWord(element[i + 1], 'NULL')) {
        column.notNull = true
        i += 2
      } else if (word === 'CHECK') {
        i = skipGroup(element, i + 1)
      } else if (word === 'DEFAULT') {
        i = parseDefault(element, i + 1, column)
      } else if (word === 'COLLATE') {
        column.collate = element[i + 1]?.text
        i += 2
      } else if (word === 'REFERENCES') {
        i = skipForeignKey(element, i + 1)
      } else if (word === 'GENERATED' || word === 'AS') {
        while (i < element.length && !isPunct(element[i], '(')) i++
        i = skipGroup(element, i)
        column.generated = isWord(element[i], 'STORED') ? 'stored' : 'virtual'
      } else {
        i++
      }
    }
    return column
  }

  function parseDefault(element: Token[], i: number, column: SqlColumn): number {
    const t = element[i]
    if (!t) return i
    if (isPunct(t, '(')) {
      const groupEnd = skipGroup(element, i)
      column.defaultText = element.slice(i, groupEnd).map(x => x.text).join(' ')
      return groupEnd
    }
    let sign = 1
    if (t.kind === 'op' && (t.text === '-' || t.text === '+')) {
      if (t.text === '-') sign = -1
      i++
    }
    const v = element[i]
    if (!v) return i
    if (v.kind === 'num') {
      const number = v.text.toLowerCase().startsWith('0x') ? parseInt(v.text, 16) : Number(v.text)
      column.defaultValue = sign * number
      column.defaultText = (sign < 0 ? '-' : '') + v.text
    } else if (v.kind === 'str') {
      column.defaultValue = v.text
      column.defaultText = `'${v.text.replace(/'/g, "''")}'`
    } else if (v.kind === 'blob') {
      column.defaultValue = Uint8Array.from(v.text.match(/../g) ?? [], h => parseInt(h, 16))
      column.defaultText = `X'${v.text}'`
    } else if (isWord(v, 'NULL')) {
      column.defaultValue = null
      column.defaultText = 'NULL'
    } else if (isWord(v, 'TRUE', 'FALSE')) {
      column.defaultValue = v.text.toUpperCase() === 'TRUE' ? 1 : 0
      column.defaultText = v.text
    } else {
      column.defaultText = v.text // CURRENT_TIMESTAMP etc.
    }
    return i + 1
  }

  function skipForeignKey(element: Token[], i: number): number {
    i++ // referenced table
    if (isPunct(element[i], '(')) i = skipGroup(element, i)
    for (;;) {
      if (isWord(element[i], 'ON')) {
        i += 2 // ON DELETE / ON UPDATE
        if (isWord(element[i], 'SET')) i += 2
        else if (isWord(element[i], 'NO')) i += 2
        else i++
      } else if (isWord(element[i], 'MATCH')) {
        i += 2
      } else if (isWord(element[i], 'NOT') && isWord(element[i + 1], 'DEFERRABLE')) {
        i += 2
      } else if (isWord(element[i], 'DEFERRABLE')) {
        i++
        if (isWord(element[i], 'INITIALLY')) i += 2
      } else {
        return i
      }
    }
  }
}

/** The column that aliases the rowid (`INTEGER PRIMARY KEY`), or -1. */
export function rowidAlias(table: SqlTable): number {
  if (table.withoutRowid || table.primaryKey.length !== 1) return -1
  const index = table.columns.findIndex(c => c.name.toLowerCase() === table.primaryKey[0].toLowerCase())
  if (index < 0) return -1
  const column = table.columns[index]
  return column.type.toUpperCase() === 'INTEGER' && !column.pkDesc ? index : -1
}

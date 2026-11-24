// Checks the readers against values written by test/fixtures/make_fixtures.py and make_sqlite_fixtures.py.
//
// Usage: node test/check.mjs [DATA_DIR] [--perf]
//   DATA_DIR defaults to /tmp/eyeball-data. Every *.parquet, *.sqlite or *.db with a
//   matching .expected.json is checked; --perf also times random access on large files.
import * as esbuild from 'esbuild'
import { readdirSync, readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dataDir = args.find(a => !a.startsWith('--')) ?? '/tmp/eyeball-data'
const perf = args.includes('--perf')

const outDir = mkdtempSync(join(tmpdir(), 'eyeball-test-'))
await esbuild.build({
  entryPoints: [new URL('./reader-entry.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(outDir, 'reader.cjs'),
  logLevel: 'warning',
})
const { openTableFile, openFileSource, LruCache } = createRequire(import.meta.url)(join(outDir, 'reader.cjs'))

/** Open a Parquet file or SQLite database (with its -wal file, if any). */
async function openFile(path, cache) {
  const sibling = async suffix => existsSync(path + suffix) ? openFileSource(path + suffix) : undefined
  return openTableFile(await openFileSource(path), cache, sibling)
}

/** Open a table and wait until its rows are counted. */
async function openTable(file, name) {
  const table = await file.openTable(name ?? file.defaultTable)
  while (table.counting) await new Promise(resolve => setTimeout(resolve, 20))
  return table
}

const cache = new LruCache(512 * 2 ** 20)
let failures = 0

function pyFloat(repr) {
  if (repr === 'nan') return NaN
  if (repr === 'inf') return Infinity
  if (repr === '-inf') return -Infinity
  return Number(repr)
}

function sameFloat(actual, expected, type) {
  if (Number.isNaN(expected)) return Number.isNaN(actual)
  if (type === 'float32') return Math.fround(actual) === expected
  if (type === 'float16') return Math.abs(actual - expected) <= Math.abs(expected) * 2 ** -10
  return actual === expected
}

function deepEqual(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= Math.abs(b) * 1e-12
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter(k => a[k] !== null)
    const kb = Object.keys(b).filter(k => b[k] !== null)
    return ka.length === kb.length && kb.every(k => deepEqual(a[k], b[k]))
  }
  return a === b
}

function check(actual, expected, type) {
  if (expected === null) return actual.isNull
  if (actual.isNull) return false
  if (typeof expected === 'string') return actual.text === expected
  if ('float' in expected) {
    if (expected.point && !/[.e]/.test(actual.text)) return false
    return sameFloat(Number(actual.text), pyFloat(expected.float), type)
  }
  if ('json' in expected) {
    try {
      return deepEqual(JSON.parse(actual.text), expected.json)
    } catch {
      return false
    }
  }
  return false
}

const files = readdirSync(dataDir).filter(f => /\.(parquet|sqlite|db)$/.test(f) && existsSync(join(dataDir, f + '.expected.json'))).sort()
for (const fileName of files) {
  const expectedFile = JSON.parse(readFileSync(join(dataDir, fileName + '.expected.json'), 'utf8'))
  const t0 = performance.now()
  const file = await openFile(join(dataDir, fileName), cache)
  let ok = 0
  let bad = 0
  const problems = []
  for (const expected of expectedFile.tables ?? [expectedFile]) {
    const table = await openTable(file, expected.name)
    const label = expected.name ? `${expected.name}: ` : ''
    const names = table.columns.map(c => c.name)
    if (table.numRows !== expected.numRows) problems.push(`${label}numRows ${table.numRows} != ${expected.numRows}`)
    // expected columns may omit some (e.g. random values), but must be in file order
    const present = names.filter(n => expected.columns.includes(n))
    if (present.join() !== expected.columns.join()) problems.push(`${label}columns ${names} do not contain ${expected.columns}`)
    for (const { row, col, expected: exp } of expected.checks) {
      const c = names.indexOf(col)
      let actual
      try {
        actual = await table.fullValue(row, c)
      } catch (error) {
        actual = { text: `ERROR ${error.message}`, isNull: false }
      }
      if (check(actual, exp, table.columns[c]?.meta.type)) ok++
      else {
        bad++
        if (problems.length < 12) problems.push(`${label}row ${row} ${col} (${table.columns[c]?.meta.type}): got ${JSON.stringify(actual.text).slice(0, 160)}, expected ${JSON.stringify(exp).slice(0, 160)}`)
      }
    }
    // range reads (across pages and row groups) agree with single-row reads
    if (table.numRows && table.numRows <= 1_000_000) {
      for (let c = 0; c < table.columns.length; c++) {
        const a = Math.floor(Math.random() * table.numRows)
        const b = Math.min(table.numRows, a + 1 + Math.floor(Math.random() * 700))
        const range = await table.readColumn(c, a, b)
        for (let r = a; r < b; r += Math.max(1, Math.floor((b - a) / 25))) {
          const [single] = await table.readColumn(c, r, r + 1)
          const x = JSON.stringify(range[r - a], (k, v) => typeof v === 'bigint' ? String(v) : v)
          const y = JSON.stringify(single, (k, v) => typeof v === 'bigint' ? String(v) : v)
          if (x !== y || range.length !== b - a) {
            problems.push(`${label}range [${a}, ${b}) of ${names[c]} at row ${r}: ${x?.slice(0, 80)} != ${y?.slice(0, 80)}`)
            bad++
            break
          }
        }
      }
    }
    // the display path for every column of the first block
    for (let c = 0; c < table.columns.length; c++) {
      try {
        await table.displayColumn(c, 0, Math.min(128, table.numRows), 300)
      } catch (error) {
        problems.push(`${label}displayColumn ${names[c]}: ${error.message}`)
        bad++
      }
    }
  }
  const ms = (performance.now() - t0).toFixed(0)
  console.log(`${bad || problems.length ? 'FAIL' : 'ok  '} ${fileName}: ${ok}/${ok + bad} cells, ${ms} ms`)
  for (const p of problems) console.log('     ' + p)
  if (bad || problems.length) failures++
  file.dispose()
}

if (perf) {
  const time = async (label, fn) => {
    const t0 = performance.now()
    const result = await fn()
    console.log(`  ${label}: ${(performance.now() - t0).toFixed(1)} ms`)
    return result
  }
  const block = (table, row, cols) => Promise.all(cols.map(c => table.displayColumn(c, row, row + 128, 300)))
  for (const fileName of ['tall_single_rg.parquet', 'tall_pageindex_zstd.parquet', 'wide_5000.parquet', 'nested_v1.parquet', 'big.sqlite', 'wide.sqlite']) {
    const path = join(dataDir, fileName)
    if (!existsSync(path)) continue
    console.log(`perf ${fileName}`)
    const perfCache = new LruCache(1024 * 2 ** 20)
    const file = await time('open', () => openFile(path, perfCache))
    const table = await time('open table (first rows)', () => file.openTable(file.defaultTable))
    await time('count rows', async () => {
      while (table.counting) await new Promise(resolve => setTimeout(resolve, 5))
    })
    const cols = table.columns.slice(0, 30).map((c, i) => i)
    await time('first block, 30 cols', () => block(table, 0, cols))
    await time('next block (cached pages)', () => block(table, 128, cols))
    const last = Math.max(0, table.numRows - 128)
    await time('jump to last block', () => block(table, last, cols))
    await time('jump to middle', () => block(table, Math.floor(table.numRows / 2), cols))
    let total = 0
    const n = 20
    for (let i = 0; i < n; i++) {
      const row = Math.floor(Math.random() * Math.max(1, table.numRows - 128))
      const t0 = performance.now()
      await block(table, row, cols)
      total += performance.now() - t0
    }
    console.log(`  random jumps: ${(total / n).toFixed(1)} ms avg over ${n}`)
    if (table.columns.length > 100) {
      const far = table.columns.map((c, i) => i).slice(-30)
      await time('last 30 columns, middle rows', () => block(table, Math.floor(table.numRows / 2), far))
    }
    console.log(`  cache ${(perfCache.size / 2 ** 20).toFixed(0)} MB, rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB`)
    file.dispose()
  }
}

console.log(failures ? `${failures} file(s) failed` : 'all files ok')
process.exit(failures ? 1 : 0)

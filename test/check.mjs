// Checks the readers against values written by test/fixtures/make_fixtures.py and make_sqlite_fixtures.py,
// and SquashFS images against listings written by make_squashfs_fixtures.py.
//
// Usage: node test/check.mjs [DATA_DIR] [--perf] [--parallel=N]
//   DATA_DIR defaults to /tmp/eyeball-data. Every *.parquet, *.sqlite, *.db, *.sqfs or *.sif with
//   a matching .expected.json is checked; --perf also times random access on large files.
//   --parallel sets the reads run at once (as the eyeball.parallelReads setting); 4 or
//   fewer read in this process, more through the helper process.
import * as esbuild from 'esbuild'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dataDir = args.find(a => !a.startsWith('--')) ?? '/tmp/eyeball-data'
const perf = args.includes('--perf')
const parallelReads = Number(args.find(a => a.startsWith('--parallel='))?.slice(11) ?? 64)

const outDir = mkdtempSync(join(tmpdir(), 'eyeball-test-'))
await esbuild.build({
  entryPoints: [new URL('./reader-entry.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(outDir, 'reader.cjs'),
  logLevel: 'warning',
})
const { openTableFile, openFileSource, LruCache, SquashfsImage, squashfsFileSource, squashfsOffset } =
  createRequire(import.meta.url)(join(outDir, 'reader.cjs'))

/** Open a Parquet file or SQLite database (with its -wal file, if any). */
async function openFile(path, cache) {
  const open = p => openFileSource(p, { parallelReads })
  const sibling = async suffix => existsSync(path + suffix) ? open(path + suffix) : undefined
  return openTableFile(await open(path), cache, sibling)
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
    if (expected.lookup && table.lookup !== expected.lookup) problems.push(`${label}rows found by ${table.lookup}, expected ${expected.lookup}`)
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

// ---- SquashFS images: listings, contents, symbolic links, and the readers on files inside ----
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const images = readdirSync(dataDir).filter(f => /\.(sqfs|sif)$/.test(f) && existsSync(join(dataDir, f + '.expected.json'))).sort()
for (const fileName of images) {
  const { files: expected, unsupported } = JSON.parse(readFileSync(join(dataDir, fileName + '.expected.json'), 'utf8'))
  const t0 = performance.now()
  const problems = []
  const source = await openFileSource(join(dataDir, fileName), { parallelReads })
  if (unsupported) {
    // images in other compressions can't be opened, with a message that says why
    const error = await SquashfsImage.open(source, await squashfsOffset(source)).then(() => undefined, e => e.message)
    console.log(`${error?.includes(unsupported) ? 'ok  ' : 'FAIL'} ${fileName}: ${error ?? 'opened'}`)
    if (!error?.includes(unsupported)) failures++
    await source.close()
    continue
  }
  const image = await SquashfsImage.open(source, await squashfsOffset(source))
  const found = {}
  const walk = async (dir, path) => {
    for (const [name, entry] of await image.entries(dir)) {
      const inode = await image.inode(entry.ref)
      found[`${path}/${name}`] = inode
      if (entry.kind !== inode.kind) problems.push(`${path}/${name}: entry is a ${entry.kind}, inode a ${inode.kind}`)
      if (inode.kind === 'directory') await walk(inode, `${path}/${name}`)
    }
  }
  await walk(await image.lookup('/'), '')
  const missing = Object.keys(expected).filter(p => !found[p])
  const extra = Object.keys(found).filter(p => !expected[p])
  if (missing.length || extra.length) problems.push(`missing ${missing.slice(0, 5)}, extra ${extra.slice(0, 5)}`)
  let ok = 0
  for (const [path, want] of Object.entries(expected)) {
    const inode = found[path]
    if (!inode) continue
    const bad = message => problems.length < 12 && problems.push(`${path}: ${message}`)
    if (inode.kind !== want.kind) bad(`${inode.kind}, expected ${want.kind}`)
    else if (want.kind === 'symlink' && inode.target !== want.target) bad(`target ${inode.target}, expected ${want.target}`)
    else if (want.kind === 'file' && inode.size !== want.size) bad(`size ${inode.size}, expected ${want.size}`)
    else if (want.kind === 'file' && sha256(await image.read(inode, 0, inode.size)) !== want.sha256) bad('contents differ')
    else ok++
  }
  {
    // ranges agree with the whole file
    for (const path of ['/random.bin', '/text.txt', '/sparse.bin']) {
      const inode = found[path]
      const whole = await image.read(inode, 0, inode.size)
      for (let k = 0; k < 20; k++) {
        const a = Math.floor(Math.random() * inode.size)
        const b = Math.min(inode.size, a + Math.floor(Math.random() * 300000))
        if (sha256(await image.read(inode, a, b)) !== sha256(whole.subarray(a, b))) problems.push(`${path}: range [${a}, ${b}) differs`)
      }
    }
    // symbolic links, in the middle and at the end of paths
    const deep = expected['/dir/nested/deep/file.txt'].sha256
    const contents = async path => sha256(await image.read(await image.lookup(path), 0, Infinity))
    if (await contents('/link-to-dir/deep/file.txt') !== deep) problems.push('/link-to-dir/deep/file.txt: wrong file')
    if (await contents('/abs-link') !== deep) problems.push('/abs-link: wrong file')
    if ((await image.lookup('/link-to-hello', false)).kind !== 'symlink') problems.push('/link-to-hello: not a link without following')
    for (const [path, code] of [['/dangling', 'ENOENT'], ['/loop1', 'ELOOP'], ['/hello.txt/x', 'ENOTDIR'], ['/no/such/file', 'ENOENT']]) {
      const error = await image.lookup(path).then(() => undefined, e => e.code)
      if (error !== code) problems.push(`${path}: ${error ?? 'found'}, expected ${code}`)
    }
    // the readers, on files in the image
    const inImage = async path => squashfsFileSource(image, await image.lookup(path))
    const parquet = await openTableFile(await inImage('/data/table.parquet'), cache, async () => undefined)
    const sqlite = await openTableFile(await inImage('/data/db.sqlite'), cache, async () => undefined)
    for (const [file, name, rows, check] of [[parquet, undefined, 5000, [4321, 1, 'row 4321']], [sqlite, 't', 3000, [2999, 1, 'value 2999']]]) {
      const table = await openTable(file, name)
      const [row, col, text] = check
      const value = (await table.fullValue(row, col)).text
      if (table.numRows !== rows || value !== text) problems.push(`${file.format} in the image: ${table.numRows} rows, row ${row} is ${value}`)
      file.dispose()
    }
  }
  const ms = (performance.now() - t0).toFixed(0)
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${fileName}: ${ok}/${Object.keys(expected).length} entries, ${ms} ms`)
  for (const p of problems) console.log('     ' + p)
  if (problems.length) failures++
  await source.close()
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

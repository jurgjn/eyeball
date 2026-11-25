// End-to-end check in a real VS Code (openvscode-server) driven by Playwright.
//
// Usage: node test/e2e.mjs URL FOLDER OUTDIR [SECTIONS]
//   URL     openvscode-server with the extension installed, e.g. http://127.0.0.1:3123
//   FOLDER  folder containing the fixtures (test/fixtures/make_fixtures.py --big, and
//           make_sqlite_fixtures.py and make_structure_fixtures.py for those sections)
//   OUTDIR  where screenshots are written
//   SECTIONS  optional regex selecting sections (types, tall, wide, wide100k, nested, sqlite, structure, squashfs,
//             edge, dark); squashfs needs the images of make_squashfs_fixtures.py, and turns the
//             window into a multi-root workspace
import { chromium } from 'playwright'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [url = 'http://127.0.0.1:3123', folder = '/tmp/eyeball-data', outDir = '/tmp/eyeball-shots', sections] = process.argv.slice(2)
const run = name => !sections || new RegExp(sections).test(name)
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
const logs = []
page.on('console', msg => {
  if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[page ${msg.type()}] ${msg.text()}`)
})
page.on('pageerror', error => logs.push(`[page error] ${error.message}`))

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const shot = async name => {
  await page.screenshot({ path: join(outDir, `${name}.png`) })
}

await page.goto(`${url}/?folder=${encodeURIComponent(folder)}`)
await page.waitForSelector('.monaco-workbench', { timeout: 60000 })
await page.waitForTimeout(3000)
// first start: trust the folder, close the walkthrough and the chat view
const trust = page.getByRole('button', { name: 'Yes, I trust the authors' })
if (await trust.isVisible()) await trust.click()
await page.keyboard.press('Control+K')
await page.keyboard.press('W')
await page.waitForTimeout(500)
const closeAux = page.locator('.part.auxiliarybar .action-label.codicon-close, a[aria-label^="Hide Secondary Side Bar"], a[aria-label^="Close Secondary Side Bar"]').first()
if (await closeAux.isVisible().catch(() => false)) await closeAux.click()
await page.waitForTimeout(500)

/** Open a file with quick open and return the frame of its (new) webview, once ready is shown. */
async function open(file, ready = '.grid') {
  const before = await page.locator('iframe.webview.ready').count()
  await page.keyboard.press('Control+P')
  await page.waitForSelector('.quick-input-widget input', { state: 'visible' })
  await page.keyboard.type(file)
  await page.waitForTimeout(800)
  await page.keyboard.press('Enter')
  await page.waitForFunction(n => document.querySelectorAll('iframe.webview.ready').length > n, before, { timeout: 30000 })
  // the custom editor's content is in an iframe inside the webview iframe; other editors' webviews are hidden
  const frame = page.frameLocator('iframe.webview.ready:visible').frameLocator('#active-frame')
  await frame.locator(ready).waitFor({ timeout: 30000 })
  return frame
}

/** Wait until the table is shown and the visible cells have loaded. */
async function settle(frame, timeout = 20000) {
  const start = Date.now()
  await page.waitForTimeout(150)
  while (Date.now() - start < timeout) {
    const ready = await frame.locator('.overlay[hidden]').count() && await frame.locator('.h:not([hidden])').count()
    const loading = await frame.locator('.c.ld:not([hidden])').count()
    if (ready && !loading) return true
    await page.waitForTimeout(100)
  }
  return false
}

const cellTexts = async (frame, selector = '.c:not([hidden])') => frame.locator(selector).allTextContents()
const statusText = async frame => (await frame.locator('.statusbar').textContent())?.trim()

// ---- types: all kinds of values ----
if (run('types')) {
  const frame = await open('types_snappy.parquet')
  check(await settle(frame), 'types: cells load')
  await shot('types')
  const headers = await frame.locator('.h:not([hidden]) .hn').allTextContents()
  check(headers[0] === 'id' && headers.includes('i8'), `types: headers ${headers.slice(0, 5).join(', ')}`)
  const texts = await cellTexts(frame)
  check(texts.includes('null'), 'types: nulls shown')
  // scroll right to the nested columns
  await frame.locator('.grid').click({ position: { x: 300, y: 100 } })
  await page.keyboard.press('End')
  check(await settle(frame), 'types: End loads the last columns')
  await shot('types-end')
  const status = await statusText(frame)
  check(/json \(string\)/.test(status ?? ''), `types: status after End: ${status}`)
  // cell detail panel with a nested value
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')
  await frame.locator('.detail:not([hidden]) .detail-text:not(.loading)').waitFor({ timeout: 10000 })
  const detail = await frame.locator('.detail-text').textContent()
  check(detail !== null && detail.length > 0, `types: detail panel shows ${JSON.stringify(detail?.slice(0, 60))}`)
  await shot('types-detail')
  await page.keyboard.press('Escape')
}

// ---- tall: 30M rows in a single row group ----
if (run('tall')) {
  const frame = await open('tall_single_rg.parquet')
  check(await settle(frame), 'tall: first screen loads')
  const dims = await frame.locator('.dims').textContent()
  check(dims?.includes('30,000,000 rows') ?? false, `tall: dims ${dims}`)
  await frame.locator('.grid').click({ position: { x: 300, y: 100 } })
  // go to the last row
  await page.keyboard.press('Control+End')
  const t0 = Date.now()
  check(await settle(frame), `tall: Ctrl+End loads in ${Date.now() - t0} ms`)
  let rows = await cellTexts(frame, '.r:not([hidden])')
  check(rows.includes('29,999,999'), `tall: last row number shown (${rows.at(-1)})`)
  const ids = await frame.locator('.c:not([hidden])').allTextContents()
  check(ids.includes('29999999'), 'tall: last id value shown')
  await shot('tall-end')
  // go to row via Ctrl+G
  await page.keyboard.press('Control+G')
  await page.keyboard.type('12,345,678')
  await page.keyboard.press('Enter')
  check(await settle(frame), 'tall: go to row loads')
  rows = await cellTexts(frame, '.r:not([hidden])')
  check(rows.includes('12,345,678'), 'tall: go to row shows the row')
  const status = await statusText(frame)
  check(status?.startsWith('Row 12,345,678') ?? false, `tall: status ${status}`)
  await shot('tall-goto')
  // wheel scrolling
  const box = await frame.locator('.grid').boundingBox()
  await page.mouse.move(box.x + 400, box.y + 300)
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 400)
  check(await settle(frame), 'tall: wheel scrolling loads')
  rows = await cellTexts(frame, '.r:not([hidden])')
  const first = Number(rows[0].replace(/,/g, ''))
  check(first > 12_345_678 && first < 12_346_000, `tall: wheel moved to row ${rows[0]}`)
  // drag the scrollbar thumb to the middle (scaled scrolling)
  await frame.locator('.scroller').evaluate(el => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
  })
  check(await settle(frame), 'tall: scrollbar jump loads')
  rows = await cellTexts(frame, '.r:not([hidden])')
  const mid = Number(rows[0].replace(/,/g, ''))
  check(Math.abs(mid - 15_000_000) < 100, `tall: scrollbar middle is row ${rows[0]}`)
  // copy a range
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowRight')
  const sel = await frame.locator('.selsize').textContent()
  check(sel === '2 × 2 selected', `tall: selection ${sel}`)
  await page.keyboard.press('Control+C')
  await page.waitForTimeout(500)
  const copied = await frame.locator('.statusbar .message').textContent()
  check(copied === 'Copied 4 cells', `tall: copy status ${copied}`)
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  const lines = clipboard.split('\n').map(line => line.split('\t'))
  // the scrollbar jump does not move the active cell, which is still at the row from Ctrl+G
  check(lines.length === 2 && lines[0][0] === '12345678' && lines[1][0] === '12345679' && lines[0].length === 2,
    `tall: clipboard ${JSON.stringify(clipboard)}`)
}

// ---- wide: 5001 columns ----
if (run('wide')) {
  const frame = await open('wide_5000.parquet')
  check(await settle(frame), 'wide: first screen loads')
  await shot('wide')
  await page.keyboard.press('Control+F')
  await page.keyboard.type('col_04321')
  await page.keyboard.press('Enter')
  check(await settle(frame), 'wide: jump to column loads')
  const status = await statusText(frame)
  check(status?.includes('col_04321') ?? false, `wide: status ${status}`)
  await shot('wide-find')
  // hide everything but matches of a regex
  await frame.locator('.filter').fill('/col_0000[0-4]$/')
  await frame.locator('.buttons button', { hasText: 'Show only matches' }).click()
  check(await settle(frame), 'wide: show only matches')
  const headers = await frame.locator('.h:not([hidden]) .hn').allTextContents()
  check(headers.join() === 'col_00000,col_00001,col_00002,col_00003,col_00004', `wide: visible ${headers.join()}`)
  await frame.locator('.tab', { hasText: 'File' }).click()
  await frame.locator('.file-pane table.kv').waitFor({ timeout: 10000 })
  await shot('wide-file')
}

// ---- 100k columns (optional, see README) ----
if (run('wide100k') && existsSync(join(folder, 'wide_100k.parquet'))) {
  const t0 = Date.now()
  const frame = await open('wide_100k.parquet')
  check(await settle(frame), `wide100k: first screen in ${Date.now() - t0} ms`)
  await frame.locator('.grid').click({ position: { x: 300, y: 100 } })
  let t1 = Date.now()
  await page.keyboard.press('End')
  check(await settle(frame), `wide100k: End in ${Date.now() - t1} ms`)
  const headers = await frame.locator('.h:not([hidden]) .hn').allTextContents()
  check(headers.includes('gene_099999'), `wide100k: last column shown (${headers.length} headers)`)
  t1 = Date.now()
  await page.keyboard.press('Control+F')
  await page.keyboard.type('gene_05')
  await page.waitForTimeout(100)
  const summary = await frame.locator('.summary').textContent()
  check(summary === '10,000 of 100,000 columns', `wide100k: filter ${summary} in ${Date.now() - t1} ms`)
  await frame.locator('.buttons button', { hasText: 'Show only matches' }).click()
  check(await settle(frame), 'wide100k: show only matches')
  await shot('wide100k')
  // horizontal wheel scrolling across many columns
  const box = await frame.locator('.grid').boundingBox()
  await page.mouse.move(box.x + 300, box.y + 300)
  t1 = Date.now()
  for (let i = 0; i < 20; i++) await page.mouse.wheel(2000, 0)
  check(await settle(frame), `wide100k: horizontal wheel in ${Date.now() - t1} ms`)
}

// ---- nested ----
if (run('nested')) {
  const frame = await open('nested_v1.parquet')
  check(await settle(frame), 'nested: loads')
  await shot('nested')
}

// ---- SQLite ----
if (run('sqlite') && existsSync(join(folder, 'types.sqlite'))) {
  let frame = await open('types.sqlite')
  check(await settle(frame), 'sqlite: opens')
  const options = await frame.locator('select.tables option').allTextContents()
  check(options.includes('t') && options.includes('wr') && options.includes('v (view)') && options.includes('docs (virtual table)'),
    `sqlite: tables ${options.join(', ')}`)
  check(await frame.locator('select.tables option[value="v"]').isDisabled(), 'sqlite: views are disabled')
  check(await frame.locator('select.tables').inputValue() === 'altered', 'sqlite: first table selected')
  await frame.locator('select.tables').selectOption('t')
  await page.waitForTimeout(300)
  check(await settle(frame), 'sqlite: switch to table t')
  let headers = await frame.locator('.h:not([hidden]) .hn').allTextContents()
  check(headers.slice(0, 4).join() === 'id,i,r,s', `sqlite: t headers ${headers.slice(0, 4).join()}`)
  const dims = await frame.locator('.dims').textContent()
  check(dims?.startsWith('2,572 rows × 9 columns') ?? false, `sqlite: t dims ${dims}`)
  await shot('sqlite-t')
  await frame.locator('select.tables').selectOption('gen')
  await page.waitForTimeout(300)
  check(await settle(frame), 'sqlite: switch to table gen')
  const texts = await frame.locator('.c:not([hidden])').allTextContents()
  check(texts.includes('(computed, not stored)'), 'sqlite: virtual generated column marked')
  await frame.locator('.grid').click({ position: { x: 300, y: 100 } })
  await page.keyboard.press('Control+F')
  await page.keyboard.press('Escape')
  await frame.locator('.details table.kv').waitFor({ timeout: 10000 })
  const info = await frame.locator('.details').textContent()
  check(/Declared type/.test(info ?? ''), 'sqlite: column details')
  await frame.locator('.tab', { hasText: 'File' }).click()
  await frame.locator('.file-pane table.rowgroups').waitFor({ timeout: 10000 })
  const fileInfo = await frame.locator('.file-pane').textContent()
  check(/Page size/.test(fileInfo ?? '') && /Schema/.test(fileInfo ?? ''), 'sqlite: file info')
  await shot('sqlite-file')

  frame = await open('big.sqlite')
  check(await settle(frame), 'sqlite big: opens')
  let bigDims = ''
  for (let i = 0; i < 100 && !bigDims.startsWith('5,000,000 rows'); i++) {
    await page.waitForTimeout(100)
    bigDims = (await frame.locator('.dims').textContent()) ?? ''
  }
  check(bigDims.startsWith('5,000,000 rows × 5 columns'), `sqlite big: dims ${bigDims}`)
  await frame.locator('.grid').click({ position: { x: 300, y: 100 } })
  const t0 = Date.now()
  await page.keyboard.press('Control+End')
  check(await settle(frame), `sqlite big: Ctrl+End in ${Date.now() - t0} ms`)
  const rows = await frame.locator('.r:not([hidden])').allTextContents()
  check(rows.includes('4,999,999'), 'sqlite big: last row shown')
  check((await frame.locator('.c:not([hidden])').allTextContents()).includes('5000000'), 'sqlite big: last id shown')
  await shot('sqlite-big')

  frame = await open('wide.sqlite')
  check(await settle(frame), 'sqlite wide: opens')
  await frame.locator('.grid').click({ position: { x: 300, y: 100 } })
  await page.keyboard.press('End')
  check(await settle(frame), 'sqlite wide: End')
  headers = await frame.locator('.h:not([hidden]) .hn').allTextContents()
  check(headers.includes('c1499'), `sqlite wide: last column shown (${headers.length} headers)`)

  frame = await open('wal.sqlite')
  check(await settle(frame), 'sqlite wal: opens')
  const walTables = await frame.locator('select.tables option').allTextContents()
  check(walTables.includes('only_in_wal'), `sqlite wal: tables ${walTables.join(', ')}`)
}

// ---- molecular structures, with Mol* ----
if (run('structure') && existsSync(join(folder, 'structures.expected.json'))) {
  const expected = JSON.parse(readFileSync(join(folder, 'structures.expected.json'), 'utf8'))
  // text formats open as text by default: make the structure viewer their editor in this folder
  const settings = join(folder, '.vscode', 'settings.json')
  const wroteSettings = !existsSync(settings)
  if (wroteSettings) {
    const associations = Object.fromEntries(['pdb', 'cif', 'gro', 'xyz', 'sdf', 'mol2'].map(ext => [`*.${ext}`, 'eyeball.structure']))
    mkdirSync(join(folder, '.vscode'), { recursive: true })
    writeFileSync(settings, JSON.stringify({ 'workbench.editorAssociations': associations }, null, 2))
    await page.waitForTimeout(1500)
  }
  for (const [file, want] of Object.entries(expected)) {
    const frame = await open(file, '#app')
    const loaded = await frame.locator('body[data-atoms]').waitFor({ timeout: 30000 }).then(() => true, () => false)
    check(loaded, `structure ${file}: loads`)
    if (!loaded) continue
    const data = await frame.locator('body').evaluate(body => ({ ...body.dataset }))
    const message = await frame.locator('#message:not([hidden])').textContent({ timeout: 500 }).catch(() => '')
    if (want.atoms) check(Number(data.atoms) === want.atoms, `structure ${file}: ${data.atoms} atoms, expected ${want.atoms}`)
    if (want.frames) check(Number(data.frames) === want.frames, `structure ${file}: ${data.frames} frames, expected ${want.frames}`)
    if (want.volume) check(Number(data.volumes) > 0, `structure ${file}: ${data.volumes} volumes`)
    if (want.note) check(/topology/.test(message ?? ''), `structure ${file}: note ${JSON.stringify(message)}`)
    else check(!message, `structure ${file}: no message (${JSON.stringify(message)})`)
    await page.waitForTimeout(1000)
    await shot(`structure-${file}`)
  }
  // a structure that changes on disk is reloaded
  const helix = readFileSync(join(folder, 'helix.pdb'), 'utf8').split('\n')
  const reloadFile = join(folder, 'e2e_reload.pdb')
  writeFileSync(reloadFile, helix.join('\n'))
  const frame = await open('e2e_reload.pdb', '#app')
  await frame.locator('body[data-atoms]').waitFor({ timeout: 30000 })
  const atoms = Number(await frame.locator('body').getAttribute('data-atoms'))
  writeFileSync(reloadFile, [...helix.filter(l => l.startsWith('ATOM')).slice(0, 50), 'END', ''].join('\n'))
  const reloaded = await frame.locator('body[data-atoms="50"]').waitFor({ timeout: 15000 }).then(() => true, () => false)
  check(atoms === 120 && reloaded, `structure: reloaded after a change on disk (${atoms} atoms, then ${await frame.locator('body').getAttribute('data-atoms')})`)
  rmSync(reloadFile)
  if (wroteSettings) rmSync(settings)
}

// ---- SquashFS images as folders ----
if (run('squashfs') && existsSync(join(folder, 'tree-zstd.sqfs'))) {
  const item = name => page.getByRole('treeitem', { name, exact: true }).first()
  /** Open an image's page, and add the image to the explorer with its button. */
  const addImage = async file => {
    // the page may replace another one in preview mode, so wait for its title rather than a new webview
    await page.keyboard.press('Control+P')
    await page.waitForSelector('.quick-input-widget input', { state: 'visible' })
    await page.keyboard.type(file)
    await page.waitForTimeout(800)
    await page.keyboard.press('Enter')
    const frame = page.frameLocator('iframe.webview.ready:visible').frameLocator('#active-frame')
    await frame.locator('h2', { hasText: file }).waitFor({ timeout: 30000 }).catch(async error => {
      await shot(`squashfs-failed-${file}`)
      throw error
    })
    const text = await frame.locator('body').innerText()
    const button = frame.locator('#explorer')
    if (await button.count()) await button.click()
    return text
  }
  let text = await addImage('tree-zstd.sqfs')
  check(/SquashFS image/.test(text) && /zstd/.test(text) && /1,028/.test(text), `squashfs: page ${JSON.stringify(text.slice(0, 120))}`)
  // the window reloads as a multi-root workspace
  await page.waitForURL(/workspace=/, { timeout: 30000 }).catch(() => {})
  await page.waitForSelector('.monaco-workbench', { timeout: 60000 })
  const root = item('tree-zstd.sqfs')
  check(await root.waitFor({ timeout: 30000 }).then(() => true, () => false), 'squashfs: image added to the explorer')
  // collapse the other folder, so that the image's items are in view
  await item('eyeball-e2e').click()
  await page.waitForTimeout(500)
  if ((await root.getAttribute('aria-expanded')) !== 'true') await root.click()
  check(await item('hello.txt').waitFor({ timeout: 15000 }).then(() => true, () => false), 'squashfs: root listed')
  await shot('squashfs-explorer')
  // a text file, read-only
  await item('hello.txt').click()
  await page.waitForTimeout(1500)
  // the editor shows spaces as non-breaking spaces
  const lines = (await page.locator('.monaco-editor .view-lines').allInnerTexts()).map(t => t.replace(/\u00a0/g, ' '))
  check(lines.some(t => /hello squashfs/.test(t)), 'squashfs: text file opens')
  // typing into it is refused
  await page.locator('.monaco-editor .view-lines', { hasText: 'hello' }).first().click()
  await page.keyboard.type('x')
  const refused = await page.locator('.monaco-editor-overlaymessage', { hasText: /read-only/i }).waitFor({ timeout: 5000 }).then(() => true, () => false)
  check(refused, 'squashfs: text file is read-only')
  await shot('squashfs-hello')
  // a symbolic link to a directory, and a directory of 1000 files
  await item('link-to-dir').click()
  check(await item('deep').waitFor({ timeout: 10000 }).then(() => true, () => false), 'squashfs: link to a directory expands')
  await item('many').click()
  check(await item('f0000.txt').waitFor({ timeout: 10000 }).then(() => true, () => false), 'squashfs: directory of 1000 files')
  await item('many').click()
  // Eyeball's viewers on files in the image
  await item('data').click()
  await item('table.parquet').click()
  let frame = page.frameLocator('iframe.webview.ready:visible').frameLocator('#active-frame')
  check(await settle(frame), 'squashfs: Parquet file opens')
  let dims = await frame.locator('.dims').textContent()
  check(dims?.startsWith('5,000 rows') ?? false, `squashfs: Parquet dims ${dims}`)
  await item('db.sqlite').click()
  frame = page.frameLocator('iframe.webview.ready:visible').frameLocator('#active-frame')
  check(await settle(frame), 'squashfs: SQLite database opens')
  dims = await frame.locator('.dims').textContent()
  check(dims?.startsWith('3,000 rows') ?? false, `squashfs: SQLite dims ${dims}`)
  await shot('squashfs-parquet')
  // an Apptainer image, and one in a compression Eyeball can't read
  await item('tree-zstd.sqfs').click()
  text = await addImage('tree.sif')
  check(/Apptainer/.test(text), `squashfs: SIF page ${JSON.stringify(text.slice(0, 120))}`)
  check(await item('tree.sif').waitFor({ timeout: 30000 }).then(() => true, () => false), 'squashfs: SIF image added to the explorer')
  text = await addImage('tree-xz.sqfs')
  check(/xz, which Eyeball can't read/.test(text), `squashfs: xz page ${JSON.stringify(text.slice(0, 160))}`)
}

// ---- edge cases: empty file, not a Parquet file, file changing on disk ----
if (run('edge')) {
  const frame = await open('empty.parquet')
  await settle(frame)
  const dims = await frame.locator('.dims').textContent()
  check(dims?.startsWith('0 rows × 35 columns') ?? false, `empty: dims ${dims}`)
  check(await frame.locator('.h:not([hidden])').count() > 0, 'empty: headers shown')
}
if (run('edge')) {
  writeFileSync(join(folder, 'e2e_corrupt.parquet'), 'this is not parquet'.repeat(10))
  await page.keyboard.press('Control+P')
  await page.waitForSelector('.quick-input-widget input', { state: 'visible' })
  await page.keyboard.type('e2e_corrupt.parquet')
  await page.waitForTimeout(800)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1000)
  const frame = page.frameLocator('iframe.webview.ready:visible').frameLocator('#active-frame')
  await frame.locator('.overlay.error').waitFor({ timeout: 20000 })
  const text = await frame.locator('.overlay.error').textContent()
  check(/not a Parquet file/.test(text ?? ''), `corrupt: ${JSON.stringify(text)}`)
}
if (run('edge')) {
  copyFileSync(join(folder, 'one_row.parquet'), join(folder, 'e2e_reload.parquet'))
  const frame = await open('e2e_reload.parquet')
  await settle(frame)
  check((await frame.locator('.dims').textContent())?.startsWith('1 row ') ?? false, 'reload: initial file has 1 row')
  copyFileSync(join(folder, 'tall_pageindex_zstd.parquet'), join(folder, 'e2e_reload.parquet'))
  let dims = ''
  for (let i = 0; i < 100 && !dims.startsWith('30,000,000'); i++) {
    await page.waitForTimeout(200)
    dims = (await frame.locator('.dims').textContent()) ?? ''
  }
  check(dims.startsWith('30,000,000 rows × 5 columns'), `reload: dims after the file changed: ${dims}`)
  check(await settle(frame), 'reload: new data loads')
}

// ---- dark theme ----
if (run('dark')) {
  await page.keyboard.press('Control+K')
  await page.keyboard.press('Control+T')
  await page.waitForSelector('.quick-input-widget input', { state: 'visible' })
  await page.keyboard.type('Dark Modern')
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1000)
  const frame = await open('types_v2_zstd.parquet')
  check(await settle(frame), 'dark: loads')
  await frame.locator('.grid').click({ position: { x: 400, y: 120 } })
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Control+F')
  await page.keyboard.press('Escape')
  await shot('dark')
  await frame.locator('.grid').click({ position: { x: 600, y: 300 }, button: 'right' })
  await frame.locator('.menu:not([hidden])').waitFor()
  await shot('dark-menu')
  await page.keyboard.press('Escape')
}

for (const f of ['e2e_corrupt.parquet', 'e2e_reload.parquet']) rmSync(join(folder, f), { force: true })
console.log(logs.filter(l => !/(favicon|Failed to load resource|ResizeObserver)/.test(l)).slice(0, 30).join('\n'))
await browser.close()
console.log(failures ? `${failures} check(s) failed` : 'all checks ok')
process.exit(failures ? 1 : 0)

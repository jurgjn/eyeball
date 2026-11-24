import type { HostMessage, TableInit, WebviewMessage } from '../src/protocol'
import { DataStore } from './data'
import { Grid } from './grid'
import { ContextMenu, DetailPanel, Sidebar, el } from './panels'

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

const vscode = acquireVsCodeApi()
const post = (msg: WebviewMessage) => vscode.postMessage(msg)
const fmt = new Intl.NumberFormat('en-US')
const isMac = navigator.platform.toLowerCase().includes('mac')
const mod = isMac ? '⌘' : 'Ctrl+'

let table: TableInit | undefined

// ---- layout ----

const app = document.getElementById('app')!
const toolbar = el('div', 'toolbar')
const title = el('span', 'title')
const tableSelect = el('select', 'tables')
tableSelect.title = 'Table'
tableSelect.hidden = true
const dims = el('span', 'dims')
const spacer = el('span', 'grow')
const gotoInput = el('input', 'goto')
gotoInput.type = 'text'
gotoInput.placeholder = 'Go to row'
gotoInput.title = `Go to row (${mod}G)`
gotoInput.spellcheck = false
const columnsButton = el('button', 'toggle', 'Columns')
columnsButton.title = `Column list, filter and details (${mod}F)`
const fileButton = el('button', 'toggle', 'File info')
fileButton.title = 'File metadata and row groups'
const detailButton = el('button', 'toggle', 'Cell value')
detailButton.title = 'Show the full value of the selected cell (Enter)'
toolbar.append(title, tableSelect, dims, spacer, gotoInput, columnsButton, fileButton, detailButton)

const main = el('div', 'main')
const center = el('div', 'center')
const statusBar = el('div', 'statusbar')
const statusPosition = el('span', 'pos')
const statusSelection = el('span', 'selsize')
const statusMessage = el('span', 'message')
statusBar.append(statusPosition, statusSelection, statusMessage)
const overlay = el('div', 'overlay')
const menu = new ContextMenu()

const store = new DataStore(post, () => grid.invalidate())
const grid = new Grid(store, {
  activeChanged: onActiveChanged,
  openDetail: () => showDetail(true),
  copy: header => copySelection(header),
  contextMenu: showContextMenu,
  goToRow: () => {
    gotoInput.focus()
    gotoInput.select()
  },
  findColumn: () => {
    sidebar.focusFilter()
    updateToggles()
  },
})
const sidebar = new Sidebar(grid, post)
const detail = new DetailPanel(post, () => {
  detail.hide()
  updateToggles()
  grid.focus()
})

center.append(grid.el, detail.el)
main.append(center, sidebar.el)
app.append(toolbar, main, statusBar, overlay, menu.el)
showOverlay('Loading…')

// ---- toolbar ----

columnsButton.onclick = () => {
  if (sidebar.visible && !columnsButton.classList.contains('active')) sidebar.showTab('columns')
  else if (sidebar.visible) sidebar.toggle(false)
  else sidebar.showTab('columns')
  updateToggles()
}
fileButton.onclick = () => {
  if (sidebar.visible && fileButton.classList.contains('active')) sidebar.toggle(false)
  else sidebar.showTab('file')
  updateToggles()
}
detailButton.onclick = () => {
  if (detail.visible) detail.hide()
  else showDetail(false)
  updateToggles()
}

function updateToggles(): void {
  const tab = sidebar.el.querySelector('.tab.active')?.textContent
  columnsButton.classList.toggle('active', sidebar.visible && tab === 'Columns')
  fileButton.classList.toggle('active', sidebar.visible && tab === 'File')
  detailButton.classList.toggle('active', detail.visible)
}
sidebar.el.addEventListener('click', updateToggles)

tableSelect.addEventListener('change', () => {
  post({ type: 'selectTable', name: tableSelect.value })
  grid.focus()
})

/** Fill the table selector (SQLite databases); hidden for files with a single table. */
function showTables(init: TableInit): void {
  tableSelect.hidden = init.tables.length < 2
  tableSelect.replaceChildren(...init.tables.map(entry => {
    const option = el('option', '', entry.supported ? entry.name : `${entry.name} (${entry.kind})`)
    option.value = entry.name
    option.disabled = !entry.supported
    if (entry.note) option.title = entry.note
    return option
  }))
  tableSelect.value = init.table
}

function showDims(): void {
  if (!table) return
  const rows = table.counting ? `${fmt.format(table.numRows)}+ rows (counting)` : plural(table.numRows, 'row')
  dims.textContent = `${rows} × ${plural(table.columns.length, 'column')} · ${formatBytes(table.fileSize)}`
}

gotoInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const row = Number(gotoInput.value.replace(/[\s,_']/g, ''))
    if (gotoInput.value.trim() && Number.isFinite(row)) {
      grid.goToRow(Math.floor(row))
      grid.focus()
    } else {
      gotoInput.classList.add('invalid')
    }
    e.preventDefault()
  } else if (e.key === 'Escape') {
    grid.focus()
    e.preventDefault()
  }
  e.stopPropagation()
})
gotoInput.addEventListener('input', () => gotoInput.classList.remove('invalid'))

// ---- active cell, detail panel ----

function onActiveChanged(): void {
  const cell = grid.activeCell()
  if (!table || !cell) {
    statusPosition.textContent = ''
    statusSelection.textContent = ''
    return
  }
  const column = table.columns[cell.col]
  statusPosition.textContent = `Row ${fmt.format(cell.row)} · ${column.name} (${column.type}) · column ${fmt.format(cell.col + 1)}`
  const { rowStart, rowEnd, cols } = grid.selection()
  const cells = (rowEnd - rowStart) * cols.length
  statusSelection.textContent = cells > 1 ? `${fmt.format(rowEnd - rowStart)} × ${fmt.format(cols.length)} selected` : ''
  sidebar.setActiveColumn(cell.col)
  if (detail.visible) showDetail(false)
}

function showDetail(toggleIfOpen: boolean): void {
  if (toggleIfOpen && detail.visible) {
    detail.hide()
  } else {
    const cell = grid.activeCell()
    detail.show(cell, cell && table?.columns[cell.col])
  }
  updateToggles()
}

// ---- copy ----

let lastCopy = 0

function copySelection(header: boolean): void {
  if (!table) return
  const { rowStart, rowEnd, cols } = grid.selection()
  if (!cols.length || rowEnd <= rowStart) return
  lastCopy = Date.now()
  setStatus('Copying…')
  post({ type: 'copy', rowStart, rowEnd, cols, header })
}

// VS Code dispatches its own copy command to the webview (e.g. from the Edit menu)
document.addEventListener('copy', e => {
  const target = e.target as HTMLElement | null
  if (target && (target instanceof HTMLInputElement || target.closest('.detail-text, .sidebar'))) return
  e.preventDefault()
  if (Date.now() - lastCopy > 500) copySelection(false)
})

function copyColumnNames(): void {
  if (!table) return
  const { cols } = grid.selection()
  post({ type: 'copyText', text: cols.map(c => table!.columns[c].name).join('\t') })
}

function showContextMenu(x: number, y: number): void {
  if (!table) return
  const { cols } = grid.selection()
  const many = cols.length > 1
  menu.show(x, y, [
    { label: 'Copy', shortcut: `${mod}C`, action: () => copySelection(false), disabled: !cols.length },
    { label: 'Copy with header', shortcut: `${mod}Shift+C`, action: () => copySelection(true), disabled: !cols.length },
    { label: many ? 'Copy column names' : 'Copy column name', action: copyColumnNames, disabled: !cols.length },
    'separator',
    { label: 'Show cell value', shortcut: 'Enter', action: () => showDetail(false) },
    { label: 'Column details', action: () => { sidebar.showTab('columns'); updateToggles() } },
    'separator',
    { label: many ? `Hide ${cols.length} columns` : 'Hide column', action: () => { grid.setHidden(cols, true); sidebar.refresh() }, disabled: !cols.length },
    { label: 'Show all columns', action: () => { grid.setHidden([...grid.hidden], false); sidebar.refresh() }, disabled: !grid.hidden.size },
    { label: many ? 'Fit column widths' : 'Fit column width', action: () => grid.autofit(cols), disabled: !cols.length },
    'separator',
    { label: 'Select all', shortcut: `${mod}A`, action: () => grid.selectAll() },
    { label: 'Go to row…', shortcut: `${mod}G`, action: () => { gotoInput.focus(); gotoInput.select() } },
  ])
  grid.focus()
}

// ---- status ----

let statusTimer: ReturnType<typeof setTimeout> | undefined

function setStatus(message: string, sticky = false): void {
  statusMessage.textContent = message
  clearTimeout(statusTimer)
  if (!sticky) statusTimer = setTimeout(() => (statusMessage.textContent = store.loading ? 'Loading…' : ''), 4000)
}

// show "Loading…" while visible data is missing
setInterval(() => {
  if (!statusTimer || statusMessage.textContent === '' || statusMessage.textContent === 'Loading…') {
    statusMessage.textContent = store.loading ? 'Loading…' : ''
  }
}, 250)

function showOverlay(text: string, error = false): void {
  overlay.hidden = false
  overlay.className = error ? 'overlay error' : 'overlay'
  overlay.textContent = text
}

// ---- messages from the extension ----

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data
  switch (msg.type) {
    case 'loading':
      title.textContent = msg.fileName
      if (!table) showOverlay(`Reading ${msg.fileName}…`)
      break
    case 'init': {
      table = msg.table
      overlay.hidden = true
      title.textContent = table.fileName
      title.title = table.fileName
      showTables(table)
      showDims()
      store.reset()
      grid.setTable(table.table, table.numRows, table.columns)
      sidebar.setColumns(table.columns)
      detail.reset()
      if (detail.visible) showDetail(false)
      if (msg.reloaded) setStatus('File changed on disk and was reloaded')
      if (!table.columns.length) showOverlay('This file has no columns.')
      grid.focus()
      break
    }
    case 'fatal':
      table = undefined
      showOverlay(`Could not open this file:\n${msg.message}`, true)
      break
    case 'rowCount':
      if (!table) break
      table.numRows = msg.numRows
      table.counting = msg.counting
      store.dropPartial()
      grid.setRowCount(msg.numRows)
      showDims()
      onActiveChanged()
      break
    case 'data':
      store.receive(msg)
      grid.onData(msg)
      if (msg.errors) {
        const [col, error] = Object.entries(msg.errors)[0]
        setStatus(`Error reading column ${table?.columns[Number(col)]?.name}: ${error}`)
      }
      break
    case 'cell':
      detail.onCell(msg)
      break
    case 'columnInfo':
      sidebar.onColumnInfo(msg.col, msg.items)
      break
    case 'fileInfo':
      sidebar.onFileInfo(msg.sections)
      break
    case 'status':
      setStatus(msg.message)
      break
  }
})

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && detail.visible && !(e.target instanceof HTMLInputElement)) {
    detail.hide()
    updateToggles()
    grid.focus()
  }
})

function plural(n: number, noun: string): string {
  return `${fmt.format(n)} ${noun}${n === 1 ? '' : 's'}`
}

function formatBytes(bytes: number): string {
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

post({ type: 'ready' })

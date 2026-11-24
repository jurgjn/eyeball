// Side panel (column list, column details, file details), cell detail panel and context menu.

import type { ColumnMeta, HostMessage, InfoSection, KeyValue, WebviewMessage } from '../src/protocol'
import type { Grid } from './grid'

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

/** Make a panel resizable by dragging its left or top edge. */
function addSash(target: HTMLElement, edge: 'left' | 'top', min: number, maxFraction: number): void {
  const sash = el('div', `sash sash-${edge}`)
  target.append(sash)
  sash.addEventListener('mousedown', e => {
    e.preventDefault()
    const horizontal = edge === 'left'
    const start = horizontal ? e.clientX : e.clientY
    const size = horizontal ? target.offsetWidth : target.offsetHeight
    const cursorClass = horizontal ? 'resizing' : 'resizing-v'
    document.body.classList.add(cursorClass)
    const move = (ev: MouseEvent) => {
      const limit = (horizontal ? window.innerWidth : window.innerHeight) * maxFraction
      const value = Math.max(min, Math.min(limit, size - ((horizontal ? ev.clientX : ev.clientY) - start)))
      if (horizontal) target.style.width = `${value}px`
      else target.style.height = `${value}px`
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.classList.remove(cursorClass)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })
}

function keyValueTable(items: KeyValue[]): HTMLTableElement {
  const table = el('table', 'kv')
  for (const { key, value } of items) {
    const tr = table.insertRow()
    tr.append(el('th', '', key), el('td', '', value))
  }
  return table
}

const ITEM_HEIGHT = 22
const fmt = new Intl.NumberFormat('en-US')

/** Column list with filter and visibility toggles, details of the active column, and file details. */
export class Sidebar {
  readonly el = el('div', 'sidebar')
  private readonly tabs = el('div', 'tabs')
  private readonly columnsTab = el('button', 'tab active', 'Columns')
  private readonly fileTab = el('button', 'tab', 'File')
  private readonly columnsPane = el('div', 'pane columns-pane')
  private readonly filePane = el('div', 'pane file-pane')
  readonly filter = el('input', 'filter')
  private readonly summary = el('div', 'summary')
  private readonly list = el('div', 'list')
  private readonly listSpacer = el('div', 'list-spacer')
  private readonly listItems = el('div', 'list-items')
  private readonly details = el('div', 'details')
  private readonly itemPool: { row: HTMLDivElement; check: HTMLInputElement; name: HTMLSpanElement; type: HTMLSpanElement }[] = []
  private columns: ColumnMeta[] = []
  private matches: number[] = []
  private matchCursor = -1
  private activeCol = -1
  private infoCol = -1
  private infoTimer?: ReturnType<typeof setTimeout>
  private fileInfoLoaded = false

  constructor(private readonly grid: Grid, private readonly post: (msg: WebviewMessage) => void) {
    this.el.hidden = true
    this.tabs.append(this.columnsTab, this.fileTab)
    this.columnsTab.onclick = () => this.showTab('columns')
    this.fileTab.onclick = () => this.showTab('file')

    this.filter.type = 'text'
    this.filter.placeholder = 'Filter columns (/regex/)'
    this.filter.spellcheck = false
    this.filter.addEventListener('input', () => {
      this.matchCursor = -1
      this.applyFilter()
    })
    this.filter.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        // cycle through matches
        if (this.matches.length) {
          this.matchCursor = (this.matchCursor + (e.shiftKey ? -1 : 1) + this.matches.length) % this.matches.length
          const col = this.matches[this.matchCursor]
          this.grid.revealColumn(col)
          this.scrollListTo(this.matchCursor)
        }
        e.preventDefault()
      } else if (e.key === 'Escape') {
        if (this.filter.value) {
          this.filter.value = ''
          this.applyFilter()
        } else {
          this.grid.focus()
        }
        e.preventDefault()
      }
      e.stopPropagation()
    })

    const buttons = el('div', 'buttons')
    const showAll = el('button', '', 'Show all')
    const hideAll = el('button', '', 'Hide all')
    const onlyMatching = el('button', '', 'Show only matches')
    showAll.title = 'Show all columns matching the filter'
    hideAll.title = 'Hide all columns matching the filter'
    onlyMatching.title = 'Show the columns matching the filter and hide all others'
    showAll.onclick = () => this.setHidden(this.matches, false)
    hideAll.onclick = () => this.setHidden(this.matches, true)
    onlyMatching.onclick = () => {
      const keep = new Set(this.matches)
      this.grid.setHidden(this.columns.map((_, i) => i).filter(i => !keep.has(i)), true)
      this.grid.setHidden(this.matches, false)
      this.refresh()
    }
    buttons.append(showAll, hideAll, onlyMatching)

    this.list.append(this.listSpacer, this.listItems)
    this.list.addEventListener('scroll', () => this.renderList())
    new ResizeObserver(() => this.renderList()).observe(this.list)
    this.listItems.addEventListener('click', e => {
      const target = e.target as HTMLElement
      const row = target.closest<HTMLElement>('.item')
      if (!row) return
      const col = Number(row.dataset.col)
      if (target instanceof HTMLInputElement) {
        this.setHidden([col], !target.checked)
      } else {
        this.grid.revealColumn(col)
        this.refresh()
        this.grid.focus()
      }
    })

    this.columnsPane.append(this.filter, buttons, this.summary, this.list, this.details)
    this.filePane.hidden = true
    this.el.append(this.tabs, this.columnsPane, this.filePane)
    addSash(this.el, 'left', 200, 0.7)
  }

  get visible(): boolean {
    return !this.el.hidden
  }

  toggle(show = this.el.hidden): void {
    this.el.hidden = !show
    if (show) {
      this.renderList()
      this.requestInfo()
    }
  }

  showTab(tab: 'columns' | 'file'): void {
    this.toggle(true)
    this.columnsTab.classList.toggle('active', tab === 'columns')
    this.fileTab.classList.toggle('active', tab === 'file')
    this.columnsPane.hidden = tab !== 'columns'
    this.filePane.hidden = tab !== 'file'
    if (tab === 'file' && !this.fileInfoLoaded) {
      this.fileInfoLoaded = true
      this.filePane.replaceChildren(el('div', 'muted', 'Loading…'))
      this.post({ type: 'fileInfo' })
    }
    if (tab === 'columns') this.renderList()
  }

  focusFilter(): void {
    this.showTab('columns')
    this.filter.focus()
    this.filter.select()
  }

  setColumns(columns: ColumnMeta[]): void {
    this.columns = columns
    this.infoCol = -1
    this.fileInfoLoaded = false
    if (!this.filePane.hidden) this.showTab('file')
    this.applyFilter()
  }

  private setHidden(cols: number[], hidden: boolean): void {
    this.grid.setHidden(cols, hidden)
    this.refresh()
  }

  private applyFilter(): void {
    const query = this.filter.value.trim()
    let test: (name: string) => boolean = () => true
    this.filter.classList.remove('invalid')
    if (query.length > 1 && query.startsWith('/')) {
      try {
        const body = query.endsWith('/') && query.length > 2 ? query.slice(1, -1) : query.slice(1)
        const re = new RegExp(body, 'i')
        test = name => re.test(name)
      } catch {
        this.filter.classList.add('invalid')
        test = () => false
      }
    } else if (query) {
      const needle = query.toLowerCase()
      test = name => name.toLowerCase().includes(needle)
    }
    this.matches = []
    this.columns.forEach((c, i) => {
      if (test(c.name)) this.matches.push(i)
    })
    this.refresh()
    this.list.scrollTop = 0
  }

  /** Redraw after column visibility changed. */
  refresh(): void {
    const hidden = this.grid.hidden.size
    const total = this.columns.length
    let text = this.matches.length === total ? `${fmt.format(total)} columns` : `${fmt.format(this.matches.length)} of ${fmt.format(total)} columns`
    if (hidden) text += ` · ${fmt.format(hidden)} hidden`
    this.summary.textContent = text
    this.listSpacer.style.height = `${this.matches.length * ITEM_HEIGHT}px`
    this.renderList()
  }

  private scrollListTo(index: number): void {
    const top = index * ITEM_HEIGHT
    if (top < this.list.scrollTop || top + ITEM_HEIGHT > this.list.scrollTop + this.list.clientHeight) {
      this.list.scrollTop = top - this.list.clientHeight / 2
    }
    this.renderList()
  }

  private renderList(): void {
    if (this.el.hidden || this.columnsPane.hidden) return
    const first = Math.max(0, Math.floor(this.list.scrollTop / ITEM_HEIGHT) - 2)
    const last = Math.min(this.matches.length, Math.ceil((this.list.scrollTop + this.list.clientHeight) / ITEM_HEIGHT) + 2)
    this.listItems.style.transform = `translateY(${first * ITEM_HEIGHT}px)`
    let k = 0
    for (let i = first; i < last; i++, k++) {
      let item = this.itemPool[k]
      if (!item) {
        const row = el('div', 'item')
        const check = el('input')
        check.type = 'checkbox'
        check.title = 'Show column'
        const name = el('span', 'iname')
        const type = el('span', 'itype')
        row.append(check, name, type)
        this.listItems.append(row)
        item = { row, check, name, type }
        this.itemPool.push(item)
      }
      const col = this.matches[i]
      const meta = this.columns[col]
      item.row.hidden = false
      item.row.dataset.col = String(col)
      item.row.classList.toggle('current', col === this.activeCol)
      item.row.classList.toggle('off', this.grid.hidden.has(col))
      item.check.checked = !this.grid.hidden.has(col)
      item.name.textContent = meta.name
      item.type.textContent = meta.type
      item.row.title = `${meta.name}\n${meta.type}`
    }
    for (let i = k; i < this.itemPool.length; i++) this.itemPool[i].row.hidden = true
  }

  /** The grid's active column changed: highlight it and show its details. */
  setActiveColumn(col: number): void {
    if (col === this.activeCol) return
    this.activeCol = col
    this.renderList()
    clearTimeout(this.infoTimer)
    this.infoTimer = setTimeout(() => this.requestInfo(), 150)
  }

  private requestInfo(): void {
    if (this.el.hidden || this.activeCol < 0 || this.activeCol === this.infoCol) return
    this.infoCol = this.activeCol
    this.post({ type: 'columnInfo', col: this.activeCol })
  }

  onColumnInfo(col: number, items: KeyValue[]): void {
    if (col !== this.activeCol) return
    this.details.replaceChildren(keyValueTable(items))
  }

  onFileInfo(sections: InfoSection[]): void {
    const parts: HTMLElement[] = []
    for (const section of sections) {
      if (section.title) parts.push(el('h3', '', section.title))
      if (section.items) parts.push(keyValueTable(section.items))
      for (const { key, value } of section.details ?? []) {
        const details = el('details')
        details.append(el('summary', '', `${key} (${fmt.format(value.length)} chars)`), el('pre', '', value))
        parts.push(details)
      }
      if (section.table) {
        const table = el('table', 'rowgroups')
        section.table.forEach((cells, i) => {
          const tr = table.insertRow()
          for (const cell of cells) tr.append(el(i ? 'td' : 'th', '', cell))
        })
        parts.push(table)
      }
    }
    this.filePane.replaceChildren(...parts)
  }
}

/** Shows the full value of the active cell. */
export class DetailPanel {
  readonly el = el('div', 'detail')
  private readonly title = el('span', 'detail-title')
  private readonly text = el('pre', 'detail-text')
  private requestId = 0
  private current?: { row: number; col: number }
  private value = ''

  constructor(private readonly post: (msg: WebviewMessage) => void, onClose: () => void) {
    this.el.hidden = true
    const bar = el('div', 'detail-bar')
    const copy = el('button', '', 'Copy')
    const close = el('button', '', '✕')
    copy.title = 'Copy the full value'
    close.title = 'Close (Esc)'
    copy.onclick = () => this.post({ type: 'copyText', text: this.value })
    close.onclick = onClose
    bar.append(this.title, copy, close)
    this.text.tabIndex = 0
    this.el.append(bar, this.text)
    addSash(this.el, 'top', 60, 0.85)
  }

  get visible(): boolean {
    return !this.el.hidden
  }

  show(cell: { row: number; col: number } | undefined, column?: ColumnMeta): void {
    this.el.hidden = false
    if (!cell || !column) {
      this.title.textContent = ''
      this.text.textContent = ''
      return
    }
    if (this.current?.row === cell.row && this.current.col === cell.col) return
    this.current = cell
    this.title.textContent = `Row ${fmt.format(cell.row)} · ${column.name} (${column.type})`
    this.text.classList.add('loading')
    this.post({ type: 'cell', requestId: ++this.requestId, row: cell.row, col: cell.col })
  }

  hide(): void {
    this.el.hidden = true
    this.current = undefined
  }

  /** Forget the current cell, so that the next show() reloads it. */
  reset(): void {
    this.current = undefined
  }

  onCell(msg: Extract<HostMessage, { type: 'cell' }>): void {
    if (msg.requestId !== this.requestId) return
    this.value = msg.isNull ? '' : msg.text
    this.text.textContent = msg.text
    this.text.classList.toggle('null', msg.isNull)
    this.text.classList.remove('loading')
  }
}

export interface MenuItem {
  label: string
  shortcut?: string
  action: () => void
  disabled?: boolean
}

export class ContextMenu {
  readonly el = el('div', 'menu')

  constructor() {
    this.el.hidden = true
    document.addEventListener('mousedown', e => {
      if (!this.el.contains(e.target as Node)) this.hide()
    }, true)
    window.addEventListener('blur', () => this.hide())
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this.el.hidden) {
        this.hide()
        e.stopPropagation()
      }
    }, true)
  }

  show(x: number, y: number, items: (MenuItem | 'separator')[]): void {
    this.el.replaceChildren()
    for (const item of items) {
      if (item === 'separator') {
        this.el.append(el('div', 'menu-sep'))
        continue
      }
      const row = el('div', item.disabled ? 'menu-item disabled' : 'menu-item')
      row.append(el('span', '', item.label), el('span', 'menu-key', item.shortcut ?? ''))
      if (!item.disabled) {
        row.onclick = () => {
          this.hide()
          item.action()
        }
      }
      this.el.append(row)
    }
    this.el.hidden = false
    const { innerWidth, innerHeight } = window
    const rect = this.el.getBoundingClientRect()
    this.el.style.left = `${Math.max(0, Math.min(x, innerWidth - rect.width - 4))}px`
    this.el.style.top = `${Math.max(0, Math.min(y, innerHeight - rect.height - 4))}px`
  }

  hide(): void {
    this.el.hidden = true
  }
}

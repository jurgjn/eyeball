// Virtual grid: renders only the visible rows and columns, for any number of either.
//
// The scroller holds a spacer sized to the table (scaled down when it would exceed what the
// browser can lay out), so it provides native scrollbars. The visible cells live in an overlay
// and are positioned from the "virtual" scroll position (vx, vy), which is the source of truth;
// wheel and keyboard input change it directly and the scrollbars follow proportionally.

import { BLOCK_ROWS, type ColumnMeta, type HostMessage } from '../src/protocol'
import type { DataStore } from './data'

const MAX_SCROLL_PX = 10_000_000
const MIN_WIDTH = 36
const MAX_AUTO_WIDTH = 420
const MAX_HEADER_WIDTH = 280
const CELL_PADDING = 14
/** Columns fetched beyond each side of the viewport. */
const PREFETCH_COLS = 8

export interface Cell {
  row: number
  /** Index into the visible columns (viewCols). */
  vc: number
}

export interface GridEvents {
  activeChanged(): void
  openDetail(): void
  copy(header: boolean): void
  contextMenu(x: number, y: number): void
  goToRow(): void
  findColumn(): void
}

interface PoolCell {
  el: HTMLDivElement
  left: number
  top: number
  width: number
  text: string
  cls: string
}

interface HeaderCell {
  el: HTMLDivElement
  name: HTMLSpanElement
  type: HTMLSpanElement
  col: number
}

function div(className: string, parent?: HTMLElement): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  parent?.appendChild(el)
  return el
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/** First index i in [0, n] with values[i] > x. */
function upperBound(values: Float64Array, n: number, x: number): number {
  let lo = 0
  let hi = n + 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (values[mid] > x) hi = mid
    else lo = mid + 1
  }
  return lo
}

export class Grid {
  readonly el: HTMLDivElement
  private readonly scroller: HTMLDivElement
  private readonly spacer: HTMLDivElement
  private readonly viewport: HTMLDivElement
  private readonly corner: HTMLDivElement
  private readonly header: HTMLDivElement
  private readonly headerInner: HTMLDivElement
  private readonly rowNums: HTMLDivElement
  private readonly rowNumsInner: HTMLDivElement
  private readonly body: HTMLDivElement
  private readonly cells: HTMLDivElement
  private readonly cellPool: PoolCell[] = []
  private readonly headerPool: HeaderCell[] = []
  private readonly rowPool: HTMLDivElement[] = []
  private cellsUsed = 0
  private headersUsed = 0
  private rowsUsed = 0

  numRows = 0
  columns: ColumnMeta[] = []
  private tableKey = ''
  /** Indices of the displayed columns, in order. */
  viewCols: number[] = []
  readonly hidden = new Set<number>()
  private widths: number[] = []
  private readonly userSized = new Set<number>()
  private readonly fitted = new Set<number>()
  private offsets = new Float64Array(1)

  private rowH = 22
  private headerH = 40
  private rowNumW = 50
  private cellFont = '13px monospace'
  private headerFont = '600 13px sans-serif'
  private typeFont = '11px sans-serif'
  private readonly measureCtx: CanvasRenderingContext2D

  private vx = 0
  private vy = 0
  private maxVx = 0
  private maxVy = 0
  private maxScrollLeft = 0
  private maxScrollTop = 0
  private setLeft = 0
  private setTop = 0
  private spacerW = -1
  private spacerH = -1
  private viewW = -1
  private viewH = -1

  /** Selection: the active cell is fixed while the extent moves (shift+arrows, dragging). */
  active: Cell = { row: 0, vc: 0 }
  extent: Cell = { row: 0, vc: 0 }

  private frame = 0
  private renderKey = ''
  private layoutVersion = 0
  private selectionVersion = 0
  private drag?: { kind: 'cells' } | { kind: 'resize'; col: number; startX: number; startWidth: number }
  private dragPoint = { x: 0, y: 0 }
  private dragTimer?: ReturnType<typeof setInterval>
  private readonly numberFormat = new Intl.NumberFormat('en-US')

  constructor(private readonly store: DataStore, private readonly events: GridEvents) {
    this.el = div('grid')
    this.el.tabIndex = 0
    this.scroller = div('scroller', this.el)
    this.spacer = div('spacer', this.scroller)
    this.viewport = div('viewport', this.el)
    this.body = div('body', this.viewport)
    this.cells = div('cells', this.body)
    this.rowNums = div('rownums', this.viewport)
    this.rowNumsInner = div('rownums-inner', this.rowNums)
    this.header = div('header', this.viewport)
    this.headerInner = div('header-inner', this.header)
    this.corner = div('corner', this.viewport)
    this.corner.title = 'Select all'
    this.measureCtx = document.createElement('canvas').getContext('2d')!
    this.updateMetrics()

    this.scroller.addEventListener('scroll', this.onScroll)
    this.el.addEventListener('wheel', this.onWheel, { passive: false })
    this.el.addEventListener('keydown', this.onKeyDown)
    this.body.addEventListener('mousedown', this.onBodyMouseDown)
    this.body.addEventListener('dblclick', e => {
      if (this.cellAt(e.clientX, e.clientY)) this.events.openDetail()
    })
    this.header.addEventListener('mousedown', this.onHeaderMouseDown)
    this.header.addEventListener('dblclick', this.onHeaderDblClick)
    this.rowNums.addEventListener('mousedown', this.onRowNumMouseDown)
    this.corner.addEventListener('mousedown', e => {
      e.preventDefault()
      this.el.focus()
      this.selectAll()
    })
    this.el.addEventListener('contextmenu', e => {
      e.preventDefault()
      this.events.contextMenu(e.clientX, e.clientY)
    })
    document.addEventListener('mousemove', this.onMouseMove)
    document.addEventListener('mouseup', this.onMouseUp)
    new ResizeObserver(() => this.invalidate()).observe(this.el)
    // follow theme and font changes
    const themeObserver = new MutationObserver(() => {
      if (this.updateMetrics()) {
        this.recomputeOffsets()
        this.invalidate()
      }
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  }

  /** Read font settings from the VS Code theme; returns true if they changed. */
  private updateMetrics(): boolean {
    const style = getComputedStyle(document.documentElement)
    const css = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
    const editorSize = parseFloat(css('--vscode-editor-font-size', '13')) || 13
    const uiSize = parseFloat(css('--vscode-font-size', '13')) || 13
    const cellFont = `${editorSize}px ${css('--vscode-editor-font-family', 'monospace')}`
    const headerFont = `600 ${uiSize}px ${css('--vscode-font-family', 'sans-serif')}`
    const typeFont = `${Math.round(uiSize * 0.85)}px ${css('--vscode-font-family', 'sans-serif')}`
    const rowH = Math.max(18, Math.round(editorSize * 1.7))
    const headerH = Math.round(uiSize * 3.3)
    if (cellFont === this.cellFont && headerFont === this.headerFont && rowH === this.rowH && headerH === this.headerH) return false
    this.cellFont = cellFont
    this.headerFont = headerFont
    this.typeFont = typeFont
    this.rowH = rowH
    this.headerH = headerH
    this.el.style.setProperty('--row-h', `${rowH}px`)
    this.el.style.setProperty('--header-h', `${headerH}px`)
    this.updateRowNumWidth()
    this.viewW = -1
    return true
  }

  private measure(text: string, font: string): number {
    this.measureCtx.font = font
    return this.measureCtx.measureText(text).width
  }

  private updateRowNumWidth(): void {
    this.rowNumW = Math.max(44, Math.ceil(this.measure(this.numberFormat.format(Math.max(0, this.numRows - 1)), this.cellFont)) + 20)
  }

  /**
   * Show a table. Keeps the view (position, widths, hidden columns) when the same table is
   * shown again (e.g. after the file changed) with the same columns.
   */
  setTable(key: string, numRows: number, columns: ColumnMeta[]): void {
    const sameColumns = key === this.tableKey && columns.length === this.columns.length &&
      columns.every((c, i) => c.name === this.columns[i].name && c.type === this.columns[i].type)
    this.tableKey = key
    this.numRows = numRows
    this.columns = columns
    if (!sameColumns) {
      // header cells cache their labels by column index; a new table reuses the indices
      for (const cell of this.headerPool) cell.col = -1
      this.hidden.clear()
      this.userSized.clear()
      this.fitted.clear()
      const approximate = columns.length > 20000
      const charWidth = this.measure('abcdefghijklmnopqrstuvwxyz', this.headerFont) / 26
      this.widths = columns.map(c => {
        const header = approximate
          ? Math.max(c.name.length, c.type.length * 0.85) * charWidth
          : Math.max(this.measure(c.name, this.headerFont), this.measure(c.type, this.typeFont))
        return clamp(Math.ceil(header) + CELL_PADDING + 4, defaultWidth(c), MAX_HEADER_WIDTH)
      })
      this.vx = 0
      this.vy = 0
      this.active = { row: 0, vc: 0 }
      this.extent = { row: 0, vc: 0 }
    } else {
      this.fitted.clear()
    }
    this.updateRowNumWidth()
    this.updateViewCols()
    this.clampSelection()
    this.viewW = -1
    this.invalidate()
    this.events.activeChanged()
  }

  /** More rows became available (rows are still being counted). */
  setRowCount(numRows: number): void {
    if (numRows === this.numRows) return
    this.numRows = numRows
    const width = this.rowNumW
    this.updateRowNumWidth()
    if (width !== this.rowNumW) this.viewW = -1
    this.clampSelection()
    this.invalidate()
  }

  private updateViewCols(): void {
    this.viewCols = []
    for (let c = 0; c < this.columns.length; c++) if (!this.hidden.has(c)) this.viewCols.push(c)
    this.recomputeOffsets()
  }

  private recomputeOffsets(): void {
    const n = this.viewCols.length
    if (this.offsets.length !== n + 1) this.offsets = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) this.offsets[i + 1] = this.offsets[i] + this.widths[this.viewCols[i]]
    this.layoutVersion++
  }

  private clampSelection(): void {
    const maxRow = Math.max(0, this.numRows - 1)
    const maxVc = Math.max(0, this.viewCols.length - 1)
    this.active = { row: clamp(this.active.row, 0, maxRow), vc: clamp(this.active.vc, 0, maxVc) }
    this.extent = { row: clamp(this.extent.row, 0, maxRow), vc: clamp(this.extent.vc, 0, maxVc) }
    this.selectionVersion++
  }

  // ---- public API ----

  invalidate(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render())
  }

  focus(): void {
    this.el.focus({ preventScroll: true })
  }

  /**
   * Data arrived: fit columns to their values (the first time a column gets data), and widen
   * columns whose new values don't fit. Columns are never narrowed automatically, and columns
   * resized by the user are left alone.
   */
  onData(msg: Extract<HostMessage, { type: 'data' }>): void {
    let changed = false
    msg.cols.forEach((col, i) => {
      if (this.userSized.has(col)) return
      const width = this.fitWidth(col, msg.values[i])
      const first = !this.fitted.has(col)
      this.fitted.add(col)
      if (first ? width !== this.widths[col] : width > this.widths[col]) {
        this.widths[col] = width
        changed = true
      }
    })
    if (changed) this.relayoutKeepingView()
    this.invalidate()
  }

  /** Recompute column positions after widths changed, without moving what the user is looking at. */
  private relayoutKeepingView(): void {
    const n = this.viewCols.length
    const { bodyW } = this.bodySize()
    const activeVisible = n > 0 && this.offsets[this.active.vc] >= this.vx && this.offsets[this.active.vc + 1] <= this.vx + bodyW
    // keep the first visible column where it is
    const c0 = clamp(upperBound(this.offsets, n, this.vx) - 1, 0, n)
    const delta = this.vx - this.offsets[c0]
    const col = this.viewCols[c0]
    this.recomputeOffsets()
    const vc = col === undefined ? -1 : this.viewCols.indexOf(col)
    if (vc >= 0) this.vx = this.offsets[vc] + Math.min(delta, this.widths[col])
    // ... but if the active cell was in view (e.g. after End), keep it in view
    if (activeVisible) this.scrollIntoView(this.active)
  }

  private fitWidth(col: number, values: (string | null)[]): number {
    const meta = this.columns[col]
    const header = Math.min(MAX_HEADER_WIDTH, Math.max(this.measure(meta.name, this.headerFont), this.measure(meta.type, this.typeFont)))
    // measure the longest few values
    const texts = values.filter((v): v is string => v !== null).sort((a, b) => b.length - a.length).slice(0, 6)
    if (values.includes(null)) texts.push('null')
    let content = 0
    for (const text of texts) content = Math.max(content, this.measure(text.length > 120 ? text.slice(0, 120) : text, this.cellFont))
    return clamp(Math.ceil(Math.max(header, content)) + CELL_PADDING + 4, MIN_WIDTH, MAX_AUTO_WIDTH)
  }

  /** Fit columns to the values currently loaded for the visible rows. */
  autofit(cols: number[]): void {
    const { r0, r1 } = this.visibleRows()
    for (const col of cols) {
      const values: (string | null)[] = []
      for (let block = Math.floor(r0 / BLOCK_ROWS); block * BLOCK_ROWS < r1; block++) {
        const entry = this.store.get(block, col)
        if (Array.isArray(entry)) values.push(...entry)
      }
      this.widths[col] = this.fitWidth(col, values)
      this.userSized.add(col)
    }
    this.relayoutKeepingView()
    this.invalidate()
  }

  goToRow(row: number): void {
    if (!this.numRows) return
    row = clamp(row, 0, this.numRows - 1)
    const { bodyH } = this.bodySize()
    // put the row a few lines below the top
    this.vy = Math.max(0, row * this.rowH - Math.min(3 * this.rowH, bodyH / 3))
    this.setActive({ row, vc: this.active.vc }, false, false)
    this.invalidate()
  }

  /** Scroll to a column (showing it if it is hidden) and make it active. */
  revealColumn(col: number): void {
    if (this.hidden.has(col)) {
      this.hidden.delete(col)
      this.updateViewCols()
    }
    const vc = this.viewCols.indexOf(col)
    if (vc < 0) return
    const { bodyW } = this.bodySize()
    const left = this.offsets[vc]
    const right = this.offsets[vc + 1]
    if (left < this.vx || right > this.vx + bodyW) this.vx = Math.max(0, left - Math.min(40, bodyW / 4))
    this.setActive({ row: this.active.row, vc }, false, false)
  }

  setHidden(cols: Iterable<number>, hidden: boolean): void {
    const activeCol = this.viewCols[this.active.vc]
    for (const c of cols) {
      if (hidden) this.hidden.add(c)
      else this.hidden.delete(c)
    }
    this.updateViewCols()
    // keep the active column, or the nearest visible one
    let vc = activeCol === undefined ? 0 : this.viewCols.indexOf(activeCol)
    if (vc < 0) vc = this.viewCols.findIndex(c => c > activeCol)
    if (vc < 0) vc = this.viewCols.length - 1
    this.active = { row: this.active.row, vc: Math.max(0, vc) }
    this.extent = { ...this.active }
    this.clampSelection()
    this.invalidate()
    this.events.activeChanged()
  }

  /** The selected rows and (displayed) columns. */
  selection(): { rowStart: number; rowEnd: number; cols: number[] } {
    const r0 = Math.min(this.active.row, this.extent.row)
    const r1 = Math.max(this.active.row, this.extent.row)
    const c0 = Math.min(this.active.vc, this.extent.vc)
    const c1 = Math.max(this.active.vc, this.extent.vc)
    return { rowStart: r0, rowEnd: Math.min(this.numRows, r1 + 1), cols: this.viewCols.slice(c0, c1 + 1) }
  }

  activeCell(): { row: number; col: number } | undefined {
    const col = this.viewCols[this.active.vc]
    if (col === undefined || !this.numRows) return undefined
    return { row: this.active.row, col }
  }

  selectAll(): void {
    if (!this.viewCols.length) return
    this.active = { row: 0, vc: 0 }
    this.extent = { row: Math.max(0, this.numRows - 1), vc: this.viewCols.length - 1 }
    this.selectionChanged()
  }

  // ---- geometry ----

  private bodySize(): { bodyW: number; bodyH: number } {
    return {
      bodyW: Math.max(0, this.scroller.clientWidth - this.rowNumW),
      bodyH: Math.max(0, this.scroller.clientHeight - this.headerH),
    }
  }

  private visibleRows(): { r0: number; r1: number } {
    const { bodyH } = this.bodySize()
    const r0 = Math.min(Math.floor(this.vy / this.rowH), Math.max(0, this.numRows - 1))
    const r1 = Math.min(this.numRows, Math.ceil((this.vy + bodyH) / this.rowH))
    return { r0, r1 }
  }

  /** The cell under a point; points outside the body map to the nearest cell. */
  private cellAt(clientX: number, clientY: number): Cell | undefined {
    if (!this.numRows || !this.viewCols.length) return undefined
    const rect = this.body.getBoundingClientRect()
    const x = clientX - rect.left + this.vx
    const y = clientY - rect.top + this.vy
    const n = this.viewCols.length
    return {
      row: clamp(Math.floor(y / this.rowH), 0, this.numRows - 1),
      vc: clamp(upperBound(this.offsets, n, x) - 1, 0, n - 1),
    }
  }

  private scrollIntoView(cell: Cell): void {
    const { bodyW, bodyH } = this.bodySize()
    const top = cell.row * this.rowH
    if (top < this.vy) this.vy = top
    else if (top + this.rowH > this.vy + bodyH) this.vy = top + this.rowH - bodyH
    const left = this.offsets[cell.vc]
    const right = this.offsets[cell.vc + 1]
    if (left < this.vx) this.vx = left
    else if (right > this.vx + bodyW) this.vx = Math.min(left, right - bodyW)
  }

  // ---- selection ----

  private setActive(cell: Cell, extend: boolean, scroll = true): void {
    if (extend) {
      this.extent = cell
    } else {
      this.active = cell
      this.extent = { ...cell }
    }
    if (scroll) this.scrollIntoView(cell)
    this.selectionChanged()
  }

  private selectionChanged(): void {
    this.selectionVersion++
    this.invalidate()
    this.events.activeChanged()
  }

  private move(dRow: number, dCol: number, extend: boolean): void {
    if (!this.numRows || !this.viewCols.length) return
    const from = extend ? this.extent : this.active
    this.setActive({
      row: clamp(from.row + dRow, 0, this.numRows - 1),
      vc: clamp(from.vc + dCol, 0, this.viewCols.length - 1),
    }, extend)
  }

  private inSelection(cell: Cell): boolean {
    return cell.row >= Math.min(this.active.row, this.extent.row) && cell.row <= Math.max(this.active.row, this.extent.row) &&
      cell.vc >= Math.min(this.active.vc, this.extent.vc) && cell.vc <= Math.max(this.active.vc, this.extent.vc)
  }

  // ---- input ----

  private readonly onScroll = (): void => {
    const left = this.scroller.scrollLeft
    const top = this.scroller.scrollTop
    let changed = false
    // ignore the scroll events caused by our own scrollbar updates
    if (Math.abs(left - this.setLeft) > 1) {
      this.vx = this.maxScrollLeft ? left / this.maxScrollLeft * this.maxVx : 0
      this.setLeft = left
      changed = true
    }
    if (Math.abs(top - this.setTop) > 1) {
      this.vy = this.maxScrollTop ? top / this.maxScrollTop * this.maxVy : 0
      this.setTop = top
      changed = true
    }
    if (changed) this.invalidate()
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey) return // pinch / zoom
    e.preventDefault()
    const { bodyW, bodyH } = this.bodySize()
    let dx = e.deltaX
    let dy = e.deltaY
    if (e.deltaMode === 1) {
      dx *= this.rowH
      dy *= this.rowH
    } else if (e.deltaMode === 2) {
      dx *= bodyW
      dy *= bodyH
    }
    if (e.shiftKey && !dx) {
      dx = dy
      dy = 0
    }
    this.vx = clamp(this.vx + dx, 0, this.maxVx)
    this.vy = clamp(this.vy + dy, 0, this.maxVy)
    this.invalidate()
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // leave Alt combinations and Ctrl+PageUp/PageDown (switch editor) to VS Code
    if (e.altKey) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && (e.key === 'PageUp' || e.key === 'PageDown')) return
    const n = this.viewCols.length
    const { bodyH } = this.bodySize()
    const page = Math.max(1, Math.floor(bodyH / this.rowH) - 1)
    switch (e.key) {
      case 'ArrowDown': this.move(mod ? this.numRows : 1, 0, e.shiftKey); break
      case 'ArrowUp': this.move(mod ? -this.numRows : -1, 0, e.shiftKey); break
      case 'ArrowRight': this.move(0, mod ? n : 1, e.shiftKey); break
      case 'ArrowLeft': this.move(0, mod ? -n : -1, e.shiftKey); break
      case 'PageDown':
        this.vy += page * this.rowH
        this.move(page, 0, e.shiftKey)
        break
      case 'PageUp':
        this.vy = Math.max(0, this.vy - page * this.rowH)
        this.move(-page, 0, e.shiftKey)
        break
      case 'Home': this.move(mod ? -this.numRows : 0, -n, e.shiftKey); break
      case 'End': this.move(mod ? this.numRows : 0, n, e.shiftKey); break
      case 'Tab': this.move(0, e.shiftKey ? -1 : 1, false); break
      case 'Enter':
      case ' ':
        this.events.openDetail()
        break
      case 'Escape':
        this.extent = { ...this.active }
        this.selectionChanged()
        break
      default: {
        const key = e.key.toLowerCase()
        if (mod && key === 'c') this.events.copy(e.shiftKey)
        else if (mod && key === 'a') this.selectAll()
        else if (mod && key === 'g') this.events.goToRow()
        else if (mod && key === 'f') this.events.findColumn()
        else return
      }
    }
    e.preventDefault()
    e.stopPropagation()
  }

  private readonly onBodyMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0 && e.button !== 2) return
    this.focus()
    const cell = this.cellAt(e.clientX, e.clientY)
    if (!cell) return
    if (e.button === 2) {
      // right-click keeps an existing selection that contains the cell
      if (!this.inSelection(cell)) this.setActive(cell, false, false)
      return
    }
    e.preventDefault()
    this.setActive(cell, e.shiftKey, false)
    this.drag = { kind: 'cells' }
    this.dragPoint = { x: e.clientX, y: e.clientY }
    // keep extending (and scrolling) while the pointer rests outside the grid
    this.dragTimer = setInterval(() => {
      const rect = this.body.getBoundingClientRect()
      const { x, y } = this.dragPoint
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) this.dragTo(x, y)
    }, 50)
  }

  private dragTo(x: number, y: number): void {
    const cell = this.cellAt(x, y)
    if (cell) this.setActive(cell, true)
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.drag) return
    if (this.drag.kind === 'cells') {
      this.dragPoint = { x: e.clientX, y: e.clientY }
      this.dragTo(e.clientX, e.clientY)
    } else {
      const { col, startX, startWidth } = this.drag
      this.widths[col] = Math.max(MIN_WIDTH, Math.round(startWidth + e.clientX - startX))
      this.userSized.add(col)
      this.recomputeOffsets()
      this.invalidate()
    }
  }

  private readonly onMouseUp = (): void => {
    this.drag = undefined
    clearInterval(this.dragTimer)
    document.body.classList.remove('resizing')
  }

  private readonly onHeaderMouseDown = (e: MouseEvent): void => {
    const target = e.target as HTMLElement
    const headerCell = target.closest<HTMLElement>('.h')
    if (!headerCell) return
    const vc = Number(headerCell.dataset.vc)
    const col = this.viewCols[vc]
    if (col === undefined) return
    if (target.classList.contains('rs') && e.button === 0) {
      e.preventDefault()
      this.drag = { kind: 'resize', col, startX: e.clientX, startWidth: this.widths[col] }
      document.body.classList.add('resizing')
      return
    }
    this.focus()
    if (e.button === 2 && this.inSelection({ row: this.active.row, vc })) return
    e.preventDefault()
    const lastRow = Math.max(0, this.numRows - 1)
    if (e.shiftKey) {
      this.active = { row: 0, vc: this.active.vc }
      this.extent = { row: lastRow, vc }
    } else {
      this.active = { row: 0, vc }
      this.extent = { row: lastRow, vc }
    }
    this.selectionChanged()
  }

  private readonly onHeaderDblClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('rs')) return
    const vc = Number(target.closest<HTMLElement>('.h')?.dataset.vc)
    const col = this.viewCols[vc]
    if (col !== undefined) this.autofit([col])
  }

  private readonly onRowNumMouseDown = (e: MouseEvent): void => {
    if (!this.numRows || !this.viewCols.length) return
    this.focus()
    const rect = this.rowNums.getBoundingClientRect()
    const row = clamp(Math.floor((e.clientY - rect.top + this.vy) / this.rowH), 0, this.numRows - 1)
    if (e.button === 2 && this.inSelection({ row, vc: this.active.vc })) return
    e.preventDefault()
    const lastVc = this.viewCols.length - 1
    if (e.shiftKey) {
      this.active = { row: this.active.row, vc: 0 }
      this.extent = { row, vc: lastVc }
    } else {
      this.active = { row, vc: 0 }
      this.extent = { row, vc: lastVc }
    }
    this.selectionChanged()
  }

  // ---- rendering ----

  private render(): void {
    this.frame = 0
    const sw = this.scroller.clientWidth
    const sh = this.scroller.clientHeight
    if (sw !== this.viewW || sh !== this.viewH) {
      this.viewW = sw
      this.viewH = sh
      const { rowNumW, headerH } = this
      Object.assign(this.viewport.style, { width: `${sw}px`, height: `${sh}px` })
      Object.assign(this.corner.style, { width: `${rowNumW}px`, height: `${headerH}px` })
      Object.assign(this.header.style, { left: `${rowNumW}px`, width: `${Math.max(0, sw - rowNumW)}px`, height: `${headerH}px` })
      Object.assign(this.rowNums.style, { top: `${headerH}px`, width: `${rowNumW}px`, height: `${Math.max(0, sh - headerH)}px` })
      Object.assign(this.body.style, { left: `${rowNumW}px`, top: `${headerH}px`, width: `${Math.max(0, sw - rowNumW)}px`, height: `${Math.max(0, sh - headerH)}px` })
      this.layoutVersion++
    }
    const { bodyW, bodyH } = this.bodySize()
    const n = this.viewCols.length
    const totalW = this.offsets[n]
    const totalH = this.numRows * this.rowH

    // scroll extent, scaled down for huge tables
    const spacerW = this.rowNumW + Math.min(totalW, MAX_SCROLL_PX)
    const spacerH = this.headerH + Math.min(totalH, MAX_SCROLL_PX)
    if (spacerW !== this.spacerW || spacerH !== this.spacerH) {
      this.spacerW = spacerW
      this.spacerH = spacerH
      this.spacer.style.width = `${spacerW}px`
      this.spacer.style.height = `${spacerH}px`
    }
    this.maxVx = Math.max(0, totalW - bodyW)
    this.maxVy = Math.max(0, totalH - bodyH)
    this.vx = clamp(this.vx, 0, this.maxVx)
    this.vy = clamp(this.vy, 0, this.maxVy)
    this.maxScrollLeft = Math.max(0, spacerW - sw)
    this.maxScrollTop = Math.max(0, spacerH - sh)
    const left = this.maxVx ? this.vx / this.maxVx * this.maxScrollLeft : 0
    const top = this.maxVy ? this.vy / this.maxVy * this.maxScrollTop : 0
    if (Math.abs(this.scroller.scrollLeft - left) > 1) {
      this.scroller.scrollLeft = left
      this.setLeft = this.scroller.scrollLeft
    }
    if (Math.abs(this.scroller.scrollTop - top) > 1) {
      this.scroller.scrollTop = top
      this.setTop = this.scroller.scrollTop
    }

    // visible range
    const { r0, r1 } = this.visibleRows()
    const c0 = n ? clamp(upperBound(this.offsets, n, this.vx) - 1, 0, n - 1) : 0
    let c1 = c0
    while (c1 < n && this.offsets[c1] < this.vx + bodyW) c1++

    const tx = n ? this.offsets[c0] - this.vx : 0
    const ty = r0 * this.rowH - this.vy
    this.cells.style.transform = `translate(${tx}px, ${ty}px)`
    this.headerInner.style.transform = `translateX(${tx}px)`
    this.rowNumsInner.style.transform = `translateY(${ty}px)`

    const key = `${r0},${r1},${c0},${c1},${this.store.version},${this.selectionVersion},${this.layoutVersion}`
    if (key !== this.renderKey) {
      this.renderKey = key
      this.renderCells(r0, r1, c0, c1)
      this.renderHeader(c0, c1)
      this.renderRowNums(r0, r1)
    }
    this.requestData(r0, r1, c0, c1)
  }

  private renderCells(r0: number, r1: number, c0: number, c1: number): void {
    const sr0 = Math.min(this.active.row, this.extent.row)
    const sr1 = Math.max(this.active.row, this.extent.row)
    const sc0 = Math.min(this.active.vc, this.extent.vc)
    const sc1 = Math.max(this.active.vc, this.extent.vc)
    const x0 = this.offsets[c0]
    let k = 0
    for (let vc = c0; vc < c1; vc++) {
      const col = this.viewCols[vc]
      const numeric = this.columns[col].numeric
      const left = this.offsets[vc] - x0
      const width = this.offsets[vc + 1] - this.offsets[vc]
      let block = -1
      let entry: ReturnType<DataStore['get']>
      for (let row = r0; row < r1; row++) {
        const b = Math.floor(row / BLOCK_ROWS)
        if (b !== block) {
          block = b
          entry = this.store.get(b, col)
        }
        let text: string
        let cls = numeric ? 'c n' : 'c'
        if (row & 1) cls += ' o'
        if (entry === undefined) {
          text = ''
          cls += ' ld'
        } else if (!Array.isArray(entry)) {
          text = '⚠ error'
          cls += ' err'
        } else {
          const value = entry[row - b * BLOCK_ROWS]
          if (value === null) {
            text = 'null'
            cls += ' null'
          } else {
            text = value ?? ''
          }
        }
        if (row >= sr0 && row <= sr1 && vc >= sc0 && vc <= sc1) cls += ' sel'
        if (row === this.active.row && vc === this.active.vc) cls += ' act'
        const cell = this.cellPool[k] ?? this.newCell()
        k++
        const top = (row - r0) * this.rowH
        if (cell.left !== left) cell.el.style.left = `${(cell.left = left)}px`
        if (cell.top !== top) cell.el.style.top = `${(cell.top = top)}px`
        if (cell.width !== width) cell.el.style.width = `${(cell.width = width)}px`
        if (cell.text !== text) cell.el.textContent = cell.text = text
        if (cell.cls !== cls) cell.el.className = cell.cls = cls
        if (cell.el.hidden) cell.el.hidden = false
        if (entry !== undefined && !Array.isArray(entry)) cell.el.title = entry.error
        else if (cell.el.title) cell.el.title = ''
      }
    }
    for (let i = k; i < this.cellsUsed; i++) this.cellPool[i].el.hidden = true
    this.cellsUsed = k
  }

  private newCell(): PoolCell {
    const cell = { el: div('c', this.cells), left: -1, top: -1, width: -1, text: '', cls: 'c' }
    this.cellPool.push(cell)
    return cell
  }

  private renderHeader(c0: number, c1: number): void {
    const sc0 = Math.min(this.active.vc, this.extent.vc)
    const sc1 = Math.max(this.active.vc, this.extent.vc)
    const x0 = this.offsets[c0]
    let k = 0
    for (let vc = c0; vc < c1; vc++) {
      const col = this.viewCols[vc]
      const meta = this.columns[col]
      let cell = this.headerPool[k]
      if (!cell) {
        const el = div('h', this.headerInner)
        const name = document.createElement('span')
        name.className = 'hn'
        const type = document.createElement('span')
        type.className = 'ht'
        el.append(name, type)
        div('rs', el).title = 'Drag to resize, double-click to fit'
        cell = { el, name, type, col: -1 }
        this.headerPool.push(cell)
      }
      k++
      if (cell.col !== col) {
        cell.col = col
        cell.name.textContent = meta.name
        cell.type.textContent = meta.type
        cell.el.title = `${meta.name}\n${meta.type}\ncolumn ${col + 1} of ${this.columns.length}`
      }
      cell.el.dataset.vc = String(vc)
      cell.el.style.left = `${this.offsets[vc] - x0}px`
      cell.el.style.width = `${this.offsets[vc + 1] - this.offsets[vc]}px`
      cell.el.className = `h${meta.numeric ? ' n' : ''}${vc >= sc0 && vc <= sc1 ? ' hsel' : ''}`
      cell.el.hidden = false
    }
    for (let i = k; i < this.headersUsed; i++) this.headerPool[i].el.hidden = true
    this.headersUsed = k
  }

  private renderRowNums(r0: number, r1: number): void {
    const sr0 = Math.min(this.active.row, this.extent.row)
    const sr1 = Math.max(this.active.row, this.extent.row)
    let k = 0
    for (let row = r0; row < r1; row++) {
      const el = this.rowPool[k] ?? this.rowPool[this.rowPool.push(div('r', this.rowNumsInner)) - 1]
      k++
      el.textContent = this.numberFormat.format(row)
      el.style.top = `${(row - r0) * this.rowH}px`
      el.className = row >= sr0 && row <= sr1 ? 'r rsel' : 'r'
      el.hidden = false
    }
    for (let i = k; i < this.rowsUsed; i++) this.rowPool[i].hidden = true
    this.rowsUsed = k
  }

  private requestData(r0: number, r1: number, c0: number, c1: number): void {
    if (!this.numRows || !this.viewCols.length) return
    const blockOf = (row: number) => Math.floor(row / BLOCK_ROWS)
    const blocks: number[] = []
    for (let b = blockOf(r0); b <= blockOf(Math.max(r0, r1 - 1)); b++) blocks.push(b)
    // prefetch a screen above and below
    const span = Math.max(1, r1 - r0)
    const more: number[] = []
    const below = blockOf(Math.min(this.numRows - 1, r1 + span))
    const above = blockOf(Math.max(0, r0 - span))
    for (let b = blocks[blocks.length - 1] + 1; b <= below; b++) more.push(b)
    for (let b = blocks[0] - 1; b >= above; b--) more.push(b)
    const cols = this.viewCols.slice(c0, c1)
    const moreCols = [
      ...this.viewCols.slice(c1, c1 + PREFETCH_COLS),
      ...this.viewCols.slice(Math.max(0, c0 - PREFETCH_COLS), c0),
    ]
    this.store.want(blocks, cols, more, moreCols)
  }
}

/** Initial column width for a type, before any values have been seen. */
function defaultWidth(column: ColumnMeta): number {
  const type = column.type
  if (column.numeric) return 72
  if (type === 'bool') return 56
  if (type === 'date') return 96
  if (type.startsWith('timestamp')) return 170
  if (type.startsWith('time')) return 96
  if (/^(list|struct|map|variant)/.test(type)) return 180
  if (/^(string|binary|json|enum|uuid)/.test(type)) return 120
  return 80
}

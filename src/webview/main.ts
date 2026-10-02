import type { ColumnInfo, HostToWebviewMessage, SortSpec, WebviewToHostMessage } from '../shared/protocol';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const ROW_HEIGHT = 22;
const BLOCK_SIZE = 200;
const BUFFER_ROWS = 20;

let columns: ColumnInfo[] = [];
let sort: SortSpec | undefined;
let totalRows: number | null = null;
let estimatedRows = BLOCK_SIZE * 3;
let nextRequestId = 1;
let generation = 0; // bumped on sort/table change so stale responses are dropped

const blockCache = new Map<number, unknown[][] | 'loading'>();
const pendingRequests = new Map<number, { blockIndex: number; generation: number }>();

const els = {
  fileName: document.getElementById('file-name')!,
  tableSelect: document.getElementById('table-select') as HTMLSelectElement,
  status: document.getElementById('status')!,
  gridHeader: document.getElementById('grid-header')!,
  gridScroll: document.getElementById('grid-scroll')!,
  gridSpacer: document.getElementById('grid-spacer')!,
  gridRows: document.getElementById('grid-rows')!,
  errorBanner: document.getElementById('error-banner')!,
};

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init': {
      els.fileName.textContent = msg.fileName;
      columns = msg.columns;
      renderHeader();
      if (msg.tables && msg.tables.length > 1) {
        els.tableSelect.style.display = '';
        els.tableSelect.innerHTML = msg.tables
          .map((t) => `<option value="${escapeAttr(t)}"${t === msg.currentTable ? ' selected' : ''}>${escapeHtml(t)}</option>`)
          .join('');
      } else {
        els.tableSelect.style.display = 'none';
      }
      resetAndReload();
      break;
    }
    case 'columns':
      columns = msg.columns;
      renderHeader();
      resetAndReload();
      break;
    case 'rowCount':
      totalRows = msg.count;
      updateSpacer();
      updateStatus();
      break;
    case 'rows': {
      const pending = pendingRequests.get(msg.requestId);
      pendingRequests.delete(msg.requestId);
      if (!pending || pending.generation !== generation) return; // stale, discard
      blockCache.set(pending.blockIndex, msg.rows);
      renderVisible();
      break;
    }
    case 'error':
      showError(msg.message);
      break;
  }
});

els.tableSelect.addEventListener('change', () => {
  hideError();
  vscode.postMessage({ type: 'selectTable', table: els.tableSelect.value });
});

els.gridScroll.addEventListener('scroll', () => {
  requestAnimationFrame(renderVisible);
});

window.addEventListener('resize', () => requestAnimationFrame(renderVisible));

function resetAndReload(): void {
  generation++;
  blockCache.clear();
  pendingRequests.clear();
  totalRows = null;
  estimatedRows = BLOCK_SIZE * 3;
  els.gridScroll.scrollTop = 0;
  updateSpacer();
  updateStatus();
  renderVisible();
}

function renderHeader(): void {
  els.gridHeader.innerHTML = '';
  const headerRow = document.createElement('div');
  headerRow.className = 'row';
  headerRow.style.gridTemplateColumns = gridTemplate();

  for (const col of columns) {
    const cell = document.createElement('div');
    cell.className = 'cell header-cell';
    cell.textContent = col.name;
    cell.title = `${col.name} (${col.type})`;
    if (sort?.column === col.name) {
      cell.classList.add(sort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
    }
    cell.addEventListener('click', () => {
      hideError();
      if (sort?.column === col.name) {
        sort = sort.direction === 'asc' ? { column: col.name, direction: 'desc' } : undefined;
      } else {
        sort = { column: col.name, direction: 'asc' };
      }
      renderHeader();
      resetAndReload();
    });
    headerRow.appendChild(cell);
  }
  els.gridHeader.appendChild(headerRow);
}

function gridTemplate(): string {
  return columns.map(() => 'minmax(120px, 1fr)').join(' ') || '1fr';
}

function totalRowsEstimate(): number {
  return totalRows ?? estimatedRows;
}

function updateSpacer(): void {
  els.gridSpacer.style.height = `${totalRowsEstimate() * ROW_HEIGHT}px`;
}

function updateStatus(): void {
  const rowsLabel = totalRows === null ? 'counting…' : totalRows.toLocaleString();
  els.status.textContent = `${rowsLabel} rows · ${columns.length} cols`;
}

function renderVisible(): void {
  const scrollTop = els.gridScroll.scrollTop;
  const viewportHeight = els.gridScroll.clientHeight;
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
  const lastRowWanted = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + BUFFER_ROWS;

  if (totalRows === null && lastRowWanted > estimatedRows - BLOCK_SIZE) {
    estimatedRows = lastRowWanted + BLOCK_SIZE * 3;
    updateSpacer();
  }

  const lastRow = Math.min(lastRowWanted, totalRowsEstimate());
  const firstBlock = Math.floor(firstRow / BLOCK_SIZE);
  const lastBlock = Math.max(firstBlock, Math.floor(lastRow / BLOCK_SIZE));
  const template = gridTemplate();

  const frag = document.createDocumentFragment();
  for (let b = firstBlock; b <= lastBlock; b++) {
    const cached = blockCache.get(b);
    if (cached === undefined) {
      requestBlock(b);
      continue;
    }
    if (cached === 'loading') continue;

    const blockOffset = b * BLOCK_SIZE;
    for (let i = 0; i < cached.length; i++) {
      const rowIndex = blockOffset + i;
      if (rowIndex < firstRow || rowIndex > lastRow) continue;
      frag.appendChild(buildRowElement(rowIndex, cached[i], template));
    }
  }
  els.gridRows.innerHTML = '';
  els.gridRows.appendChild(frag);
}

function buildRowElement(rowIndex: number, values: unknown[], template: string): HTMLElement {
  const rowEl = document.createElement('div');
  rowEl.className = 'row data-row' + (rowIndex % 2 === 1 ? ' odd' : '');
  rowEl.style.gridTemplateColumns = template;
  rowEl.style.top = `${rowIndex * ROW_HEIGHT}px`;
  for (const v of values) {
    const cell = document.createElement('div');
    const formatted = formatValue(v);
    cell.className = 'cell' + (v === null || v === undefined ? ' null-value' : '');
    cell.textContent = formatted;
    cell.title = formatted;
    rowEl.appendChild(cell);
  }
  return rowEl;
}

function requestBlock(blockIndex: number): void {
  blockCache.set(blockIndex, 'loading');
  const requestId = nextRequestId++;
  pendingRequests.set(requestId, { blockIndex, generation });
  vscode.postMessage({
    type: 'getRows',
    requestId,
    offset: blockIndex * BLOCK_SIZE,
    limit: BLOCK_SIZE,
    sort,
  });
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  return String(v);
}

function showError(message: string): void {
  els.errorBanner.style.display = '';
  els.errorBanner.textContent = message;
}

function hideError(): void {
  els.errorBanner.style.display = 'none';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

vscode.postMessage({ type: 'ready' });

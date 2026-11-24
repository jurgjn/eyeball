import * as path from 'node:path'
import * as vscode from 'vscode'
import { BLOCK_ROWS, type BlockRequest, type CellText, type HostMessage, type WebviewMessage } from './protocol'
import { LruCache } from './reader/lru'
import { memorySource, openFileSource } from './reader/source'
import { ParquetTable } from './reader/table'

export const VIEW_TYPE = 'eyeball.parquet'
const MAX_COPY_CELLS = 2_000_000
/** Workers serving block requests per editor. */
const WORKERS = 2

function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('eyeball').get<T>(key, fallback)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An open Parquet file, shared by all editors showing it. */
class ParquetDocument implements vscode.CustomDocument {
  private tablePromise: Promise<ParquetTable>
  private readonly watcher?: vscode.FileSystemWatcher
  private reloadTimer?: ReturnType<typeof setTimeout>
  private readonly reloadEmitter = new vscode.EventEmitter<void>()
  readonly onDidReload = this.reloadEmitter.event

  constructor(readonly uri: vscode.Uri, private readonly cache: LruCache<unknown>) {
    this.tablePromise = this.open()
    // errors are reported to the webview when it asks for the table
    this.tablePromise.catch(() => {})
    if (uri.scheme === 'file') {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath))
      this.watcher = vscode.workspace.createFileSystemWatcher(pattern)
      this.watcher.onDidChange(() => this.scheduleReload())
      this.watcher.onDidCreate(() => this.scheduleReload())
    }
  }

  get table(): Promise<ParquetTable> {
    return this.tablePromise
  }

  get fileName(): string {
    return path.posix.basename(this.uri.path)
  }

  private async open(): Promise<ParquetTable> {
    const source = this.uri.scheme === 'file'
      ? await openFileSource(this.uri.fsPath)
      : memorySource(await vscode.workspace.fs.readFile(this.uri))
    try {
      return await ParquetTable.open(source, this.cache)
    } catch (error) {
      await source.close()
      throw error
    }
  }

  private scheduleReload(): void {
    // writers touch the file several times; wait until it has settled
    clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => this.reload(), 1000)
  }

  private reload(): void {
    const old = this.tablePromise
    this.tablePromise = this.open()
    this.tablePromise.catch(() => {})
    // let requests still running on the old table finish before closing it
    old.then(table => setTimeout(() => table.dispose(), 30_000), () => {})
    this.reloadEmitter.fire()
  }

  dispose(): void {
    clearTimeout(this.reloadTimer)
    this.watcher?.dispose()
    this.reloadEmitter.dispose()
    this.tablePromise.then(table => table.dispose(), () => {})
  }
}

/** Connects one webview to its document: answers data requests and other messages. */
class EditorSession {
  private queue: BlockRequest[] = []
  private workers = 0
  /** When each block:column was last sent, to skip requests that crossed with a response. */
  private sent = new Map<string, number>()
  private generation = 0
  private disposed = false

  constructor(private readonly document: ParquetDocument, private readonly panel: vscode.WebviewPanel) {}

  dispose(): void {
    this.disposed = true
    this.queue = []
  }

  private post(msg: HostMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg)
  }

  async onMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          return await this.sendInit(false)
        case 'fetch':
          this.queue = msg.requests.slice()
          return this.pump()
        case 'cell':
          return await this.sendCell(msg.requestId, msg.row, msg.col)
        case 'copy':
          return await this.copy(msg.rowStart, msg.rowEnd, msg.cols, msg.header)
        case 'copyText':
          await vscode.env.clipboard.writeText(msg.text)
          return this.post({ type: 'status', message: 'Copied to clipboard' })
        case 'columnInfo': {
          const table = await this.document.table
          return this.post({ type: 'columnInfo', col: msg.col, items: table.columnInfo(msg.col) })
        }
        case 'fileInfo': {
          const table = await this.document.table
          return this.post({ type: 'fileInfo', ...table.fileInfo(this.document.uri.fsPath || this.document.uri.toString()) })
        }
      }
    } catch (error) {
      this.post({ type: 'status', message: `Error: ${message(error)}` })
    }
  }

  async sendInit(reloaded: boolean): Promise<void> {
    this.generation++
    this.queue = []
    this.sent.clear()
    const generation = this.generation
    this.post({ type: 'loading', fileName: this.document.fileName })
    try {
      const table = await this.document.table
      if (generation !== this.generation) return
      this.post({
        type: 'init',
        reloaded,
        table: {
          fileName: this.document.fileName,
          fileSize: table.source.size,
          numRows: table.numRows,
          numRowGroups: table.metadata.row_groups.length,
          columns: table.columns.map(c => c.meta),
        },
      })
    } catch (error) {
      if (generation === this.generation) this.post({ type: 'fatal', message: message(error) })
    }
  }

  private pump(): void {
    while (this.workers < WORKERS && this.queue.length) {
      this.workers++
      this.work().finally(() => {
        this.workers--
        this.pump()
      })
    }
  }

  private async work(): Promise<void> {
    const request = this.queue.shift()
    if (!request || this.disposed) return
    const generation = this.generation
    const table = await this.document.table
    const now = Date.now()
    const cols = request.cols.filter(c => now - (this.sent.get(`${request.block}:${c}`) ?? -Infinity) > 3000)
    if (!cols.length) return
    // mark as in progress so the other worker skips them
    for (const c of cols) this.sent.set(`${request.block}:${c}`, now)
    const start = request.block * BLOCK_ROWS
    const end = Math.min(table.numRows, start + BLOCK_ROWS)
    const maxChars = config('maxCellChars', 300)
    const okCols: number[] = []
    const values: CellText[][] = []
    const errors: Record<number, string> = {}
    let failed = false
    await Promise.all(cols.map(async c => {
      try {
        const texts = await table.displayColumn(c, start, end, maxChars)
        okCols.push(c)
        values.push(texts)
      } catch (error) {
        errors[c] = message(error)
        failed = true
      }
    }))
    if (generation !== this.generation) return
    this.post({ type: 'data', block: request.block, cols: okCols, values, errors: failed ? errors : undefined })
    const done = Date.now()
    for (const c of cols) this.sent.set(`${request.block}:${c}`, done)
    if (this.sent.size > 20000) {
      for (const [key, time] of this.sent) if (done - time > 3000) this.sent.delete(key)
    }
  }

  private async sendCell(requestId: number, row: number, col: number): Promise<void> {
    const table = await this.document.table
    try {
      const { text, isNull } = await table.fullValue(row, col)
      this.post({ type: 'cell', requestId, row, col, text, isNull })
    } catch (error) {
      this.post({ type: 'cell', requestId, row, col, text: `Error: ${message(error)}`, isNull: false })
    }
  }

  private async copy(rowStart: number, rowEnd: number, cols: number[], header: boolean): Promise<void> {
    const table = await this.document.table
    const cells = (rowEnd - rowStart) * cols.length
    if (cells > MAX_COPY_CELLS) {
      void vscode.window.showWarningMessage(
        `Eyeball: the selection has ${cells.toLocaleString('en-US')} cells; at most ${MAX_COPY_CELLS.toLocaleString('en-US')} can be copied.`)
      return
    }
    const text = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Eyeball: copying' },
      () => table.copyText(rowStart, rowEnd, cols, header),
    )
    await vscode.env.clipboard.writeText(text)
    this.post({ type: 'status', message: `Copied ${cells.toLocaleString('en-US')} cell${cells === 1 ? '' : 's'}` })
  }
}

export class ParquetEditorProvider implements vscode.CustomReadonlyEditorProvider<ParquetDocument> {
  private readonly cache: LruCache<unknown>

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new ParquetEditorProvider(context)
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('eyeball.cacheSizeMB')) provider.cache.setBudget(provider.cacheBudget())
      }),
    )
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.cache = new LruCache(this.cacheBudget())
  }

  private cacheBudget(): number {
    return Math.max(64, config('cacheSizeMB', 512)) * 2 ** 20
  }

  openCustomDocument(uri: vscode.Uri): ParquetDocument {
    return new ParquetDocument(uri, this.cache)
  }

  resolveCustomEditor(document: ParquetDocument, panel: vscode.WebviewPanel): void {
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist')
    panel.webview.options = { enableScripts: true, localResourceRoots: [distUri] }
    panel.webview.html = this.html(panel.webview, distUri)
    const session = new EditorSession(document, panel)
    const subscriptions = [
      panel.webview.onDidReceiveMessage((msg: WebviewMessage) => session.onMessage(msg)),
      document.onDidReload(() => session.sendInit(true)),
    ]
    panel.onDidDispose(() => {
      session.dispose()
      for (const s of subscriptions) s.dispose()
    })
  }

  private html(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.css'))
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }
}

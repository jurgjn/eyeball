import * as path from 'node:path'
import * as vscode from 'vscode'
import { BLOCK_ROWS, type BlockRequest, type CellText, type HostMessage, type WebviewMessage } from './protocol'
import { LruCache } from './reader/lru'
import { openTableFile } from './reader/open'
import { DEFAULT_PARALLEL_READS, memorySource, openFileSource, type ByteSource } from './reader/source'
import type { TableFile, TableReader } from './reader/types'

export const PARQUET_VIEW_TYPE = 'eyeball.parquet'
export const SQLITE_VIEW_TYPE = 'eyeball.sqlite'
const MAX_COPY_CELLS = 2_000_000
/** Workers serving block requests per editor. */
const WORKERS = 2

function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('eyeball').get<T>(key, fallback)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An open Parquet file or SQLite database, shared by all editors showing it. */
class DataDocument implements vscode.CustomDocument {
  private filePromise: Promise<TableFile>
  private readonly watcher?: vscode.FileSystemWatcher
  private reloadTimer?: ReturnType<typeof setTimeout>
  private readonly reloadEmitter = new vscode.EventEmitter<void>()
  readonly onDidReload = this.reloadEmitter.event
  /** Reads from the file (and its write-ahead log) so far, to show progress while opening. */
  readonly readStats = { reads: 0, bytes: 0 }

  constructor(readonly uri: vscode.Uri, private readonly cache: LruCache<unknown>) {
    this.filePromise = this.open()
    // errors are reported to the webview when it asks for the file
    this.filePromise.catch(() => {})
    if (uri.scheme === 'file') {
      // also watch the SQLite write-ahead log, where recent changes live until a checkpoint
      const base = path.basename(uri.fsPath)
      const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), `{${base},${base}-wal}`)
      this.watcher = vscode.workspace.createFileSystemWatcher(pattern)
      this.watcher.onDidChange(() => this.scheduleReload())
      this.watcher.onDidCreate(() => this.scheduleReload())
      this.watcher.onDidDelete(() => this.scheduleReload())
    }
  }

  get file(): Promise<TableFile> {
    return this.filePromise
  }

  get fileName(): string {
    return path.posix.basename(this.uri.path)
  }

  private async open(): Promise<TableFile> {
    const source = await this.openSource(this.uri)
    if (!source) throw new Error('file not found')
    try {
      return await openTableFile(source, this.cache, suffix => this.openSource(this.uri.with({ path: this.uri.path + suffix }), true))
    } catch (error) {
      await source.close()
      throw error
    }
  }

  private async openSource(uri: vscode.Uri, optional = false): Promise<ByteSource | undefined> {
    let source: ByteSource
    try {
      source = uri.scheme === 'file'
        ? await openFileSource(uri.fsPath, { parallelReads: config('parallelReads', DEFAULT_PARALLEL_READS) })
        : memorySource(await vscode.workspace.fs.readFile(uri))
    } catch (error) {
      if (optional) return undefined
      throw error
    }
    const stats = this.readStats
    return {
      size: source.size,
      async read(start, end, background) {
        const bytes = await source.read(start, end, background)
        stats.reads++
        stats.bytes += bytes.byteLength
        return bytes
      },
      close: () => source.close(),
    }
  }

  private scheduleReload(): void {
    // writers touch the file several times; wait until it has settled
    clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => this.reload(), 1000)
  }

  private reload(): void {
    const old = this.filePromise
    this.filePromise = this.open()
    this.filePromise.catch(() => {})
    // let requests still running on the old file finish before closing it, but stop counting its rows
    old.then(file => {
      file.stopCounting?.()
      setTimeout(() => file.dispose(), 30_000)
    }, () => {})
    this.reloadEmitter.fire()
  }

  dispose(): void {
    clearTimeout(this.reloadTimer)
    this.watcher?.dispose()
    this.reloadEmitter.dispose()
    this.filePromise.then(file => file.dispose(), () => {})
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
  private tableName?: string
  private table?: TableReader
  private unsubscribe?: () => void
  private lastRowCount = 0

  constructor(private readonly document: DataDocument, private readonly panel: vscode.WebviewPanel) {}

  dispose(): void {
    this.disposed = true
    this.queue = []
    this.unsubscribe?.()
  }

  private post(msg: HostMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg)
  }

  private currentTable(): TableReader {
    if (!this.table) throw new Error('no table is open')
    return this.table
  }

  async onMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          return await this.sendInit(false)
        case 'selectTable':
          this.tableName = msg.name
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
        case 'columnInfo':
          return this.post({ type: 'columnInfo', col: msg.col, items: this.currentTable().columnInfo(msg.col) })
        case 'fileInfo': {
          const file = await this.document.file
          return this.post({ type: 'fileInfo', sections: file.fileInfo(this.document.uri.fsPath || this.document.uri.toString()) })
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
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.table = undefined
    const generation = this.generation
    this.post({ type: 'loading', fileName: this.document.fileName, table: this.tableName })
    // show what has been read while opening: on network file systems, this can take a while
    const { reads, bytes } = this.document.readStats
    const activity = setInterval(() => {
      const stats = this.document.readStats
      if (generation === this.generation) this.post({ type: 'activity', reads: stats.reads - reads, bytes: stats.bytes - bytes })
    }, 250)
    try {
      const file = await this.document.file
      if (generation !== this.generation) return
      const name = file.tables.some(t => t.name === this.tableName && t.supported) ? this.tableName! : file.defaultTable
      this.tableName = name
      const table = await file.openTable(name)
      if (generation !== this.generation) return
      this.table = table
      this.lastRowCount = table.numRows
      this.unsubscribe = table.onRowCount(() => this.onRowCount(table, generation))
      this.post({
        type: 'init',
        reloaded,
        table: {
          format: file.format,
          fileName: this.document.fileName,
          fileSize: file.size,
          tables: file.tables,
          table: name,
          numRows: table.numRows,
          counting: table.counting,
          progress: table.progress,
          totalRows: table.totalRows,
          columns: table.columns.map(c => c.meta),
        },
      })
    } catch (error) {
      if (generation === this.generation) this.post({ type: 'fatal', message: message(error) })
    } finally {
      clearInterval(activity)
    }
  }

  private onRowCount(table: TableReader, generation: number): void {
    if (generation !== this.generation) return
    // the block that held the last rows may have been sent incomplete
    const lastBlock = Math.floor(this.lastRowCount / BLOCK_ROWS)
    for (const key of this.sent.keys()) if (key.startsWith(`${lastBlock}:`)) this.sent.delete(key)
    this.lastRowCount = table.numRows
    this.post({ type: 'rowCount', numRows: table.numRows, counting: table.counting, progress: table.progress, totalRows: table.totalRows })
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
    const table = this.table
    if (!request || !table || this.disposed) return
    const generation = this.generation
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
    const table = this.currentTable()
    try {
      const { text, isNull } = await table.fullValue(row, col)
      this.post({ type: 'cell', requestId, row, col, text, isNull })
    } catch (error) {
      this.post({ type: 'cell', requestId, row, col, text: `Error: ${message(error)}`, isNull: false })
    }
  }

  private async copy(rowStart: number, rowEnd: number, cols: number[], header: boolean): Promise<void> {
    const table = this.currentTable()
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

export class DataEditorProvider implements vscode.CustomReadonlyEditorProvider<DataDocument> {
  private readonly cache: LruCache<unknown>

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new DataEditorProvider(context)
    const options = {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }
    return vscode.Disposable.from(
      // both formats are handled by the same editor, which detects the format from the contents
      vscode.window.registerCustomEditorProvider(PARQUET_VIEW_TYPE, provider, options),
      vscode.window.registerCustomEditorProvider(SQLITE_VIEW_TYPE, provider, options),
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

  openCustomDocument(uri: vscode.Uri): DataDocument {
    return new DataDocument(uri, this.cache)
  }

  resolveCustomEditor(document: DataDocument, panel: vscode.WebviewPanel): void {
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

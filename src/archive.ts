// Archives and images as folders: zip archives, SquashFS images, and the SquashFS file systems of
// Apptainer/Singularity images. For each format, a read-only file system provider serves URIs
// that are the path of the file followed by the path inside it (zipfile:/data/run.zip/results/
// a.parquet, squashfs:/data/images/run.sqfs/results/a.parquet), a command adds a file to the
// explorer, and a page shows a file's details when one is opened.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ArchiveError, type Archive, type EntryKind } from './reader/archive'
import { formatBytes } from './reader/format'
import { DEFAULT_PARALLEL_READS, openFileSource, type ByteSource } from './reader/source'
import { SquashfsImage, squashfsOffset } from './reader/squashfs'
import { ZipArchive } from './reader/zip'

/** How often an open archive is checked for changes on disk, at most. */
const CHECK_MS = 5000

/** A format of archives or images, and how it appears in VS Code. */
interface Format<A extends Archive> {
  scheme: string
  viewType: string
  /** The command that adds a file to the explorer. */
  command: string
  /** What a file of this format is called in messages. */
  noun: 'archive' | 'image'
  title: string
  filters: Record<string, string[]>
  open(source: ByteSource): Promise<A>
  /** What the file is, its details, and a note, for its page. */
  describe(archive: A): { kind: string; rows: [string, string][]; note?: string }
}

const fmt = (n: number) => n.toLocaleString('en-US')
const plural = (n: number, word: string) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`

const SQUASHFS: Format<SquashfsImage> = {
  scheme: 'squashfs',
  viewType: 'eyeball.squashfs',
  command: 'eyeball.openSquashfs',
  noun: 'image',
  title: 'Open SquashFS Image as Folder',
  filters: { 'SquashFS and Apptainer images': ['sqfs', 'squashfs', 'sqsh', 'squash', 'sif'], 'All files': ['*'] },
  open: async source => SquashfsImage.open(source, await squashfsOffset(source)),
  describe: ({ info }) => ({
    kind: info.offset ? `Apptainer/Singularity image, with its root file system in SquashFS at byte ${fmt(info.offset)}` : 'SquashFS image',
    rows: [
      ['Files, folders and links', fmt(info.inodes)],
      ['Compression', `${info.compression}, ${formatBytes(info.blockSize)} blocks`],
      ['Created', info.created.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')],
    ],
  }),
}

const ZIP: Format<ZipArchive> = {
  // not zip:, which Yarn's ZipFS extension uses
  scheme: 'zipfile',
  viewType: 'eyeball.zip',
  command: 'eyeball.openZip',
  noun: 'archive',
  title: 'Open Zip Archive as Folder',
  filters: { 'Zip archives': ['zip'], 'All files': ['*'] },
  open: source => ZipArchive.open(source),
  describe: ({ info }) => {
    const methods = [...info.methods].sort((a, b) => b[1] - a[1]).map(([method, files]) => `${method} (${plural(files, 'file')})`)
    const rows: [string, string][] = [['Files, folders and links', fmt(info.entries)], ['Uncompressed size', formatBytes(info.size)]]
    if (methods.length) rows.push(['Compression', methods.join(', ')])
    if (info.comment) rows.push(['Comment', info.comment])
    return {
      kind: `Zip archive${info.zip64 ? ' (ZIP64)' : ''}${info.offset ? `, after ${fmt(info.offset)} bytes of other data (e.g. a self-extracting program)` : ''}`,
      rows,
      note: info.unreadable
        ? `${plural(info.unreadable, 'file')} can't be read: encrypted, or compressed with a method Eyeball doesn't read (it reads deflate and zstd).`
        : undefined,
    }
  },
}

interface OpenArchive<A> {
  archive: A
  source: ByteSource
  size: number
  mtimeMs: number
  checked: number
}

/** The local path of the path of a file: URI. */
const fsPath = (uriPath: string) => vscode.Uri.from({ scheme: 'file', path: uriPath }).fsPath

/** Archives of a format opened so far, by the path of their file (the path of its file: URI). */
class Archives<A extends Archive> {
  private readonly archives = new Map<string, Promise<OpenArchive<A>>>()
  readonly changed = new vscode.EventEmitter<string>()

  constructor(readonly format: Format<A>) {}

  /** The URI of a path inside an archive (a file: URI). */
  uri(file: vscode.Uri, inner = '/'): vscode.Uri {
    return vscode.Uri.from({ scheme: this.format.scheme, path: file.path + (inner === '/' ? '' : inner) })
  }

  /** The archive's file and the path inside it, of a URI of the format. */
  async split(uri: vscode.Uri): Promise<{ archivePath: string; inner: string }> {
    const full = uri.path
    for (const archivePath of this.archives.keys()) {
      if (full === archivePath || full.startsWith(archivePath + '/')) return { archivePath, inner: full.slice(archivePath.length) || '/' }
    }
    // the archive is the first part of the path that is a file
    let prefix = ''
    for (const part of full.split('/').filter(Boolean)) {
      prefix += '/' + part
      const stat = await fs.stat(fsPath(prefix)).catch(() => undefined)
      if (!stat) break
      if (stat.isFile()) return { archivePath: prefix, inner: full.slice(prefix.length) || '/' }
    }
    throw vscode.FileSystemError.FileNotFound(uri)
  }

  /** The archive in a file, opened once, and opened again when the file changes. */
  async get(archivePath: string): Promise<A> {
    let open = this.archives.get(archivePath)
    if (!open) {
      open = this.open(archivePath)
      this.archives.set(archivePath, open)
      open.catch(() => this.archives.delete(archivePath))
    }
    const current = await open
    const now = Date.now()
    if (now - current.checked > CHECK_MS) {
      current.checked = now
      const stat = await fs.stat(fsPath(archivePath)).catch(() => undefined)
      if (!stat || stat.size !== current.size || stat.mtimeMs !== current.mtimeMs) {
        this.archives.delete(archivePath)
        void current.source.close().catch(() => {})
        this.changed.fire(archivePath)
        return this.get(archivePath)
      }
    }
    return current.archive
  }

  private async open(archivePath: string): Promise<OpenArchive<A>> {
    const file = fsPath(archivePath)
    const stat = await fs.stat(file)
    const parallelReads = vscode.workspace.getConfiguration('eyeball').get('parallelReads', DEFAULT_PARALLEL_READS)
    const source = await openFileSource(file, { parallelReads })
    try {
      return { archive: await this.format.open(source), source, size: stat.size, mtimeMs: stat.mtimeMs, checked: Date.now() }
    } catch (error) {
      await source.close()
      throw error
    }
  }

  dispose(): void {
    for (const open of this.archives.values()) open.then(o => o.source.close(), () => {}).catch(() => {})
    this.archives.clear()
    this.changed.dispose()
  }
}

function fileType(kind: EntryKind): vscode.FileType {
  return kind === 'directory' ? vscode.FileType.Directory : kind === 'file' ? vscode.FileType.File : vscode.FileType.Unknown
}

/** Read-only access to the files in archives of a format. */
class ArchiveFileSystem<A extends Archive> implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.emitter.event

  constructor(private readonly archives: Archives<A>) {
    // an archive that changed on disk: everything in it may have changed
    archives.changed.event(archivePath => {
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: vscode.Uri.from({ scheme: archives.format.scheme, path: archivePath }) }])
    })
  }

  /** Run fn on the archive and the path inside it, with errors as VS Code expects them. */
  private async run<T>(uri: vscode.Uri, fn: (archive: A, inner: string) => Promise<T>): Promise<T> {
    const { archivePath, inner } = await this.archives.split(uri)
    try {
      return await fn(await this.archives.get(archivePath), inner)
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error
      if (error.code === 'ENOTDIR') throw vscode.FileSystemError.FileNotADirectory(uri)
      if (error.code === 'EISDIR') throw vscode.FileSystemError.FileIsADirectory(uri)
      throw vscode.FileSystemError.FileNotFound(uri)
    }
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.run(uri, async (archive, inner) => {
      const own = await archive.lookup(inner, false)
      // symbolic links have the type of their target; broken ones are just links
      const node = own.kind === 'symlink' ? await archive.lookup(inner).catch(() => undefined) : own
      const link = own.kind === 'symlink' ? vscode.FileType.SymbolicLink : 0
      const mtime = (node ?? own).mtime * 1000
      return {
        type: (node ? fileType(node.kind) : vscode.FileType.Unknown) | link,
        ctime: mtime,
        mtime,
        size: node?.kind === 'file' ? node.size : 0,
        permissions: vscode.FilePermission.Readonly,
      }
    })
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.run(uri, async (archive, inner) => {
      const entries = [...(await archive.entries(await archive.lookup(inner))).values()]
      return Promise.all(entries.map(async (entry): Promise<[string, vscode.FileType]> => {
        if (entry.kind !== 'symlink') return [entry.name, fileType(entry.kind)]
        const target = await archive.lookup(`${inner === '/' ? '' : inner}/${entry.name}`).catch(() => undefined)
        return [entry.name, vscode.FileType.SymbolicLink | (target ? fileType(target.kind) : vscode.FileType.Unknown)]
      }))
    })
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.run(uri, async (archive, inner) => {
      const node = await archive.lookup(inner)
      return archive.read(node, 0, node.size)
    })
  }

  watch(): vscode.Disposable {
    // the files in archives don't change; when an archive does, onDidChangeFile reports it
    return new vscode.Disposable(() => {})
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri)
  }

  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri)
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri)
  }

  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri)
  }

  /** A file in an archive as a byte source (for the Parquet and SQLite readers). */
  openSource(uri: vscode.Uri): Promise<ByteSource> {
    return this.run(uri, async (archive, inner) => {
      const node = await archive.lookup(inner)
      if (node.kind !== 'file') throw vscode.FileSystemError.FileIsADirectory(uri)
      return archive.fileSource(node)
    })
  }
}

/** Opens files in archives as byte sources, by the scheme of their URIs. */
const sources = new Map<string, (uri: vscode.Uri) => Promise<ByteSource>>()

/** Whether a URI is that of a file in an archive or image. */
export function isArchiveUri(uri: vscode.Uri): boolean {
  return sources.has(uri.scheme)
}

/**
 * A file in an archive or image as a byte source: read in place, like files on disk, except for
 * compressed files in zip archives, which are decompressed in memory.
 */
export function openArchiveSource(uri: vscode.Uri): Promise<ByteSource> {
  const open = sources.get(uri.scheme)
  if (!open) throw new Error(`files in ${uri.scheme}: URIs can't be read`)
  return open(uri)
}

/** Show an archive as a folder in the explorer (adding it to the workspace), or in a new window. */
async function browse<A extends Archive>(archives: Archives<A>, file: vscode.Uri, newWindow = false): Promise<void> {
  const uri = archives.uri(file)
  if (newWindow) {
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true })
    return
  }
  const folders = vscode.workspace.workspaceFolders ?? []
  if (!folders.some(f => f.uri.toString() === uri.toString())) {
    // a workspace with a single folder becomes a multi-root workspace, and extensions restart
    const added = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name: path.posix.basename(file.path) })
    if (!added) {
      void vscode.window.showErrorMessage(`Eyeball: could not add ${path.posix.basename(file.path)} to the workspace.`)
      return
    }
  }
  await vscode.commands.executeCommand('workbench.view.explorer')
}

/** A page with an archive's details, and buttons to browse it. */
class ArchivePageProvider<A extends Archive> implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly archives: Archives<A>) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} }
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
    panel.webview.options = { enableScripts: true, localResourceRoots: [] }
    const { noun } = this.archives.format
    const name = path.posix.basename(document.uri.path)
    const escape = (text: string) => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
    let details: string
    let canBrowse = false
    try {
      if (document.uri.scheme !== 'file') throw new Error(`only ${noun}s on the file system can be browsed`)
      const archive = await this.archives.get(document.uri.path)
      const { size } = await fs.stat(document.uri.fsPath)
      const { kind, rows, note } = this.archives.format.describe(archive)
      details = `<p>${escape(kind)}</p><table>
<tr><td>Size</td><td>${formatBytes(size)}</td></tr>
${rows.map(([label, value]) => `<tr><td>${escape(label)}</td><td>${escape(value)}</td></tr>`).join('\n')}
</table>${note ? `\n<p class="note">${escape(note)}</p>` : ''}`
      canBrowse = true
    } catch (error) {
      details = `<p class="error">Can't read this ${noun}: ${escape(error instanceof Error ? error.message : String(error))}</p>`
    }
    const local = !vscode.env.remoteName
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px 24px; }
  h2 { font-weight: 600; margin: 0 0 8px; }
  td { padding: 2px 16px 2px 0; vertical-align: top; }
  td:first-child { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  td:last-child { white-space: pre-wrap; }
  .error { color: var(--vscode-errorForeground); }
  .note { color: var(--vscode-editorWarning-foreground); }
  .buttons { margin-top: 16px; display: flex; gap: 8px; }
  button { font: inherit; padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .hint { margin-top: 12px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h2>${escape(name)}</h2>
${details}
${canBrowse ? `<div class="buttons">
<button id="explorer">Show in Explorer</button>
${local ? '<button id="window" class="secondary">Open in New Window</button>' : ''}
</div>
<p class="hint">The ${noun} is added to the workspace as a read-only folder; Remove Folder from Workspace removes it again.</p>` : ''}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi()
  for (const id of ['explorer', 'window']) document.getElementById(id)?.addEventListener('click', () => vscode.postMessage(id))
</script>
</body>
</html>`
    panel.webview.onDidReceiveMessage(msg => void browse(this.archives, document.uri, msg === 'window'))
  }
}

function registerFormat<A extends Archive>(format: Format<A>): vscode.Disposable {
  const archives = new Archives(format)
  const fileSystem = new ArchiveFileSystem(archives)
  sources.set(format.scheme, uri => fileSystem.openSource(uri))
  return vscode.Disposable.from(
    archives,
    vscode.workspace.registerFileSystemProvider(format.scheme, fileSystem, { isCaseSensitive: true, isReadonly: true }),
    vscode.window.registerCustomEditorProvider(format.viewType, new ArchivePageProvider(archives)),
    vscode.commands.registerCommand(format.command, async (uri?: vscode.Uri) => {
      uri ??= (await vscode.window.showOpenDialog({ canSelectMany: false, filters: format.filters, title: format.title }))?.[0]
      if (uri) await browse(archives, uri)
    }),
    new vscode.Disposable(() => sources.delete(format.scheme)),
  )
}

export function registerArchives(): vscode.Disposable {
  return vscode.Disposable.from(registerFormat(SQUASHFS), registerFormat(ZIP))
}

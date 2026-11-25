// SquashFS images (and the SquashFS file systems of Apptainer/Singularity images) as folders: a
// read-only file system provider for squashfs: URIs, which are the path of the image followed
// by the path inside it (squashfs:/data/images/run.sqfs/results/a.parquet), a command that adds
// an image to the explorer, and a page with the image's details for when one is opened.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { formatBytes } from './reader/format'
import { DEFAULT_PARALLEL_READS, openFileSource, type ByteSource } from './reader/source'
import { SquashfsError, SquashfsImage, squashfsFileSource, squashfsOffset, type EntryKind } from './reader/squashfs'

export const SQUASHFS_SCHEME = 'squashfs'
export const SQUASHFS_VIEW_TYPE = 'eyeball.squashfs'
/** How often an open image is checked for changes on disk, at most. */
const CHECK_MS = 5000

/** The URI of a path inside an image (a file: URI). */
export function squashfsUri(image: vscode.Uri, inner = '/'): vscode.Uri {
  return vscode.Uri.from({ scheme: SQUASHFS_SCHEME, path: image.path + (inner === '/' ? '' : inner) })
}

interface OpenImage {
  image: SquashfsImage
  source: ByteSource
  size: number
  mtimeMs: number
  checked: number
}

/** Images opened so far, by the path of their file (the path of its file: URI). */
class Images {
  private readonly images = new Map<string, Promise<OpenImage>>()
  readonly changed = new vscode.EventEmitter<string>()

  /** The image file and the path inside it, of a squashfs: URI. */
  async split(uri: vscode.Uri): Promise<{ imagePath: string; inner: string }> {
    const full = uri.path
    for (const imagePath of this.images.keys()) {
      if (full === imagePath || full.startsWith(imagePath + '/')) return { imagePath, inner: full.slice(imagePath.length) || '/' }
    }
    // the image is the first part of the path that is a file
    let prefix = ''
    for (const part of full.split('/').filter(Boolean)) {
      prefix += '/' + part
      const stat = await fs.stat(fsPath(prefix)).catch(() => undefined)
      if (!stat) break
      if (stat.isFile()) return { imagePath: prefix, inner: full.slice(prefix.length) || '/' }
    }
    throw vscode.FileSystemError.FileNotFound(uri)
  }

  /** The image in a file, opened once, and opened again when the file changes. */
  async get(imagePath: string): Promise<SquashfsImage> {
    let open = this.images.get(imagePath)
    if (!open) {
      open = this.open(imagePath)
      this.images.set(imagePath, open)
      open.catch(() => this.images.delete(imagePath))
    }
    const current = await open
    const now = Date.now()
    if (now - current.checked > CHECK_MS) {
      current.checked = now
      const stat = await fs.stat(fsPath(imagePath)).catch(() => undefined)
      if (!stat || stat.size !== current.size || stat.mtimeMs !== current.mtimeMs) {
        this.images.delete(imagePath)
        void current.source.close().catch(() => {})
        this.changed.fire(imagePath)
        return this.get(imagePath)
      }
    }
    return current.image
  }

  private async open(imagePath: string): Promise<OpenImage> {
    const file = fsPath(imagePath)
    const stat = await fs.stat(file)
    const parallelReads = vscode.workspace.getConfiguration('eyeball').get('parallelReads', DEFAULT_PARALLEL_READS)
    const source = await openFileSource(file, { parallelReads })
    try {
      const image = await SquashfsImage.open(source, await squashfsOffset(source))
      return { image, source, size: stat.size, mtimeMs: stat.mtimeMs, checked: Date.now() }
    } catch (error) {
      await source.close()
      throw error
    }
  }

  dispose(): void {
    for (const open of this.images.values()) open.then(o => o.source.close(), () => {}).catch(() => {})
    this.images.clear()
    this.changed.dispose()
  }
}

/** The local path of the path of a file: URI. */
const fsPath = (uriPath: string) => vscode.Uri.from({ scheme: 'file', path: uriPath }).fsPath

function fileType(kind: EntryKind): vscode.FileType {
  return kind === 'directory' ? vscode.FileType.Directory : kind === 'file' ? vscode.FileType.File : vscode.FileType.Unknown
}

/** Read-only access to the files in images. */
class SquashfsFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.emitter.event

  constructor(private readonly images: Images) {
    // an image that changed on disk: everything in it may have changed
    images.changed.event(imagePath => {
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: vscode.Uri.from({ scheme: SQUASHFS_SCHEME, path: imagePath }) }])
    })
  }

  /** Run fn on the image and the path inside it, with errors as VS Code expects them. */
  private async run<T>(uri: vscode.Uri, fn: (image: SquashfsImage, inner: string) => Promise<T>): Promise<T> {
    const { imagePath, inner } = await this.images.split(uri)
    try {
      return await fn(await this.images.get(imagePath), inner)
    } catch (error) {
      if (!(error instanceof SquashfsError)) throw error
      if (error.code === 'ENOTDIR') throw vscode.FileSystemError.FileNotADirectory(uri)
      if (error.code === 'EISDIR') throw vscode.FileSystemError.FileIsADirectory(uri)
      throw vscode.FileSystemError.FileNotFound(uri)
    }
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.run(uri, async (image, inner) => {
      const own = await image.lookup(inner, false)
      // symbolic links have the type of their target; broken ones are just links
      const inode = own.kind === 'symlink' ? await image.lookup(inner).catch(() => undefined) : own
      const link = own.kind === 'symlink' ? vscode.FileType.SymbolicLink : 0
      const mtime = (inode ?? own).mtime * 1000
      return {
        type: (inode ? fileType(inode.kind) : vscode.FileType.Unknown) | link,
        ctime: mtime,
        mtime,
        size: inode?.kind === 'file' ? inode.size : 0,
        permissions: vscode.FilePermission.Readonly,
      }
    })
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.run(uri, async (image, inner) => {
      const entries = [...(await image.entries(await image.lookup(inner))).values()]
      return Promise.all(entries.map(async (entry): Promise<[string, vscode.FileType]> => {
        if (entry.kind !== 'symlink') return [entry.name, fileType(entry.kind)]
        const target = await image.lookup(`${inner === '/' ? '' : inner}/${entry.name}`).catch(() => undefined)
        return [entry.name, vscode.FileType.SymbolicLink | (target ? fileType(target.kind) : vscode.FileType.Unknown)]
      }))
    })
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.run(uri, async (image, inner) => {
      const inode = await image.lookup(inner)
      return image.read(inode, 0, inode.size)
    })
  }

  watch(): vscode.Disposable {
    // images don't change; when the file of one does, onDidChangeFile reports it
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

  /** A file in an image as a byte source, read in place (for the Parquet and SQLite readers). */
  openSource(uri: vscode.Uri): Promise<ByteSource> {
    return this.run(uri, async (image, inner) => {
      const inode = await image.lookup(inner)
      if (inode.kind !== 'file') throw vscode.FileSystemError.FileIsADirectory(uri)
      return squashfsFileSource(image, inode)
    })
  }
}

let fileSystem: SquashfsFileSystem | undefined

/** A file in an image (a squashfs: URI) as a byte source, read in place. */
export function openSquashfsSource(uri: vscode.Uri): Promise<ByteSource> {
  if (!fileSystem) throw new Error('SquashFS images are not available')
  return fileSystem.openSource(uri)
}

/** Show an image as a folder in the explorer (adding it to the workspace), or in a new window. */
async function browse(image: vscode.Uri, newWindow = false): Promise<void> {
  const uri = squashfsUri(image)
  if (newWindow) {
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true })
    return
  }
  const folders = vscode.workspace.workspaceFolders ?? []
  if (!folders.some(f => f.uri.toString() === uri.toString())) {
    // a workspace with a single folder becomes a multi-root workspace, and extensions restart
    const added = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name: path.posix.basename(image.path) })
    if (!added) {
      void vscode.window.showErrorMessage(`Eyeball: could not add ${path.posix.basename(image.path)} to the workspace.`)
      return
    }
  }
  await vscode.commands.executeCommand('workbench.view.explorer')
}

const IMAGE_FILTERS = { 'SquashFS and Apptainer images': ['sqfs', 'squashfs', 'sqsh', 'squash', 'sif'], 'All files': ['*'] }

/** A page with an image's details, and buttons to browse it. */
class ImagePageProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly images: Images) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} }
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
    panel.webview.options = { enableScripts: true, localResourceRoots: [] }
    const name = path.posix.basename(document.uri.path)
    const escape = (text: string) => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
    let details: string
    let canBrowse = false
    try {
      if (document.uri.scheme !== 'file') throw new Error('only images on the file system can be browsed')
      const image = await this.images.get(document.uri.path)
      const { size } = await fs.stat(document.uri.fsPath)
      const info = image.info
      const fmt = (n: number) => n.toLocaleString('en-US')
      const kind = info.offset ? `Apptainer/Singularity image, with its root file system in SquashFS at byte ${fmt(info.offset)}` : 'SquashFS image'
      details = `<p>${kind}</p><table>
<tr><td>Size</td><td>${formatBytes(size)}</td></tr>
<tr><td>Files, folders and links</td><td>${fmt(info.inodes)}</td></tr>
<tr><td>Compression</td><td>${info.compression}, ${formatBytes(info.blockSize)} blocks</td></tr>
<tr><td>Created</td><td>${info.created.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</td></tr>
</table>`
      canBrowse = true
    } catch (error) {
      details = `<p class="error">Can't read this image: ${escape(error instanceof Error ? error.message : String(error))}</p>`
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
  td { padding: 2px 16px 2px 0; }
  td:first-child { color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
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
<p class="hint">The image is added to the workspace as a read-only folder; Remove Folder from Workspace removes it again.</p>` : ''}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi()
  for (const id of ['explorer', 'window']) document.getElementById(id)?.addEventListener('click', () => vscode.postMessage(id))
</script>
</body>
</html>`
    panel.webview.onDidReceiveMessage(msg => void browse(document.uri, msg === 'window'))
  }
}

export function registerSquashfs(): vscode.Disposable {
  const images = new Images()
  fileSystem = new SquashfsFileSystem(images)
  return vscode.Disposable.from(
    images,
    vscode.workspace.registerFileSystemProvider(SQUASHFS_SCHEME, fileSystem, { isCaseSensitive: true, isReadonly: true }),
    vscode.window.registerCustomEditorProvider(SQUASHFS_VIEW_TYPE, new ImagePageProvider(images)),
    vscode.commands.registerCommand('eyeball.openSquashfs', async (uri?: vscode.Uri) => {
      uri ??= (await vscode.window.showOpenDialog({ canSelectMany: false, filters: IMAGE_FILTERS, title: 'Open SquashFS Image as Folder' }))?.[0]
      if (uri) await browse(uri)
    }),
    new vscode.Disposable(() => (fileSystem = undefined)),
  )
}

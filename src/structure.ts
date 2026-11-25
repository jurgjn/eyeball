// Viewer for molecular structures, volumes and trajectories, with Mol* (https://molstar.org) in
// the webview. The extension reads the file (and for a trajectory, the topology or coordinates
// next to it) and sends it to the webview, where Mol* reads it in the format of its extension.

import * as path from 'node:path'
import * as vscode from 'vscode'
import type { StructureFile, StructureHostMessage, StructureWebviewMessage } from './protocol'

/** Text formats: available in "Open With", the text editor stays the default. */
export const STRUCTURE_VIEW_TYPE = 'eyeball.structure'
/** Binary and compressed formats, which open in the viewer by default. */
export const STRUCTURE_BINARY_VIEW_TYPE = 'eyeball.structure.binary'

/** The Mol* formats of the files that make up a trajectory. */
const MODEL_FORMATS: Record<string, string> = {
  gro: 'gro', pdb: 'pdb', ent: 'pdb', cif: 'mmcif', mmcif: 'mmcif', mcif: 'mmcif', bcif: 'mmcif', pdbqt: 'pdbqt', pqr: 'pqr',
}
const TOPOLOGY_FORMATS: Record<string, string> = { psf: 'psf', prmtop: 'prmtop', parm7: 'prmtop', top: 'top' }
const COORDINATES_FORMATS: Record<string, string> = { xtc: 'xtc', trr: 'trr', dcd: 'dcd', nc: 'nctraj', nctraj: 'nctraj' }

/** Extensions of the files Mol* reads, also compressed with gzip (.gz). */
export const STRUCTURE_EXTENSIONS = [
  // structures and models
  'pdb', 'ent', 'pdbqt', 'pqr', 'cif', 'mmcif', 'mcif', 'bcif', 'gro', 'xyz', 'mol', 'sdf', 'sd', 'mol2', 'data', 'lammpstrj', 'g3d',
  // topologies and coordinates of trajectories
  'psf', 'prmtop', 'parm7', 'top', 'xtc', 'trr', 'dcd', 'nc', 'nctraj',
  // volumes
  'ccp4', 'mrc', 'map', 'cub', 'cube', 'dsn6', 'brix', 'dx', 'dxbin', 'mtz',
  // particles, shapes, MolViewSpec and kinemage
  'em', 'ndjson', 'tbl', 'star', 'simularium', 'obj', 'ply', 'vtp', 'mvsj', 'mvsx', 'kin',
]

/** Extension of a file name without .gz, in lower case. */
function extensionOf(name: string): string {
  return path.posix.extname(name.toLowerCase().replace(/\.gz$/, '')).slice(1)
}

export function isStructureFile(name: string): boolean {
  return STRUCTURE_EXTENSIONS.includes(extensionOf(name))
}

/** The view type whose file patterns include this file (see package.json). */
export function structureViewTypeFor(name: string): string {
  const binary = ['bcif', 'ccp4', 'mrc', 'dsn6', 'brix', 'dxbin', 'mtz', 'xtc', 'trr', 'dcd', 'nctraj', 'g3d', 'simularium', 'mvsx']
  return /\.gz$/i.test(name) || binary.includes(extensionOf(name)) ? STRUCTURE_BINARY_VIEW_TYPE : STRUCTURE_VIEW_TYPE
}

class StructureDocument implements vscode.CustomDocument {
  private readonly watchers: vscode.FileSystemWatcher[] = []
  private reloadTimer?: ReturnType<typeof setTimeout>
  private readonly reloadEmitter = new vscode.EventEmitter<void>()
  readonly onDidReload = this.reloadEmitter.event

  constructor(readonly uri: vscode.Uri) {
    if (uri.scheme === 'file') {
      // also watch the other files of a trajectory, which have the same name
      const stem = path.basename(uri.fsPath).replace(/\.[^.]+$/, '')
      const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), `${stem}.*`)
      const watcher = vscode.workspace.createFileSystemWatcher(pattern)
      const reload = () => this.scheduleReload()
      watcher.onDidChange(reload)
      watcher.onDidCreate(reload)
      watcher.onDidDelete(reload)
      this.watchers.push(watcher)
    }
  }

  get fileName(): string {
    return path.posix.basename(this.uri.path)
  }

  /**
   * The files to show. A trajectory is read with its topology or structure (gro, pdb, psf, ...)
   * when one with the same name is next to it, and a topology with its coordinates (xtc, dcd, ...).
   */
  async read(): Promise<{ files: StructureFile[]; note?: string }> {
    const name = this.fileName
    const ext = extensionOf(name)
    const data = await readBytes(this.uri)
    if (name.toLowerCase().endsWith('.gz')) return { files: [{ name, data }] }
    if (COORDINATES_FORMATS[ext]) {
      const model = await this.sibling([...Object.keys(TOPOLOGY_FORMATS), ...Object.keys(MODEL_FORMATS)])
      if (!model) {
        return {
          files: [{ name, data }],
          note: `${name} holds only coordinates. To view the trajectory, put a topology or structure with the same name next to it (e.g. ${stemOf(name)}.gro, .pdb, .psf or .prmtop).`,
        }
      }
      return { files: [this.modelFile(model.name, model.data), { name, data, part: 'coordinates', format: COORDINATES_FORMATS[ext] }] }
    }
    if (TOPOLOGY_FORMATS[ext]) {
      const coordinates = await this.sibling(Object.keys(COORDINATES_FORMATS))
      if (!coordinates) {
        return {
          files: [{ name, data }],
          note: `${name} is a topology without coordinates. To view the trajectory, put coordinates with the same name next to it (e.g. ${stemOf(name)}.xtc, .dcd, .trr or .nc).`,
        }
      }
      const coordinatesExt = extensionOf(coordinates.name)
      return {
        files: [this.modelFile(name, data), { ...coordinates, part: 'coordinates', format: COORDINATES_FORMATS[coordinatesExt] }],
      }
    }
    return { files: [{ name, data }] }
  }

  private modelFile(name: string, data: Uint8Array): StructureFile {
    const ext = extensionOf(name)
    return TOPOLOGY_FORMATS[ext]
      ? { name, data, part: 'topology', format: TOPOLOGY_FORMATS[ext] }
      : { name, data, part: 'model', format: MODEL_FORMATS[ext] }
  }

  /** The first file next to this one with the same name and one of the given extensions. */
  private async sibling(extensions: string[]): Promise<{ name: string; data: Uint8Array } | undefined> {
    const stem = stemOf(this.fileName)
    for (const ext of extensions) {
      const uri = vscode.Uri.joinPath(this.uri, '..', `${stem}.${ext}`)
      try {
        return { name: path.posix.basename(uri.path), data: await readBytes(uri) }
      } catch {
        // not there
      }
    }
    return undefined
  }

  private scheduleReload(): void {
    // writers touch the file several times; wait until it has settled
    clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => this.reloadEmitter.fire(), 1000)
  }

  dispose(): void {
    clearTimeout(this.reloadTimer)
    for (const watcher of this.watchers) watcher.dispose()
    this.reloadEmitter.dispose()
  }
}

const stemOf = (name: string) => name.replace(/\.[^.]+$/, '')

/**
 * The contents of a file, as a plain Uint8Array: the webview receives those as bytes, but a
 * Node Buffer (which readFile may return) as JSON.
 */
async function readBytes(uri: vscode.Uri): Promise<Uint8Array> {
  const data = await vscode.workspace.fs.readFile(uri)
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? new Uint8Array(data.buffer, 0, data.byteLength)
    : new Uint8Array(data)
}

export class StructureEditorProvider implements vscode.CustomReadonlyEditorProvider<StructureDocument> {
  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new StructureEditorProvider(context)
    const options = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(STRUCTURE_VIEW_TYPE, provider, options),
      vscode.window.registerCustomEditorProvider(STRUCTURE_BINARY_VIEW_TYPE, provider, options),
    )
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): StructureDocument {
    return new StructureDocument(uri)
  }

  resolveCustomEditor(document: StructureDocument, panel: vscode.WebviewPanel): void {
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist')
    panel.webview.options = { enableScripts: true, localResourceRoots: [distUri] }
    panel.webview.html = this.html(panel.webview, distUri)
    const post = (msg: StructureHostMessage) => void panel.webview.postMessage(msg)
    const load = async (reloaded: boolean) => {
      try {
        const { files, note } = await document.read()
        post({ type: 'load', files, note, reloaded })
      } catch (error) {
        post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
      }
    }
    const subscriptions = [
      panel.webview.onDidReceiveMessage((msg: StructureWebviewMessage) => {
        if (msg.type === 'ready') void load(false)
      }),
      document.onDidReload(() => load(true)),
    ]
    panel.onDidDispose(() => subscriptions.forEach(s => s.dispose()))
  }

  private html(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
    const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(distUri, ...parts))
    const kind = vscode.window.activeColorTheme.kind
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    // Mol* evaluates code that its WebAssembly bindings generate ('unsafe-eval'), styles elements
    // inline, and fetches data for some of its tools (e.g. from the PDB) over https
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource} data:`,
      `connect-src ${webview.cspSource} https: data: blob:`,
    ].join('; ')
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" id="theme-light" href="${uri('molstar', 'light.css')}"${light ? '' : ' disabled'}>
<link rel="stylesheet" id="theme-dark" href="${uri('molstar', 'dark.css')}"${light ? ' disabled' : ''}>
<link rel="stylesheet" href="${uri('structure.css')}">
</head>
<body>
<div id="app"></div>
<div id="message" hidden></div>
<script nonce="${nonce}" src="${uri('molstar', 'molstar.js')}"></script>
<script nonce="${nonce}" src="${uri('structure.js')}"></script>
</body>
</html>`
  }
}

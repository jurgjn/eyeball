// The structure viewer's webview: Mol* (build/viewer/molstar.js, loaded before this script)
// shows the files the extension sends.

import type { StructureFile, StructureHostMessage, StructureWebviewMessage } from '../src/protocol'

/** The parts of Mol*'s viewer used here. */
interface MolstarViewer {
  plugin: {
    clear(): Promise<void>
    canvas3d?: { setProps(props: { renderer: { backgroundColor: number } }): void }
    log: { entries: { size: number; toArray(): { type: string; message: string }[] } }
    managers: {
      structure: { hierarchy: { current: { structures: Cell<{ elementCount: number }>[]; trajectories: Cell<{ frameCount: number }>[] } } }
      volume: { hierarchy: { current: { volumes: unknown[] } } }
    }
  }
  loadFiles(files: File[]): Promise<void>
  loadTrajectory(params: object): Promise<unknown>
}

type Cell<T> = { cell: { obj?: { data: T } } }

declare const molstar: { Viewer: { create(element: HTMLElement, options: object): Promise<MolstarViewer> } }
declare function acquireVsCodeApi(): { postMessage(msg: StructureWebviewMessage): void }

const vscode = acquireVsCodeApi()
const message = document.getElementById('message')!
message.title = 'Click to close'
message.addEventListener('click', () => {
  if (!message.classList.contains('loading')) message.hidden = true
})

function showMessage(text: string, kind: 'loading' | 'info' | 'error'): void {
  message.hidden = false
  message.className = kind
  message.textContent = text
}

/** The editor's background color, as 0xRRGGBB. */
function editorBackground(): number {
  const probe = document.createElement('div')
  probe.style.color = 'var(--vscode-editor-background)'
  document.body.append(probe)
  const [r, g, b] = (getComputedStyle(probe).color.match(/\d+/g) ?? ['255', '255', '255']).map(Number)
  probe.remove()
  return r << 16 | g << 8 | b
}

const isLight = () => ['vscode-light', 'vscode-high-contrast-light'].some(c => document.body.classList.contains(c))

const viewer = molstar.Viewer.create(document.getElementById('app')!, {
  layoutShowRemoteState: false,
  layoutShowLog: false,
  collapseLeftPanel: true,
  viewportShowExpand: false,
  viewportBackgroundColor: `#${editorBackground().toString(16).padStart(6, '0')}`,
  // preset backgrounds need images that aren't included
  disabledExtensions: ['backgrounds'],
})

/** Follow VS Code's color theme: Mol*'s light or dark style, and the editor's background. */
function applyTheme(): void {
  const light = isLight()
  ;(document.getElementById('theme-light') as HTMLLinkElement).disabled = !light
  ;(document.getElementById('theme-dark') as HTMLLinkElement).disabled = light
  void viewer.then(v => v.plugin.canvas3d?.setProps({ renderer: { backgroundColor: editorBackground() } }))
}
applyTheme()
new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] })

/** File data as Mol* expects it: binary formats as bytes, text formats as text. */
function contents(file: StructureFile): Uint8Array | string {
  return file.part === 'coordinates' || /\.bcif$/i.test(file.name) ? file.data : new TextDecoder().decode(file.data)
}

async function load(files: StructureFile[], note: string | undefined): Promise<void> {
  const v = await viewer
  const logged = v.plugin.log.entries.size
  const errors: string[] = []
  try {
    await v.plugin.clear()
    const model = files.find(f => f.part === 'model' || f.part === 'topology')
    const coordinates = files.find(f => f.part === 'coordinates')
    if (model && coordinates) {
      await v.loadTrajectory({
        model: { kind: model.part === 'topology' ? 'topology-data' : 'model-data', data: contents(model), format: model.format },
        modelLabel: model.name,
        coordinates: { kind: 'coordinates-data', data: contents(coordinates), format: coordinates.format },
        coordinatesLabel: coordinates.name,
      })
    } else {
      // the data arrives in its own ArrayBuffer
      await v.loadFiles(files.map(f => new File([f.data as Uint8Array<ArrayBuffer>], f.name)))
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  // Mol* reports errors in reading files in its log
  for (const entry of v.plugin.log.entries.toArray().slice(logged)) if (entry.type === 'error') errors.push(entry.message)
  // what was loaded, for tests
  const { structures, trajectories } = v.plugin.managers.structure.hierarchy.current
  const values = <T>(cells: Cell<T>[], value: (data: T) => number) => cells.map(c => c.cell.obj ? value(c.cell.obj.data) : 0)
  document.body.dataset.atoms = String(values(structures, s => s.elementCount).reduce((a, b) => a + b, 0))
  // the trajectory of a topology (one frame) and the one with its coordinates
  document.body.dataset.frames = String(Math.max(0, ...values(trajectories, t => t.frameCount)))
  document.body.dataset.volumes = String(v.plugin.managers.volume.hierarchy.current.volumes.length)
  if (errors.length) showMessage(errors.join('\n'), 'error')
  else if (note) showMessage(note, 'info')
  else message.hidden = true
}

window.addEventListener('message', (event: MessageEvent<StructureHostMessage>) => {
  const msg = event.data
  if (msg.type === 'fatal') {
    showMessage(`Could not open this file:\n${msg.message}`, 'error')
  } else if (msg.type === 'load') {
    showMessage(msg.reloaded ? 'File changed on disk, reloading…' : `Reading ${msg.files.map(f => f.name).join(' and ')}…`, 'loading')
    void load(msg.files, msg.note)
  }
})

showMessage('Loading…', 'loading')
vscode.postMessage({ type: 'ready' })

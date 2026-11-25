import * as vscode from 'vscode'
import { DataEditorProvider, PARQUET_VIEW_TYPE, SQLITE_VIEW_TYPE } from './editor'
import { stopReadHelper } from './reader/source'
import { registerSquashfs } from './squashfs'
import { STRUCTURE_EXTENSIONS, StructureEditorProvider, isStructureFile, structureViewTypeFor } from './structure'

function viewTypeFor(uri: vscode.Uri): string {
  if (/\.(parquet|parq|pq)$/i.test(uri.path)) return PARQUET_VIEW_TYPE
  return isStructureFile(uri.path) ? structureViewTypeFor(uri.path) : SQLITE_VIEW_TYPE
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    DataEditorProvider.register(context),
    StructureEditorProvider.register(context),
    registerSquashfs(),
    vscode.commands.registerCommand('eyeball.openWith', (uri?: vscode.Uri) => {
      uri ??= vscode.window.activeTextEditor?.document.uri
      if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, viewTypeFor(uri))
    }),
    vscode.commands.registerCommand('eyeball.openFile', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: {
          'Parquet and SQLite': ['parquet', 'parq', 'pq', 'sqlite', 'sqlite3', 'db', 'db3', 's3db', 'sl3'],
          'Molecular structures': [...STRUCTURE_EXTENSIONS, 'gz'],
          'All files': ['*'],
        },
        title: 'Open Data File or Molecular Structure',
      })
      for (const uri of uris ?? []) await vscode.commands.executeCommand('vscode.openWith', uri, viewTypeFor(uri))
    }),
  )
}

export function deactivate(): void {
  stopReadHelper()
}

import * as vscode from 'vscode'
import { DataEditorProvider, PARQUET_VIEW_TYPE, SQLITE_VIEW_TYPE } from './editor'
import { stopReadHelper } from './reader/source'

const viewTypeFor = (uri: vscode.Uri) => /\.(parquet|parq|pq)$/i.test(uri.path) ? PARQUET_VIEW_TYPE : SQLITE_VIEW_TYPE

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    DataEditorProvider.register(context),
    vscode.commands.registerCommand('eyeball.openWith', (uri?: vscode.Uri) => {
      uri ??= vscode.window.activeTextEditor?.document.uri
      if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, viewTypeFor(uri))
    }),
    vscode.commands.registerCommand('eyeball.openFile', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: {
          'Parquet and SQLite': ['parquet', 'parq', 'pq', 'sqlite', 'sqlite3', 'db', 'db3', 's3db', 'sl3'],
          'All files': ['*'],
        },
        title: 'Open Parquet File or SQLite Database',
      })
      for (const uri of uris ?? []) await vscode.commands.executeCommand('vscode.openWith', uri, viewTypeFor(uri))
    }),
  )
}

export function deactivate(): void {
  stopReadHelper()
}

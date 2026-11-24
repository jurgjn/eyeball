import * as vscode from 'vscode'
import { ParquetEditorProvider, VIEW_TYPE } from './editor'

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    ParquetEditorProvider.register(context),
    vscode.commands.registerCommand('eyeball.openWith', (uri?: vscode.Uri) => {
      uri ??= vscode.window.activeTextEditor?.document.uri
      if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)
    }),
    vscode.commands.registerCommand('eyeball.openFile', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: { Parquet: ['parquet', 'parq', 'pq'], 'All files': ['*'] },
        title: 'Open Parquet File',
      })
      for (const uri of uris ?? []) await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)
    }),
  )
}

export function deactivate(): void {}

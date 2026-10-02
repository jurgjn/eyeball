import * as vscode from 'vscode';
import { EyeballEditorProvider } from './editorProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      EyeballEditorProvider.viewType,
      new EyeballEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('eyeball.openFile', async (resource?: vscode.Uri) => {
      let uri = resource;
      if (!uri) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: {
            'Data files': ['csv', 'tsv', 'gz', 'parquet', 'sqlite', 'sqlite3', 'db', 'db3'],
          },
        });
        uri = picked?.[0];
      }
      if (uri) {
        await vscode.commands.executeCommand('vscode.openWith', uri, EyeballEditorProvider.viewType);
      }
    }),
  );
}

export function deactivate(): void {}

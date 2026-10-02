import * as vscode from 'vscode';
import { createDataSource, DataSource } from './dataSources';
import type { SortSpec } from './dataSources/types';
import type { HostToWebviewMessage, WebviewToHostMessage } from './shared/protocol';
import { getHtmlForWebview } from './webview/getHtml';

class EyeballDocument implements vscode.CustomDocument {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly dataSource: DataSource,
  ) {}

  dispose(): void {
    this.dataSource.dispose();
  }
}

export class EyeballEditorProvider implements vscode.CustomReadonlyEditorProvider<EyeballDocument> {
  public static readonly viewType = 'eyeball.dataViewer';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<EyeballDocument> {
    const dataSource = createDataSource(uri.fsPath);
    return new EyeballDocument(uri, dataSource);
  }

  async resolveCustomEditor(document: EyeballDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webviewPanel.webview.html = getHtmlForWebview(webviewPanel.webview, this.context.extensionUri);

    let currentTable: string | undefined;

    const post = (message: HostToWebviewMessage) => webviewPanel.webview.postMessage(message);

    const sendRowCount = (table: string | undefined) => {
      document.dataSource
        .getRowCount(table)
        .then((count) => post({ type: 'rowCount', count }))
        .catch(() => post({ type: 'rowCount', count: null }));
    };

    const sendInit = async () => {
      try {
        const tables = await document.dataSource.listTables();
        currentTable = tables?.[0];
        const columns = await document.dataSource.getColumns(currentTable);
        post({
          type: 'init',
          kind: document.dataSource.kind,
          fileName: basename(document.uri),
          tables,
          currentTable,
          columns,
        });
        sendRowCount(currentTable);
      } catch (err) {
        post({ type: 'error', message: errorMessage(err) });
      }
    };

    webviewPanel.webview.onDidReceiveMessage(async (message: WebviewToHostMessage) => {
      switch (message.type) {
        case 'ready':
          await sendInit();
          break;

        case 'selectTable':
          currentTable = message.table;
          try {
            const columns = await document.dataSource.getColumns(currentTable);
            post({ type: 'columns', columns, currentTable });
            sendRowCount(currentTable);
          } catch (err) {
            post({ type: 'error', message: errorMessage(err) });
          }
          break;

        case 'getRows':
          try {
            const rows = await document.dataSource.getRows(
              currentTable,
              message.offset,
              message.limit,
              message.sort as SortSpec | undefined,
            );
            post({ type: 'rows', requestId: message.requestId, offset: message.offset, rows });
          } catch (err) {
            post({ type: 'error', requestId: message.requestId, message: errorMessage(err) });
          }
          break;
      }
    });
  }
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1] || uri.path;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

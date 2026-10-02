import * as vscode from 'vscode';

export function getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Eyeball</title>
</head>
<body>
  <div id="app">
    <div id="toolbar">
      <span id="file-name"></span>
      <select id="table-select" style="display:none;"></select>
      <span id="status"></span>
    </div>
    <div id="error-banner" style="display:none;"></div>
    <div id="grid-container">
      <div id="grid-header"></div>
      <div id="grid-scroll">
        <div id="grid-spacer"></div>
        <div id="grid-rows"></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

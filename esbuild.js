const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    sourcemap: !production,
    minify: production,
    external: ['vscode', 'duckdb', 'better-sqlite3'],
  });

  const webviewCtx = await esbuild.context({
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    outfile: 'dist/webview.js',
    platform: 'browser',
    target: 'es2020',
    format: 'iife',
    sourcemap: !production,
    minify: production,
  });

  fs.mkdirSync('dist', { recursive: true });
  fs.copyFileSync(path.join('src', 'webview', 'main.css'), path.join('dist', 'webview.css'));

  if (watch) {
    await extensionCtx.watch();
    await webviewCtx.watch();
    console.log('watching for changes...');
  } else {
    await extensionCtx.rebuild();
    await webviewCtx.rebuild();
    await extensionCtx.dispose();
    await webviewCtx.dispose();
    console.log('build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

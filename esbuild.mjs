// Bundles the extension host code (Node, CommonJS) and the webview (browser IIFE).
import * as esbuild from 'esbuild'
import { cpSync } from 'node:fs'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
}

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node16', // VS Code 1.75
    external: ['vscode'],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome102', // VS Code 1.75
  }),
])

cpSync('webview/style.css', 'dist/webview.css')

if (watch) {
  await Promise.all(contexts.map(ctx => ctx.watch()))
} else {
  await Promise.all(contexts.map(ctx => ctx.rebuild()))
  await Promise.all(contexts.map(ctx => ctx.dispose()))
}

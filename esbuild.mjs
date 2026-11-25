// Bundles the extension host code (Node, CommonJS) and the webviews (browser IIFE), and copies
// Mol*'s prebuilt viewer for the structure viewer.
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
  esbuild.context({
    ...common,
    entryPoints: ['webview/structure.ts'],
    outfile: 'dist/structure.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome102',
  }),
])

cpSync('webview/style.css', 'dist/webview.css')
cpSync('webview/structure.css', 'dist/structure.css')
const molstar = 'node_modules/molstar'
cpSync(`${molstar}/build/viewer/molstar.js`, 'dist/molstar/molstar.js')
cpSync(`${molstar}/build/viewer/theme/light.css`, 'dist/molstar/light.css')
cpSync(`${molstar}/build/viewer/theme/dark.css`, 'dist/molstar/dark.css')
cpSync(`${molstar}/LICENSE`, 'dist/molstar/LICENSE')

if (watch) {
  await Promise.all(contexts.map(ctx => ctx.watch()))
} else {
  await Promise.all(contexts.map(ctx => ctx.rebuild()))
  await Promise.all(contexts.map(ctx => ctx.dispose()))
}

// One-off exporter: build a standalone page from the delivered archify HTML's
// inline diagram SVG + embedded styles, then rasterize it with headless Chrome.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [htmlPath, outPath, theme = 'light'] = process.argv.slice(2);
const SCALE = 2;

const html = fs.readFileSync(htmlPath, 'utf8');

const styles = [];
for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) styles.push(match[1]);

const start = html.indexOf('<svg viewBox=');
if (start < 0) throw new Error('Diagram SVG not found.');
const end = html.indexOf('</svg>', start);
if (end < 0) throw new Error('Diagram SVG is unterminated.');
const svg = html.slice(start, end + '</svg>'.length);

const viewBox = /viewBox="([\d.\s-]+)"/.exec(svg);
const [vbX, vbY, vbW, vbH] = viewBox[1].trim().split(/\s+/).map(Number);

const page = `<!doctype html>
<html lang="zh-CN" data-theme="${theme}" data-preset="classic" data-motion="still">
<head><meta charset="utf-8"><title>diagram</title>
<style>${styles.join('\n')}</style>
<style>
/* --surface-1 is never defined in the artifact's stylesheets (always falls
 * back to #fff), so a dark-theme export rendered dark nodes on a white page.
 * Use the page's real background variable with a dark-typical fallback, and
 * add breathing room below the viewBox so bottom-edge labels (the SSE
 * corridor pill) are not clipped by the canvas edge. */
html,body{margin:0;padding:0;background:var(--bg,#020617);}
.diagram-container{display:block;width:${vbW}px;height:${vbH + 12}px;margin:0;padding:0;border:0;box-shadow:none;border-radius:0;background:var(--bg,#020617);overflow:visible;}
.diagram-container>svg{display:block;width:${vbW}px;height:${vbH}px;}
</style>
</head>
<body><div class="diagram-container" data-detail-level="read">${svg}</div></body>
</html>`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-png-'));
const pagePath = path.join(tmpDir, 'diagram.html');
fs.writeFileSync(pagePath, page);

const target = path.resolve(outPath);
const result = spawnSync(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--force-device-scale-factor=${SCALE}`,
  `--window-size=${Math.round(vbW)},${Math.round(vbH + 12)}`,
  `--user-data-dir=${path.join(tmpDir, 'profile')}`,
  `--screenshot=${target}`,
  pathToFileURL(pagePath).href,
], { stdio: 'pipe', encoding: 'utf8', timeout: 120000 });

if (!fs.existsSync(target)) {
  throw new Error(`Chrome produced no screenshot (status ${result.status}): ${(result.stderr || '').slice(-400)}`);
}
console.log(JSON.stringify({
  output: target,
  bytes: fs.statSync(target).size,
  viewBox: [vbX, vbY, vbW, vbH],
  pixelScale: SCALE,
  theme,
}, null, 1));

fs.rmSync(tmpDir, { recursive: true, force: true });

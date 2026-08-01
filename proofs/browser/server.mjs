/**
 * Fixture server for the `proof:browser` identity lane.
 *
 * pencil-boil publishes TypeScript source directly (no build step), so the browser lane
 * cannot `<script src>` a compiled bundle. Instead this server transpiles the SHIPPED
 * `src/raster.ts` to browser ESM on the fly via Node's native type-stripper
 * (`module.stripTypeScriptTypes`) — the lane exercises the real `rasterizePoseToBlob` /
 * `serializePoseSvg` / `isSelfContainedSvg`, not a copy. `raster.ts` is dependency-free and
 * type-erasable (interfaces + annotations only), so strip mode suffices.
 *
 * Routes: /health, /fixture.html, /fixture.js (static), /raster.js (transpiled). Bound to
 * 127.0.0.1 on PORT (env, default 4337 — a private high port; 3000/3001 are never touched).
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const PORT = Number(process.env.PORT) || 4337;

const JS = 'text/javascript; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

function serveFile(res, absPath, type) {
  try {
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(absPath));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err && err.message ? err.message : err));
  }
}

const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (url === '/' || url === '/fixture.html') {
    serveFile(res, join(here, 'fixture.html'), HTML);
    return;
  }
  if (url === '/fixture.js') {
    serveFile(res, join(here, 'fixture.js'), JS);
    return;
  }
  if (url === '/raster.js') {
    // Transpile the SHIPPED source — no build step, no copy.
    try {
      const src = readFileSync(join(repoRoot, 'src', 'raster.ts'), 'utf8');
      const js = stripTypeScriptTypes(src, { mode: 'strip' });
      res.writeHead(200, { 'content-type': JS });
      res.end(js);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err && err.message ? err.message : err));
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[proof:browser] fixture server on http://127.0.0.1:${PORT}`);
});

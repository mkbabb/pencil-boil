/**
 * Fixture server for the proof:browser identity lane.
 *
 * Startup packs the already-built candidate with scripts disabled, authenticates the one
 * tarball, extracts package/dist/raster.js, and serves that exact compiled artifact. No source
 * file is served or transpiled by this lane. The temporary pack/extract root is removed on
 * normal close, SIGINT, SIGTERM, and every initialization failure.
 *
 * Routes: /_proof/health/<run-token>, /fixture.html, /fixture.js (static), /raster.js (packed dist artifact).
 */
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const PORT = Number(process.env.PORT) || 4337;
const RUN_TOKEN = process.env.PENCIL_BROWSER_RUN_TOKEN;
const JS = 'text/javascript; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

let temporaryRoot = null;
let server = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}

function shutdown(code) {
  cleanup();
  if (server) {
    server.close(() => process.exit(code));
  } else {
    process.exit(code);
  }
}

process.once('SIGINT', () => shutdown(130));
process.once('SIGTERM', () => shutdown(143));
process.once('exit', cleanup);

function serveBuffer(res, body, type) {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
}

function serveFile(res, absPath, type) {
  try {
    serveBuffer(res, readFileSync(absPath), type);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err && err.message ? err.message : err));
  }
}

async function initialize() {
  assert.ok(RUN_TOKEN && RUN_TOKEN.trim(), 'PENCIL_BROWSER_RUN_TOKEN is required');
  temporaryRoot = mkdtempSync(join(tmpdir(), 'pencil-browser-pack-'));
  const packDirectory = join(temporaryRoot, 'pack');
  const extractDirectory = join(temporaryRoot, 'extract');
  mkdirSync(packDirectory);
  mkdirSync(extractDirectory);

  const packed = await execFile(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--silent', '--pack-destination', packDirectory],
    { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 },
  );
  const records = JSON.parse(packed.stdout);
  assert.equal(records.length, 1, 'browser proof pack must contain exactly one tarball record');
  const record = records[0];
  assert.equal(record.name, packageJson.name, 'browser proof pack name');
  assert.equal(record.version, packageJson.version, 'browser proof pack version');
  assert.ok(record.files.some((entry) => entry.path === 'dist/raster.js'), 'packed dist/raster.js');
  assert.ok(!record.files.some((entry) => entry.path === 'src' || entry.path.startsWith('src/')), 'no packed src tree');

  const tarballPath = join(packDirectory, record.filename);
  const tarball = readFileSync(tarballPath);
  const tarballSha256 = createHash('sha256').update(tarball).digest('hex');
  await execFile('tar', ['-xzf', tarballPath, '-C', extractDirectory], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  const rasterPath = join(extractDirectory, 'package', 'dist', 'raster.js');
  assert.ok(existsSync(rasterPath), 'extracted package/dist/raster.js');
  const raster = readFileSync(rasterPath);
  assert.ok(!raster.toString('utf8').includes('src/raster.ts'), 'served artifact contains no source marker');
  cleanup();
  const identity = {
    token: RUN_TOKEN,
    name: packageJson.name,
    version: packageJson.version,
    tarballSha256,
    bytes: tarball.length,
    served: 'package/dist/raster.js',
    srcServed: false,
  };

  server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === `/_proof/health/${RUN_TOKEN}`) {
      serveBuffer(res, JSON.stringify(identity), 'application/json; charset=utf-8');
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
      serveBuffer(res, raster, JS);
      return;
    }
    // There is intentionally no source route.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(
      `[proof:browser] packed ${identity.name}@${identity.version} ` +
        `sha256=${identity.tarballSha256} bytes=${identity.bytes} served=${identity.served} src-served=${identity.srcServed} ` +
        `http://127.0.0.1:${PORT}`,
    );
  });
}

initialize().catch((err) => {
  console.error(`[proof:browser] initialization failed: ${err && err.stack ? err.stack : err}`);
  shutdown(1);
});

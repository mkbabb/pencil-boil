import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const packageVersion = packageJson.version;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'pencil-package-boundary-'));
const packDirectory = join(temporaryRoot, 'pack');
const consumerRoot = join(temporaryRoot, 'consumer');
mkdirSync(packDirectory);
mkdirSync(consumerRoot);

const commands = [];
const result = {
  schema: 'pencil-boil-package-boundary/v1',
  terminal: 'RED',
  package: { name: packageJson.name, version: packageVersion },
  commands,
};
let failure = null;

async function run(command, args, options = {}) {
  const started = performance.now();
  try {
    const output = await execFile(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      maxBuffer: 8 * 1024 * 1024,
    });
    const record = {
      command: [command, ...args].join(' '),
      exit: 0,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      stdout: output.stdout,
      stderr: output.stderr,
    };
    commands.push(record);
    return record;
  } catch (error) {
    const record = {
      command: [command, ...args].join(' '),
      exit: typeof error.code === 'number' ? error.code : 1,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error),
    };
    commands.push(record);
    throw Object.assign(new Error(`command failed: ${record.command}`), { record });
  }
}

function sha256(path) {
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

function writeConsumerFile(name, contents) {
  writeFileSync(join(consumerRoot, name), contents);
}

try {
  const pack = await run('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--silent',
    '--pack-destination',
    packDirectory,
  ]);
  const records = JSON.parse(pack.stdout);
  assert.equal(records.length, 1, 'pack must produce exactly one tarball');
  const packRecord = records[0];
  assert.equal(packRecord.name, packageJson.name);
  assert.equal(packRecord.version, packageVersion);
  const tarballPath = join(packDirectory, packRecord.filename);
  assert.ok(existsSync(tarballPath), 'packed tarball exists');
  const tarballIdentity = sha256(tarballPath);
  const membership = packRecord.files.map((entry) => entry.path).sort();
  assert.ok(membership.includes('dist/index.js'), 'tarball contains dist/index.js');
  assert.ok(membership.includes('dist/index.d.ts'), 'tarball contains dist/index.d.ts');
  assert.ok(!membership.some((entry) => entry === 'src' || entry.startsWith('src/')), 'tarball contains no src tree');
  assert.ok(
    !membership.some((entry) => entry.endsWith('.ts') && !entry.endsWith('.d.ts')),
    'tarball contains no raw implementation TypeScript',
  );
  const tarPackage = JSON.parse(
    (await run('tar', ['-xOf', tarballPath, 'package/package.json'])).stdout,
  );
  assert.equal(tarPackage.version, packageVersion, 'tarball package version matches package under test');

  writeConsumerFile(
    'package.json',
    `${JSON.stringify(
      {
        name: 'pencil-boil-installed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          [packageJson.name]: `file:${tarballPath}`,
          vue: '3.5.39',
        },
        devDependencies: { typescript: '7.0.2' },
      },
      null,
      2,
    )}\n`,
  );
  const install = await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: consumerRoot,
  });
  const installedPackagePath = join(consumerRoot, 'node_modules', '@mkbabb', 'pencil-boil');
  const installedVuePath = join(consumerRoot, 'node_modules', 'vue');
  assert.ok(existsSync(installedPackagePath), 'installed package exists');
  assert.ok(existsSync(installedVuePath), 'consumer has a real Vue dependency');
  assert.equal(lstatSync(installedPackagePath).isSymbolicLink(), false, 'installed package is not a symlink');
  assert.equal(lstatSync(installedVuePath).isSymbolicLink(), false, 'Vue dependency is not a symlink');
  const installedPackage = JSON.parse(readFileSync(join(installedPackagePath, 'package.json'), 'utf8'));
  const installedVue = JSON.parse(readFileSync(join(installedVuePath, 'package.json'), 'utf8'));

  writeConsumerFile(
    'runtime.mjs',
    `import * as pencil from ${JSON.stringify(packageJson.name)};\n\nconst required = ${JSON.stringify([
      'catmullRomToBezier',
      'ellipsePoints',
      'perturbPoints',
      'perturbPointsClosed',
      'pointsToLinear',
      'useLineBoil',
      'wobbleLinePoints',
    ])};\nconst missing = required.filter((name) => typeof pencil[name] !== 'function');\nif (missing.length) throw new Error(\`missing runtime exports: \${missing.join(', ')}\`);\nconsole.log(JSON.stringify({ exports: Object.keys(pencil).sort(), required }));\n`,
  );
  const runtime = await run(process.execPath, [join(consumerRoot, 'runtime.mjs')], {
    cwd: consumerRoot,
  });
  const runtimeOutput = JSON.parse(runtime.stdout.trim());

  const typeConsumer = `import {\n  catmullRomToBezier,\n  ellipsePoints,\n  perturbPoints,\n  perturbPointsClosed,\n  pointsToLinear,\n  useLineBoil,\n  wobbleLinePoints,\n  type WobbleOptions,\n} from ${JSON.stringify(packageJson.name)};\n\nconst options: WobbleOptions = { roughness: 1, segments: 8, seed: 7 };\nconst points: [number, number][] = [[0, 0], [1, 1], [2, 0]];\nconst line = wobbleLinePoints(0, 0, 10, 10, options);\nconst smooth = catmullRomToBezier(points);\nconst jagged = pointsToLinear(points);\nconst open = perturbPoints(points, 0, 0, 10, 10, 1, 7);\nconst closed = perturbPointsClosed([[0, 0], [1, 0], [1, 1]], 1, 7);\nconst ellipse = ellipsePoints(0, 0, 10, 5, options);\nconst handle = useLineBoil(2, 125);\nexport const typeProof = { line, smooth, jagged, open, closed, ellipse, frame: handle.currentFrame.value };\n`;
  writeConsumerFile('consumer.ts', typeConsumer);
  const typeModes = {};
  const typeCompiler = join(consumerRoot, 'node_modules', '.bin', 'tsc');
  for (const [name, module, moduleResolution] of [
    ['Bundler', 'ESNext', 'Bundler'],
    ['Node16', 'Node16', 'Node16'],
    ['NodeNext', 'NodeNext', 'NodeNext'],
  ]) {
    const configPath = join(consumerRoot, `tsconfig.${name.toLowerCase()}.json`);
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            lib: ['ES2020', 'DOM'],
            module,
            moduleResolution,
            strict: true,
            skipLibCheck: false,
            noEmit: true,
            isolatedModules: true,
            verbatimModuleSyntax: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
          },
          include: ['consumer.ts'],
        },
        null,
        2,
      )}\n`,
    );
    const typeCheck = await run(typeCompiler, ['-p', configPath], { cwd: consumerRoot });
    typeModes[name] = { exit: typeCheck.exit, durationMs: typeCheck.durationMs };
  }

  result.terminal = 'CLEAN';
  result.pack = {
    path: tarballPath,
    sha256: tarballIdentity.sha256,
    bytes: tarballIdentity.bytes,
    membership,
    packageVersion: tarPackage.version,
  };
  result.install = {
    exit: install.exit,
    consumerRoot,
    installedPackagePath,
    installedPackageRealPath: realpathSync(installedPackagePath),
    installedPackageSymlink: lstatSync(installedPackagePath).isSymbolicLink(),
    package: { name: installedPackage.name, version: installedPackage.version },
    vue: {
      name: installedVue.name,
      version: installedVue.version,
      symlink: lstatSync(installedVuePath).isSymbolicLink(),
    },
  };
  result.runtime = {
    executable: process.execPath,
    exit: runtime.exit,
    exports: runtimeOutput.exports,
    required: runtimeOutput.required,
  };
  result.types = typeModes;
} catch (error) {
  failure = error;
  result.error = {
    message: error instanceof Error ? error.message : String(error),
    command: error.record?.command,
    exit: error.record?.exit,
  };
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
  result.cleanup = {
    temporaryRoot,
    packDirectoryAbsent: !existsSync(packDirectory),
    consumerRootAbsent: !existsSync(consumerRoot),
  };
  result.terminal = failure ? 'RED' : 'CLEAN';
  console.log(JSON.stringify(result));
}

if (failure) process.exitCode = 1;

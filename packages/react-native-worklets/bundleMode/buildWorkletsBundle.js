#!/usr/bin/env node
'use strict';

/**
 * Builds a minimal, worklets-only bundle for the UI Worklet Runtime.
 *
 * In Bundle Mode, WorkletsModuleProxy::start() evaluates a bundle's top level
 * into a freshly created UI Worklet Runtime. Today it is handed the host app's
 * `sourceURL` (the WHOLE app bundle), so the UI runtime re-registers every app
 * module (`__d(...)`) a second time on the JS thread during startup — purely to
 * make the worklet modules resolvable via `__r(<workletHash>)` (see
 * src/memory/bundleUnpacker). The cost scales with app bundle size.
 *
 * The UI runtime only needs the worklet modules + the worklets entry (id -2) +
 * their react-native-worklets deps: worklet closure deps arrive serialized (not
 * via require), no `.worklets/*.js` file calls `__r()`, and forwarded module
 * imports are limited to the plugin's allowlist. So a worklets-only bundle is a
 * complete, self-contained graph — and dramatically smaller.
 *
 * This CLI produces that bundle. The host build runs it after its own bundle
 * step (so the transform-generated `.worklets/*.js` files exist), then ships
 * the output as `worklets.<platform>.bundle` alongside the app bundle; the
 * native WorkletsModule loads it in preference to the app bundle.
 *
 * Usage: node buildWorkletsBundle.js --platform <android|ios> --out
 * <bundle-path> [--project-root <dir>] [--metro-config <path>] [--reset-cache]
 * [--no-hbc]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const args = {
    platform: 'android',
    out: null,
    projectRoot: process.cwd(),
    metroConfig: null,
    resetCache: false,
    // Compile the bundle to Hermes bytecode. The host app bundle is HBC, so a
    // raw-JS worklets bundle would force Hermes to parse+compile it at runtime
    // (slower than the HBC app bundle it replaces). Default on; --no-hbc to skip.
    hbc: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--platform':
        i += 1;
        args.platform = argv[i];
        break;
      case '--out':
        i += 1;
        args.out = argv[i];
        break;
      case '--project-root':
        i += 1;
        args.projectRoot = path.resolve(argv[i]);
        break;
      case '--metro-config':
        i += 1;
        args.metroConfig = path.resolve(argv[i]);
        break;
      case '--reset-cache':
        args.resetCache = true;
        break;
      case '--no-hbc':
        args.hbc = false;
        break;
      default:
        break;
    }
  }
  if (!args.out) {
    args.out = path.join(os.tmpdir(), `worklets.${args.platform}.bundle`);
  }
  return args;
}

function resolveHermesc(/** @type {string} */ projectRoot) {
  const hermescDir = path.join(
    path.dirname(
      require.resolve('hermes-compiler/package.json', { paths: [projectRoot] })
    ),
    'hermesc'
  );
  const binByPlatform = {
    darwin: 'osx-bin/hermesc',
    linux: 'linux64-bin/hermesc',
    win32: 'win64-bin/hermesc.exe',
  };
  return path.join(
    hermescDir,
    binByPlatform[process.platform] ?? binByPlatform.linux
  );
}

function resolveWorkletsDir(/** @type {string} */ projectRoot) {
  const pkgJson = require.resolve('react-native-worklets/package.json', {
    paths: [projectRoot],
  });
  return path.join(path.dirname(pkgJson), '.worklets');
}

function listWorkletFiles(/** @type {string} */ workletsDir) {
  if (
    !fs.existsSync(workletsDir) ||
    fs.readdirSync(workletsDir).filter((f) => f.endsWith('.js')).length === 0
  ) {
    throw new Error(
      `[worklets-bundle] ${workletsDir} has no worklet modules. Run the app ` +
        `bundle first so the .worklets/*.js files exist.`
    );
  }
  return fs
    .readdirSync(workletsDir)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

// Metro registers modules as `__d((function(){...}),<id>,[<dep>,...])`. The id
// sits before the dependency array, which sits before the closing ")". Deps use
// a comma-separated form (comma only BETWEEN numbers) so the inner quantifier is
// linear — a trailing-optional-comma form backtracks exponentially on `,0,[0…`.
const MODULE_REG = /,(-?\d+),\[(-?\d+(?:,-?\d+)*|)\]\)/g;

function assertClosedGraph(
  /** @type {string} */ bundleSource,
  /** @type {string[]} */ workletFiles
) {
  const ids = new Set();
  const deps = new Set();
  for (const m of bundleSource.matchAll(MODULE_REG)) {
    ids.add(Number(m[1]));
    for (const t of m[2].split(',')) {
      if (t.trim()) {
        deps.add(Number(t));
      }
    }
  }
  const hashes = workletFiles.map((f) => Number(f.slice(0, -3)));
  const missingHashes = hashes.filter((h) => !ids.has(h));
  const dangling = [...deps].filter((d) => !ids.has(d));
  const fail = (/** @type {string} */ msg) => {
    throw new Error(`[worklets-bundle] correctness gate FAILED: ${msg}`);
  };
  if (!ids.has(-2)) {
    fail('worklets entry id -2 missing');
  }
  if (missingHashes.length) {
    fail(
      `${missingHashes.length} worklet hashes missing as module ids, e.g. ` +
        `${missingHashes.slice(0, 5).join(', ')}`
    );
  }
  if (dangling.length) {
    fail(
      `${dangling.length} dangling dep ids (referenced but not defined), e.g. ` +
        `${dangling.slice(0, 5).join(', ')}`
    );
  }
  return { moduleCount: ids.size, workletCount: hashes.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workletsDir = resolveWorkletsDir(args.projectRoot);
  const workletFiles = listWorkletFiles(workletsDir);

  console.log(
    `[worklets-bundle] entry over ${workletFiles.length} worklet modules`
  );
  // The entry must live under the project root so Metro (which hashes files via
  // its file map) can resolve it. A temp dir outside watchFolders fails.
  const cacheDir = path.join(args.projectRoot, 'node_modules', '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const entryPath = path.join(cacheDir, 'worklets-bundle-entry.js');
  const lines = ["import 'react-native-worklets';"];
  for (const f of workletFiles) {
    lines.push(`import 'react-native-worklets/.worklets/${f}';`);
  }
  fs.writeFileSync(entryPath, `${lines.join('\n')}\n`);

  console.log('[worklets-bundle] bundling worklets-only JS');
  // Resolve the react-native package dir, then its cli.js by path (RN's
  // package.json does not export ./cli.js, so require.resolve on it fails).
  const rnDir = path.dirname(
    require.resolve('react-native/package.json', { paths: [args.projectRoot] })
  );
  const cli = path.join(rnDir, 'cli.js');
  // Bundle JS to a temp file so we can run the correctness gate on the source
  // and (by default) hermesc it to the final --out.
  const jsBundle = args.hbc ? `${args.out}.js` : args.out;
  const bundleArgs = [
    cli,
    'bundle',
    '--platform',
    args.platform,
    '--dev',
    'false',
    '--entry-file',
    entryPath,
    '--bundle-output',
    jsBundle,
  ];
  if (args.metroConfig) {
    bundleArgs.push('--config', args.metroConfig);
  }
  if (args.resetCache) {
    bundleArgs.push('--reset-cache');
  }
  execFileSync('node', bundleArgs, {
    cwd: args.projectRoot,
    stdio: 'inherit',
  });

  console.log('[worklets-bundle] verifying closed module graph');
  const { moduleCount, workletCount } = assertClosedGraph(
    fs.readFileSync(jsBundle, 'utf8'),
    workletFiles
  );
  console.log(
    `[worklets-bundle] OK: entry -2 present; all ${workletCount} worklet ` +
      `hashes are module ids; ${moduleCount} modules, 0 dangling deps.`
  );

  if (args.hbc) {
    console.log('[worklets-bundle] compiling to Hermes bytecode');
    execFileSync(
      resolveHermesc(args.projectRoot),
      ['-emit-binary', '-O', '-w', '-out', args.out, jsBundle],
      { stdio: 'inherit' }
    );
    fs.rmSync(jsBundle, { force: true });
  }

  const mb = (fs.statSync(args.out).size / 1e6).toFixed(2);
  console.log(`[worklets-bundle] done: ${args.out} (${mb} MB)`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

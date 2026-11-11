// Proves that a Platform-shaped consumer can install the *published*
// @supabase/mcp-server-supabase package (plus its workspace dependency
// @supabase/mcp-utils) from real npm tarballs, on Platform's pinned zod
// version, entirely outside this pnpm workspace -- then exercises the
// package's public surface end to end.
//
// This is a packaging gate, not a unit test: it packs, installs with plain
// npm in a throwaway project outside the repo tree, and drives the packed
// artifact for real. Inspecting package.json/exports maps is explicitly not
// enough -- see AI-1044.
//
// Run with: pnpm test:packed-platform-consumer

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Platform's `develop` catalog pins zod to this exact version (checked
// 2026-08-11 at commit 603f39cb4c). The fixture installs this pin and verifies
// that create_project keeps its required schema properties. Update this
// constant when Platform's catalog pin changes.
const PLATFORM_ZOD_VERSION = '4.4.3';
// ---------------------------------------------------------------------------

// The stable SDK release this repo is built against (see AI-1044). Pinned
// exactly, rather than left as a range, so this gate can't silently start
// exercising a newer SDK release than the one the package actually targets.
const SDK_VERSION = '2.0.0';

// TypeScript used to typecheck the packed `.d.ts` surface in the fixture.
// Matches the minimum version the workspace itself develops against.
const TYPESCRIPT_VERSION = '5.6.3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixtures', 'packed-platform-consumer');

const SUPABASE_PACKAGE_NAME = '@supabase/mcp-server-supabase';
const UTILS_PACKAGE_NAME = '@supabase/mcp-utils';

const CHECKS = [
  {
    name: 'cjs-entry',
    // modern-mcp-call imports and calls the package's ESM entry.
    argv: [process.execPath, 'cjs-check.cjs'],
    marker: 'CJS_OK',
  },
  {
    name: 'type-declarations',
    argv: [
      path.join('node_modules', '.bin', 'tsc'),
      '--project',
      'tsconfig.json',
    ],
    marker: null,
  },
  {
    name: 'modern-mcp-call',
    argv: [process.execPath, 'modern-call.mjs'],
    marker: 'MODERN_CALL_OK',
  },
];

/** Runs a command, streaming its own stdout/stderr straight to the console. */
function runVisible(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/** Packs one workspace package into `destDir`, returning its packed manifest. */
function packWorkspacePackage(packageName, destDir) {
  const stdout = execFileSync(
    'pnpm',
    ['--filter', packageName, 'pack', '--json', '--pack-destination', destDir],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }
  );
  const packed = JSON.parse(stdout);
  return {
    name: packed.name,
    version: packed.version,
    tarballPath: packed.filename,
  };
}

/** Runs one fixture check and returns its captured stdout and stderr. */
function runCaptured(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const output = [error.stdout, error.stderr]
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(output || error.message);
  }
}

function assertRealDirectoryInstall(consumerDir, packageName) {
  const installedPath = path.join(
    consumerDir,
    'node_modules',
    ...packageName.split('/')
  );
  const linkStat = lstatSync(installedPath);
  if (linkStat.isSymbolicLink()) {
    throw new Error(
      `${packageName} was installed as a symlink at ${installedPath}; expected a real, ` +
        'copied directory -- workspace linkage leaked into the fixture'
    );
  }
  if (!statSync(installedPath).isDirectory()) {
    throw new Error(
      `${packageName} is not installed as a directory at ${installedPath}`
    );
  }
}

function writeFixtureProject(consumerDir, { supabase, utils }) {
  cpSync(fixtureDir, consumerDir, { recursive: true });

  const packageJson = {
    name: 'packed-platform-consumer-fixture',
    private: true,
    version: '0.0.0',
    type: 'module',
    description:
      'Throwaway fixture proving @supabase/mcp-server-supabase installs and runs on a ' +
      'Platform-shaped dependency graph, outside this pnpm workspace.',
    dependencies: {
      [SUPABASE_PACKAGE_NAME]: `file:${supabase.tarballPath}`,
      [UTILS_PACKAGE_NAME]: `file:${utils.tarballPath}`,
      '@modelcontextprotocol/server': SDK_VERSION,
      '@modelcontextprotocol/client': SDK_VERSION,
      '@modelcontextprotocol/node': SDK_VERSION,
      zod: PLATFORM_ZOD_VERSION,
    },
    devDependencies: {
      '@types/node': '22.17.2',
      typescript: TYPESCRIPT_VERSION,
    },
  };

  writeFileSync(
    path.join(consumerDir, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`
  );
}

function main() {
  console.log(
    'Building @supabase/mcp-utils and @supabase/mcp-server-supabase...'
  );
  runVisible(
    'pnpm',
    [
      '--filter',
      UTILS_PACKAGE_NAME,
      '--filter',
      SUPABASE_PACKAGE_NAME,
      'build',
    ],
    repoRoot
  );

  // Outside the repo tree on purpose: pnpm workspace resolution (workspace:,
  // catalog:, or symlinked node_modules) cannot reach in from here.
  const tmpRoot = mkdtempSync(
    path.join(tmpdir(), 'mcp-packed-platform-consumer-')
  );
  const tarballDir = path.join(tmpRoot, 'tarballs');
  const consumerDir = path.join(tmpRoot, 'consumer');
  mkdirSync(tarballDir, { recursive: true });

  try {
    console.log('\nPacking workspace tarballs...');
    const utils = packWorkspacePackage(UTILS_PACKAGE_NAME, tarballDir);
    const supabase = packWorkspacePackage(SUPABASE_PACKAGE_NAME, tarballDir);
    console.log(`Packed ${SUPABASE_PACKAGE_NAME}@${supabase.version}`);
    console.log(`Packed ${UTILS_PACKAGE_NAME}@${utils.version}`);

    console.log(
      `\nWriting consumer fixture (zod pinned to ${PLATFORM_ZOD_VERSION})...`
    );
    writeFixtureProject(consumerDir, { supabase, utils });

    console.log(
      '\nInstalling with plain npm (no pnpm, no workspace, no lifecycle scripts)...'
    );
    runVisible('npm', ['install', '--ignore-scripts'], consumerDir);

    console.log(
      '\nVerifying the install is a real copy, not a workspace symlink...'
    );
    assertRealDirectoryInstall(consumerDir, SUPABASE_PACKAGE_NAME);
    assertRealDirectoryInstall(consumerDir, UTILS_PACKAGE_NAME);

    console.log(`\nRunning the ${CHECKS.length} public-surface assertions...`);
    for (const { name, argv, marker } of CHECKS) {
      const [command, ...args] = argv;
      const output = runCaptured(command, args, consumerDir);

      if (marker && !output.includes(marker)) {
        throw new Error(`${name} did not report ${marker}\n${output}`.trim());
      }

      console.log(`  [PASS] ${name}`);
    }

    console.log(
      `\nPacked ${SUPABASE_PACKAGE_NAME} version tested: ${supabase.version}`
    );
    console.log(`\nAll ${CHECKS.length} assertions passed.`);
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch (error) {
    console.error(`\n${error.message}`);
    console.error(`Fixture left in place for inspection: ${tmpRoot}`);
    process.exitCode = 1;
  }
}

main();

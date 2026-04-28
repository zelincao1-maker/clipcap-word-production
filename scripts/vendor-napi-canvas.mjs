import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const projectRoot = process.cwd();
const legacyVendorRoot = path.join(projectRoot, 'vendor-runtime', 'napi-rs-runtime');
const vendorRoot = path.join(projectRoot, 'src', 'generated', 'vendor-runtime', 'napi-rs-runtime');
const vendorScopeRoot = path.join(vendorRoot, 'node_modules', '@napi-rs');

async function copyPackage(packageName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`, {
    paths: [projectRoot],
  });
  const sourceDir = path.dirname(packageJsonPath);
  const targetDir = path.join(vendorScopeRoot, packageName.replace('@napi-rs/', ''));

  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

async function main() {
  await fs.rm(legacyVendorRoot, { recursive: true, force: true });
  await fs.rm(vendorRoot, { recursive: true, force: true });
  await fs.mkdir(vendorScopeRoot, { recursive: true });

  const canvasPackageJsonPath = require.resolve('@napi-rs/canvas/package.json', {
    paths: [projectRoot],
  });
  const canvasPackageJson = JSON.parse(await fs.readFile(canvasPackageJsonPath, 'utf8'));

  await copyPackage('@napi-rs/canvas');

  const optionalDependencies = Object.keys(canvasPackageJson.optionalDependencies ?? {}).filter((name) =>
    name.startsWith('@napi-rs/canvas-'),
  );

  for (const packageName of optionalDependencies) {
    try {
      require.resolve(`${packageName}/package.json`, {
        paths: [projectRoot],
      });
    } catch {
      continue;
    }

    await copyPackage(packageName);
  }

  const realCanvasDir = realpathSync(path.dirname(canvasPackageJsonPath));
  const vendoredCanvasDir = path.join(vendorScopeRoot, 'canvas');

  if (!existsSync(path.join(vendoredCanvasDir, 'package.json'))) {
    throw new Error(
      `Failed to vendor @napi-rs/canvas from ${realCanvasDir} into ${vendoredCanvasDir}.`,
    );
  }
}

await main();

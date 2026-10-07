// node-pty 1.1.0's macOS prebuilt spawn-helper may ship without its execute bit.
// Repair only this package-owned helper; never touch Haze or user files.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, chmodSync } from 'node:fs';
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const folder of [`prebuilds/darwin-${process.arch}`, 'build/Release']) {
    const helper = join(root, folder, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

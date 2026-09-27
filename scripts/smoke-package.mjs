import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'search-rotation-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let client;
try {
  // Test the tarball rather than accidentally importing the working checkout.
  const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  // npm <=11 returns an array; npm 12 keys the result by package name.
  const pack = Array.isArray(packed) ? packed[0] : packed["search-rotation"];
  const names = pack.files.map(file => file.path);
  for (const file of ['dist/index.js', 'dist/version.js', 'static/app.js', 'static/index.html']) assert.ok(names.includes(file), `${file} missing from package`);
  assert.ok(names.every(file => !/^(test|node_modules|\.github)\//.test(file)), 'package includes development files');
  const install = join(temp, 'install'); mkdirSync(install);
  execFileSync(npm, ['install', '--prefix', install, '--omit=dev', '--no-audit', '--no-fund', join(temp, pack.filename)], { stdio: 'inherit' });
  const installed = join(install, 'node_modules', 'search-rotation');
  const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(installed, 'dist', 'index.js'), '--no-dashboard'],
    env: { ...process.env, SEARCH_ROTATION_HOME: join(temp, 'config') },
    stderr: 'pipe',
  });
  client = new Client({ name: 'package-smoke-test', version: '1.0.0' });
  await client.connect(transport, { timeout: 10_000 });
  assert.equal(client.getServerVersion()?.version, expected);
  const icons = client.getServerVersion()?.icons;
  assert.deepEqual(icons?.map(icon => icon.theme), ['light', 'dark']);
  assert.ok(icons.every(icon => icon.mimeType === 'image/png' && icon.src.startsWith('data:image/png;base64,')), 'packaged server icons missing');
  const list = await client.listTools();
  assert.deepEqual(list.tools.map(tool => tool.name).sort(), ['fetch_url', 'get_engine_status', 'open_dashboard', 'search_web', 'update_engine_config']);
  console.log(`Installed package v${expected}: MCP handshake and all five tools OK.`);
} finally {
  await client?.close();
  rmSync(temp, { recursive: true, force: true });
}

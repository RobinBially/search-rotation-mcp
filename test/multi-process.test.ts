import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VERSION } from '../src/version.js';

test('Two stdio harnesses use distinct dashboards and reload shared engine configuration', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-harness-'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port:number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const clients: Client[] = [];
  const urls: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const transport = new StdioClientTransport({ command:process.execPath,
        args:['--import','tsx',fileURLToPath(new URL('../src/index.ts',import.meta.url)), '--port',String(port)],
        env:{ ...process.env, SEARCH_ROTATION_HOME:dir, SEARCH_ROTATION_TOKEN:'' } as Record<string,string>, stderr:'pipe' });
      let logs = ''; transport.stderr!.on('data', data => {logs += data;});
      const client = new Client({name:'harness-test',version:'1'}); clients.push(client);
      await client.connect(transport,{timeout:10000});
      assert.equal(client.getServerVersion()?.version,VERSION);
      assert.equal((await client.listTools()).tools.length,5);
      const url = logs.match(/Dashboard: (http:\/\/[^\s]+)/)?.[1]; assert.ok(url); urls.push(url);
      assert.equal((await (await fetch(url+'api/meta')).json()).version,VERSION);
    }
    assert.notEqual(urls[0],urls[1]);
    const cfg = await (await fetch(urls[0]+'api/config')).json();
    cfg.engines.find((e:any) => e.id === 'exa').enabled = false;
    const saved = await fetch(urls[0]+'api/config',{method:'PUT',headers:{'content-type':'application/json',origin:new URL(urls[0]).origin},body:JSON.stringify(cfg)});
    assert.equal(saved.status,200);
    const other = await (await fetch(urls[1]+'api/config')).json();
    assert.equal(other.engines.find((e:any) => e.id === 'exa').enabled,false);
    const result = await clients[1].callTool({name:'get_engine_status',arguments:{}});
    const engines = result.structuredContent?.engines as Array<{id: string; enabled: boolean}>;
    assert.equal(engines.find(engine => engine.id === 'exa')?.enabled, false);
    // update_engine_config schreibt dieselbe Datei: der zweite Prozess sieht die
    // Änderung ohne Neustart, weil jeder Aufruf die Konfiguration neu lädt.
    const flipped = await clients[0].callTool({name:'update_engine_config',arguments:{enabled:{parallel:false}}});
    assert.notEqual(flipped.isError,true);
    const reread = await clients[1].callTool({name:'get_engine_status',arguments:{}});
    const rerows = reread.structuredContent?.engines as Array<{id: string; enabled: boolean}>;
    assert.equal(rerows.find(engine => engine.id === 'parallel')?.enabled, false);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    rmSync(dir,{recursive:true,force:true});
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mountSecurity } from '../src/web/security.js';
function fixture(token = '') {
    const app = new Hono();
    const security = mountSecurity(app, { token, origin: 'http://127.0.0.1:6277' });
    for (const route of ['/', '/app.js', '/i18n.js', '/style.css', '/api/config'])
        app.get(route, c => c.text('ok'));
    app.post('/api/test', c => c.json({ ok: true }));
    return { app, security };
}
const base = 'http://127.0.0.1:6277';
/** Minimale Config-Deps für MCP-Aufbauten, die keine Engine-Konfiguration anfassen. */
const configDeps = {
    getConfig: () => ({ version: 1 as const, engines: [], fetchOrder: [], settings: { port: 6277, token: '', monthlyLimits: {} } }),
    saveConfig: () => { },
};
test('blocks cross-origin simple POST and rebinding host, allows same-origin JSON', async () => {
    const { app } = fixture();
    assert.equal((await app.request(base + '/api/test', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{}' })).status, 403);
    assert.equal((await app.request('http://evil.example:6277/api/config')).status, 403);
    assert.equal((await app.request(base + '/api/test', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await app.request(base + '/api/test', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 200);
});
test('public statics, authenticated API and HttpOnly one-time-ticket session', async () => {
    const { app, security } = fixture('secret-fixture');
    assert.equal((await app.request(base + '/app.js')).status, 200);
    assert.equal((await app.request(base + '/api/config')).status, 401);
    assert.equal((await app.request(base + '/')).status, 303);
    const url = security.browserUrl();
    assert.ok(!url.includes('secret-fixture'));
    const login = await app.request(url);
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal((await app.request(base + '/api/config', { headers: { cookie: cookie.split(';')[0] } })).status, 200);
    assert.equal((await app.request(url)).status, 401);
    assert.equal((await app.request(base + '/api/config?token=secret-fixture')).status, 401);
});
test('manual login validates origin and never echoes token', async () => {
    const { app } = fixture('secret-fixture');
    const login = await app.request(base + '/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=secret-fixture' });
    assert.equal(login.status, 303);
    assert.ok(login.headers.get('set-cookie'));
    assert.ok(!(await (await app.request(base + '/login')).text()).includes('secret-fixture'));
    assert.equal((await app.request(base + '/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=secret-fixture' })).status, 403);
});
test('MCP preserves per-engine RouterError diagnostics and passes cancellation signal', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { buildMcpServer } = await import('../src/mcp/server.js');
    const { RouterError } = await import('../src/router.js');
    let signal: AbortSignal | undefined;
    const server = buildMcpServer({ router: { search: async (_input: unknown, opts: {
                signal?: AbortSignal;
            }) => { signal = opts.signal; throw new RouterError('All failed', [{ engine: 'test', ok: false, ms: 3, error: 'HTTP 429' }]); } } as never, status: async () => [], month: () => '', dashboardUrl: () => null, openDashboard: () => { }, ...configDeps });
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
        const result = await client.callTool({ name: 'search_web', arguments: { query: 'test' } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /HTTP 429/);
        assert.ok(signal instanceof AbortSignal);
    }
    finally {
        await client.close();
        await server.close();
    }
});
test('actual token-protected server boots public assets without logging credentials', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { once } = await import('node:events');
    const dir = await mkdtemp(join(tmpdir(), 'sr-security-'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--http', '--port', '18377'], { cwd: process.cwd(), env: { ...process.env, SEARCH_ROTATION_HOME: dir, SEARCH_ROTATION_TOKEN: 'startup-fixture-secret' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    try {
        const url = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('server startup timeout')), 10000);
            child.once('exit', () => { clearTimeout(timeout); reject(new Error('server exited before ready')); });
            child.stderr!.on('data', data => { log += String(data); const match = log.match(/Dashboard: (http:\/\/[^\s]+)/); if (match) {
                clearTimeout(timeout);
                resolve(match[1]);
            } });
        });
        assert.ok(!log.includes('startup-fixture-secret'));
        assert.equal(new URL(url).search, '');
        const index = await fetch(url, { redirect: 'manual' });
        assert.equal(index.status, 303);
        for (const asset of ['app.js', 'i18n.js', 'style.css'])
            assert.equal((await fetch(url + asset)).status, 200);
        assert.equal((await fetch(url + 'api/config')).status, 401);
        assert.equal((await fetch(url + 'api/config', { headers: { authorization: 'Bearer startup-fixture-secret' } })).status, 200);
    }
    finally {
        const exit = once(child, 'exit');
        child.kill();
        await exit;
        await rm(dir, { recursive: true, force: true });
    }
});
test('no-dashboard does not expose administration endpoints', async () => {
    const app = new Hono();
    mountSecurity(app, { token: 'fixture', origin: base, dashboardEnabled: false });
    app.get('/', c => c.text('admin'));
    assert.equal((await app.request(base + '/login')).status, 404);
    assert.equal((await app.request(base + '/')).status, 404);
});

test('HTTP client disconnect aborts the active router operation', async () => {
    const { serve } = await import('@hono/node-server');
    const { request } = await import('node:http');
    const { once } = await import('node:events');
    const { mountMcpHttp } = await import('../src/mcp/http.js');
    const app = new Hono();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let observed!: (value: boolean) => void;
    const aborted = new Promise<boolean>(resolve => { observed = resolve; });
    mountMcpHttp(app, {
        router: { search: async (_input: unknown, opts: { signal?: AbortSignal }) => {
            started();
            await new Promise<void>(resolve => {
                const timeout = setTimeout(() => { observed(false); resolve(); }, 500);
                opts.signal?.addEventListener('abort', () => { clearTimeout(timeout); observed(true); resolve(); }, { once: true });
            });
            return { items: [], engine: 'mock', attempts: [] };
        } } as never,
        status: async () => [], month: () => '', dashboardUrl: () => null, openDashboard: () => {}, ...configDeps,
    }, { allowedHosts: ['127.0.0.1'], allowedOrigins: ['http://127.0.0.1'] });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as { port: number };
    try {
        const req = request({ hostname: '127.0.0.1', port: address.port, path: '/mcp', method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
        req.on('error', () => {});
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_web', arguments: { query: 'mock' } } }));
        await ready;
        req.destroy();
        assert.equal(await aborted, true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('missing browser launcher does not terminate the server', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { once } = await import('node:events');
    const dir = await mkdtemp(join(tmpdir(), 'sr-no-browser-'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--http', '--open', '--port', '18477'], { env: { ...process.env, SEARCH_ROTATION_HOME: dir, PATH: dir }, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('startup timeout')), 3000);
            child.once('exit', () => { clearTimeout(timer); reject(new Error('early exit: ' + log)); });
            child.stderr!.on('data', data => { log += data; if (log.includes('Streamable HTTP')) { clearTimeout(timer); resolve(); } });
        });
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(child.exitCode, null, log);
    } finally {
        if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
        await rm(dir, { recursive: true, force: true });
    }
});

test('MCP status reports quota period, units, source and estimates', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { buildMcpServer } = await import('../src/mcp/server.js');
    const rows = [
        { label: 'Daily', quota: { period: 'day', unit: 'requests', limit: 100, used: 12, source: 'local', estimated: true, timeZone: 'America/Los_Angeles' } },
        { label: 'Monthly', quota: { period: 'month', unit: 'credits', limit: 1000, used: 2.5, source: 'remote', estimated: false } },
        { label: 'Keyless', quota: { period: 'ip', unit: 'requests', limit: null, used: null, source: 'unknown', estimated: true } },
    ].map(row => ({ ...row, enabled: true, capabilities: ['search'], keyless: 'ip', hasKey: row.label !== 'Keyless', searchPosition: 0, used: { search: 999, fetch: 0 }, monthlyLimit: 3000 }));
    const server = buildMcpServer({ router: {} as never, status: async () => rows as never, month: () => '', dashboardUrl: () => null, openDashboard: () => {}, ...configDeps });
    const client = new Client({ name: 'test', version: '1' });
    const [a,b] = InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
    try {
        const result = await client.callTool({ name: 'get_engine_status', arguments: {} });
        const data = result.structuredContent as any;
        const [daily, monthly, keyless] = data.engines;
        assert.equal(daily.quota.used, 12);
        assert.equal(daily.quota.limit, 100);
        assert.equal(daily.quota.period, 'day');
        assert.equal(daily.quota.unit, 'requests');
        assert.equal(daily.quota.source, 'local');
        assert.equal(daily.quota.estimated, true);
        assert.equal(daily.quota.timeZone, 'America/Los_Angeles');
        assert.equal(monthly.quota.used, 2.5);
        assert.equal(monthly.quota.unit, 'credits');
        assert.equal(monthly.quota.source, 'remote');
        assert.equal(monthly.quota.scope, 'provider_account_balance');
        assert.equal(monthly.quota.period, null);
        assert.equal(keyless.localUsage.successfulSearches, 999);
        assert.equal(keyless.quota.limit, null);
        assert.equal(keyless.quota.providerTotalUsed, null);
    } finally { await client.close();await server.close(); }
});

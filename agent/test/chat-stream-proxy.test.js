import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openChatStream } from '../lib/chat-stream.mjs';

const hasNginx = spawnSync('nginx', ['-v']).status === 0;
const delay = ms => new Promise(r => setTimeout(r, ms));
test('real nginx respects the streaming helper and delivers deltas before completion', { skip: !hasNginx, timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-proxy-'));
  const backend = Fastify();
  backend.post('/api/chat', async (_req, reply) => {
    const channel = openChatStream(reply);
    channel.emit({ type: 'delta', delta: 'first' });
    await delay(500);
    channel.emit({ type: 'done', reply: 'first and final' });
    channel.end();
    return reply;
  });
  await backend.listen({ host: '127.0.0.1', port: 0 });
  const upstreamPort = backend.server.address().port;
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const proxyPort = probe.address().port;
  await new Promise(r => probe.close(r));
  await writeFile(join(dir, 'nginx.conf'), `
pid ${dir}/nginx.pid;
error_log ${dir}/error.log;
events {}
http {
 access_log off;
 server {
  listen 127.0.0.1:${proxyPort};
  location /agent/ {
   proxy_pass http://127.0.0.1:${upstreamPort}/;
   proxy_http_version 1.1;
   proxy_buffering on;
   proxy_read_timeout 120s;
  }
 }
}`);
  const nginx = spawn('nginx', ['-p', dir, '-c', join(dir, 'nginx.conf'), '-g', 'daemon off;'], { stdio: 'ignore' });
  const exited = new Promise(r => nginx.once('exit', r));
  try {
    let response;
    const started = performance.now();
    for (let i = 0; i < 50; i++) {
      try { response = await fetch(`http://127.0.0.1:${proxyPort}/agent/api/chat`, { method: 'POST' }); break; }
      catch { await delay(20); }
    }
    assert.ok(response, 'nginx became ready');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('"delta"')) body += decoder.decode((await reader.read()).value);
    const first = performance.now() - started;
    assert.ok(!body.includes('"done"'), 'preview arrived without waiting for final');
    while (true) { const part = await reader.read(); if (part.done) break; body += decoder.decode(part.value); }
    assert.match(body, /"done"/);
    assert.ok(performance.now() - started - first >= 250, 'a real gap separates preview from completion');
  } finally {
    nginx.kill('SIGTERM');
    await exited;
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});

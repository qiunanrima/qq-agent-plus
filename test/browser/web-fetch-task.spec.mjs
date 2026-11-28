import { test, expect } from '@playwright/test';
import http from 'node:http';
import { once } from 'node:events';
import { interactWithPage, restrictBrowserRequests } from '../../src/web-fetch-browser/browser-interaction.js';

test('browser task submits a GET search and returns its destination', async ({ context }) => {
  const received = [];
  const server = http.createServer((request, response) => {
    received.push(request.method + ' ' + request.url);
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/' ? '<form action="/results"><label>Query<input name="q"></label><button>Search</button></form>' : '<h1>Search results</h1>');
  });
  server.on('upgrade', (_request, socket) => {
    received.push('upgrade');
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await restrictBrowserRequests(context);
    const page = await context.newPage();
    const base = 'http://127.0.0.1:' + server.address().port;
    await page.goto(base);
    expect(await page.evaluate(() => fetch('/write', { method: 'POST' }).then(() => true, () => false))).toBe(false);
    await page.evaluate(() => new Promise(resolve => {
      const socket = new WebSocket(location.origin.replace('http:', 'ws:'));
      socket.onclose = () => resolve(true);
    }));
    const result = await interactWithPage(page, [
      { role: 'textbox', name: 'Query', action: 'fill', value: 'example' },
      { role: 'button', name: 'Search', action: 'click' }
    ], new AbortController().signal);
    expect(result.url).toBe(base + '/results?q=example');
    expect(result.body).toContain('Search results');
    expect(received).toContain('GET /results?q=example');
    expect(received).not.toContain('POST /write');
    expect(received).not.toContain('upgrade');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('same task continues from a newly revealed control', async ({ page, browser }) => {
  const { retainSession, resumeSession, closeSession } = await import('../../src/web-fetch-browser/browser-session.js');
  await page.setContent('<button onclick="document.querySelector(\'label\').hidden=false">Filters</button><label hidden>Keyword<input></label>');
  const signal = new AbortController().signal;
  const first = await interactWithPage(page, [{ role: 'button', name: 'Filters', action: 'click' }], signal);
  expect(first.body).toContain('Keyword');
  retainSession({ owner: 'chat-a/task-a', page, browser, dispose: () => page.close() });
  try {
    await expect(resumeSession('chat-b/task-b', [], signal)).rejects.toThrow('unavailable');
    const second = await resumeSession('chat-a/task-a', [{ role: 'textbox', name: 'Keyword', action: 'fill', value: 'example' }], signal);
    expect(second.body).toContain('example');
  } finally {
    await closeSession();
  }
  await expect(resumeSession('chat-a/task-a', [], signal)).rejects.toThrow('unavailable');
});

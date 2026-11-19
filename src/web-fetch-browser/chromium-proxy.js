import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { validateFetchUrl } from '../llm/safe-fetch.js';

const validation = { allowFakeIpDns: false };

function publicAddress(url) {
  return validateFetchUrl(url.href, validation);
}

export async function openChromiumProxy(signal) {
  const sockets = new Set();
  const proxy = http.createServer(async (request, response) => {
    try {
      const target = new URL(request.url);
      if (target.protocol !== 'http:') throw new Error('Invalid HTTP proxy target');
      const { url, ip } = await publicAddress(target);
      signal.throwIfAborted();
      if (response.destroyed) return;
      const headers = { ...request.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const outgoing = http.request({
        host: ip, port: url.port || 80, path: url.pathname + url.search,
        method: request.method, headers, signal
      }, (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.on('error', () => response.destroy());
        incoming.pipe(response);
      });
      outgoing.on('error', () => response.destroy());
      response.on('close', () => outgoing.destroy());
      request.pipe(outgoing);
    } catch {
      response.writeHead(403).end();
    }
  });
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('connect', async (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    try {
      const target = new URL('https://' + request.url);
      if (target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid CONNECT target');
      const { url, ip } = await publicAddress(target);
      signal.throwIfAborted();
      if (socket.destroyed) return;
      const upstream = net.connect({ host: ip, port: Number(url.port || 443) });
      socket.on('close', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      upstream.on('close', () => socket.destroy());
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  return {
    url: 'http://127.0.0.1:' + proxy.address().port,
    async close() {
      const closed = new Promise(resolve => proxy.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    }
  };
}

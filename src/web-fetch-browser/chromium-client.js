import http from 'node:http';
import { isAbsolute } from 'node:path';

export async function renderChromiumDocument(url, { socketPath, signal, steps, owner, resume }) {
  if (!isAbsolute(socketPath)) throw new Error('Chromium socket must be an absolute path');
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: steps ? '/browse' : '/render', method: 'POST', signal }, async (response) => {
      try {
        if (response.statusCode !== 200) throw new Error('Chromium render failed');
        let body = '';
        response.setEncoding('utf8');
        for await (const chunk of response) {
          body += chunk;
          if (body.length > (steps ? 150_000 : 20_001)) throw new Error('Chromium response exceeds the text limit');
        }
        resolve(steps ? JSON.parse(body) : body);
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.on('error', reject);
    request.end(steps ? JSON.stringify({ url, steps, owner, resume }) : url);
  });
}

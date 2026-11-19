import http from 'node:http';
import { isAbsolute } from 'node:path';

export async function renderChromiumDocument(url, { socketPath, signal }) {
  if (!isAbsolute(socketPath)) throw new Error('Chromium socket must be an absolute path');
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/render', method: 'POST', signal }, async (response) => {
      try {
        if (response.statusCode !== 200) throw new Error('Chromium render failed');
        let body = '';
        response.setEncoding('utf8');
        for await (const chunk of response) {
          body += chunk;
          if (body.length > 20_001) throw new Error('Chromium response exceeds the text limit');
        }
        resolve(body);
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.on('error', reject);
    request.end(url);
  });
}

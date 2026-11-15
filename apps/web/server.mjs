import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendText(response, statusCode, message) {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}

function proxyApi(request, response, apiTarget, requestUrl) {
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, apiTarget.origin);
  const requestOptions = {
    method: request.method,
    headers: { ...request.headers, host: target.host },
  };
  const upstreamRequest = (target.protocol === 'https:' ? requestHttps : requestHttp)(
    target,
    requestOptions,
    (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers };
      delete headers.connection;
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      const closeDownstream = () => {
        if (!response.writableEnded) response.destroy();
      };
      upstreamResponse.on('aborted', closeDownstream);
      upstreamResponse.on('error', closeDownstream);
      upstreamResponse.on('close', () => {
        if (!upstreamResponse.complete) closeDownstream();
      });
      upstreamResponse.pipe(response);
    },
  );

  upstreamRequest.on('error', () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }

    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ detail: 'API service unavailable' }));
  });
  request.on('aborted', () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
}

async function serveStatic(request, response, distDir, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed');
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendText(response, 400, 'Invalid URL path');
    return;
  }

  const requestedFile = resolve(distDir, `.${decodedPath}`);
  if (requestedFile !== distDir && !requestedFile.startsWith(`${distDir}${sep}`)) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  let filePath = requestedFile;
  try {
    if (!(await stat(filePath)).isFile()) filePath = '';
  } catch {
    filePath = '';
  }

  if (!filePath) {
    const isRootRequest = decodedPath === '/'
      && (request.method === 'GET' || request.method === 'HEAD');
    const isPageNavigation = isRootRequest || (request.method === 'GET'
      && request.headers.accept?.includes('text/html'));
    if (!isPageNavigation) {
      sendText(response, 404, 'Not found');
      return;
    }
    filePath = resolve(distDir, 'index.html');
  }

  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    sendText(response, 404, 'Not found');
    return;
  }

  response.writeHead(200, {
    'cache-control': basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    'content-length': fileInfo.size,
    'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
}

export function createFrontendServer({
  apiUrl = process.env.API_URL ?? 'http://127.0.0.1:8000',
  distDir = resolve('dist'),
} = {}) {
  const apiTarget = new URL(apiUrl);
  if (apiTarget.protocol !== 'http:' && apiTarget.protocol !== 'https:') {
    throw new Error('API_URL must use HTTP or HTTPS');
  }
  if (apiTarget.username || apiTarget.password || apiTarget.pathname !== '/' || apiTarget.search || apiTarget.hash) {
    throw new Error('API_URL must be an origin without credentials, path, query, or fragment');
  }

  const staticRoot = resolve(distDir);
  return createServer((request, response) => {
    const requestTarget = request.url ?? '/';
    if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) {
      sendText(response, 400, 'Invalid request target');
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(requestTarget, 'http://frontend.local');
    } catch {
      sendText(response, 400, 'Invalid request URL');
      return;
    }
    if (requestUrl.origin !== 'http://frontend.local') {
      sendText(response, 400, 'Invalid request target');
      return;
    }

    if (requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/')) {
      proxyApi(request, response, apiTarget, requestUrl);
      return;
    }

    void serveStatic(request, response, staticRoot, requestUrl.pathname);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  createFrontendServer().listen(port, '0.0.0.0', () => {
    process.stdout.write(`Frontend listening on port ${port}\n`);
  });
}

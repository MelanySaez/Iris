import { createServer as createHttpServer, request as requestHttp } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFrontendServer } from '../../server.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestTarget(port, target) {
  return new Promise((resolve, reject) => {
    let body = '';
    const request = requestHttp({
      host: '127.0.0.1',
      method: 'GET',
      path: target,
      port,
    }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

function requestUntilResponseCloses(port, target) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    let response;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error('Downstream response did not close promptly'));
    }, 750);
    const request = requestHttp({
      host: '127.0.0.1',
      method: 'GET',
      path: target,
      port,
    }, (incoming) => {
      response = incoming;
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('aborted', () => finish({ body, complete: response.complete }));
      response.on('close', () => finish({ body, complete: response.complete }));
      response.on('error', () => finish({ body, complete: response.complete }));
    });
    request.on('error', (error) => {
      if (!settled) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    request.end();
  });
}

describe('frontend runtime server', () => {
  let tempDir;
  let frontend;
  let backend;
  let alternate;

  afterEach(async () => {
    await Promise.all([close(frontend), close(backend), close(alternate)]);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    frontend = undefined;
    backend = undefined;
    alternate = undefined;
    tempDir = undefined;
  });

  it('serves the SPA and falls back to index.html for client routes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'iris-web-runtime-'));
    const distDir = join(tempDir, 'dist');
    await mkdir(join(distDir, 'assets'), { recursive: true });
    await writeFile(join(distDir, 'index.html'), '<main>frontend</main>');
    await writeFile(join(distDir, 'assets', 'app.js'), 'console.log("app")');
    await writeFile(join(tempDir, 'secret.txt'), 'private');

    frontend = createFrontendServer({ distDir, apiUrl: 'http://127.0.0.1:9' });
    const port = await listen(frontend);

    const rootPage = await fetch(`http://127.0.0.1:${port}/`);
    expect(rootPage.status).toBe(200);
    expect(await rootPage.text()).toBe('<main>frontend</main>');

    const page = await fetch(`http://127.0.0.1:${port}/catalogs/nearby`, {
      headers: { accept: 'text/html' },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toBe('<main>frontend</main>');

    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toBe('console.log("app")');

    const traversal = await fetch(`http://127.0.0.1:${port}/%2e%2e%2fsecret.txt`);
    expect(traversal.status).toBe(403);
  });

  it('proxies API methods, bodies, paths, and query strings to API_URL', async () => {
    backend = createHttpServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString(),
        }));
      });
    });
    const backendPort = await listen(backend);

    tempDir = await mkdtemp(join(tmpdir(), 'iris-web-runtime-'));
    const distDir = join(tempDir, 'dist');
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, 'index.html'), '<main>frontend</main>');
    frontend = createFrontendServer({
      distDir,
      apiUrl: `http://127.0.0.1:${backendPort}`,
    });
    const frontendPort = await listen(frontend);

    const response = await fetch(
      `http://127.0.0.1:${frontendPort}/api/jobs?probe=1`,
      { method: 'POST', body: '{"name":"test"}' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: 'POST',
      url: '/api/jobs?probe=1',
      body: '{"name":"test"}',
    });
  });

  it('rejects API request targets that try to replace the configured origin', async () => {
    let alternateHits = 0;
    backend = createHttpServer((_request, response) => response.end('configured backend'));
    const backendPort = await listen(backend);
    alternate = createHttpServer((_request, response) => {
      alternateHits += 1;
      response.end('alternate origin');
    });
    const alternatePort = await listen(alternate);

    tempDir = await mkdtemp(join(tmpdir(), 'iris-web-runtime-'));
    const distDir = join(tempDir, 'dist');
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, 'index.html'), '<main>frontend</main>');
    frontend = createFrontendServer({
      distDir,
      apiUrl: `http://127.0.0.1:${backendPort}`,
    });
    const frontendPort = await listen(frontend);

    const targets = [
      `//127.0.0.1:${alternatePort}/api/probe`,
      `http://127.0.0.1:${alternatePort}/api/probe`,
    ];
    const responses = await Promise.all(targets.map((target) => requestTarget(frontendPort, target)));

    expect(responses.map((response) => response.statusCode)).toEqual([400, 400]);
    expect(alternateHits).toBe(0);
  });

  it('closes the downstream response when the API response aborts mid-body', async () => {
    backend = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-length': '1000' });
      response.write('partial');
      setTimeout(() => response.destroy(), 20);
    });
    const backendPort = await listen(backend);

    tempDir = await mkdtemp(join(tmpdir(), 'iris-web-runtime-'));
    const distDir = join(tempDir, 'dist');
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, 'index.html'), '<main>frontend</main>');
    frontend = createFrontendServer({
      distDir,
      apiUrl: `http://127.0.0.1:${backendPort}`,
    });
    const frontendPort = await listen(frontend);

    const result = await requestUntilResponseCloses(frontendPort, '/api/probe');

    expect(result.complete).toBe(false);
    expect(result.body).toBe('partial');
  });
});

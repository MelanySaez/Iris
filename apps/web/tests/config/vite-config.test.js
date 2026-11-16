import { afterEach, describe, expect, it } from 'vitest';
import viteConfig from '../../vite.config.ts';

describe('Vite API proxy configuration', () => {
  const previousApiUrl = process.env.API_URL;

  afterEach(() => {
    if (previousApiUrl === undefined) {
      delete process.env.API_URL;
    } else {
      process.env.API_URL = previousApiUrl;
    }
  });

  it('uses API_URL as the development proxy target', () => {
    process.env.API_URL = 'http://api.example.test:9000';
    const config = typeof viteConfig === 'function'
      ? viteConfig({ mode: 'test', command: 'serve', isSsrBuild: false, isPreview: false })
      : viteConfig;

    expect(config.server.proxy['/api'].target).toBe('http://api.example.test:9000');
  });
});

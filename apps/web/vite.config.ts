import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'API_URL');

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: env.API_URL?.trim() || 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.js'],
    },
  };
});

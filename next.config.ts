import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  serverExternalPackages: ['@napi-rs/canvas'],
  outputFileTracingIncludes: {
    '/*': [
      './node_modules/@napi-rs/**/*',
      './node_modules/.pnpm/node_modules/@napi-rs/**/*',
      './node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/**/*',
      './node_modules/.pnpm/@napi-rs+canvas-*@*/node_modules/@napi-rs/**/*',
    ],
  },
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;

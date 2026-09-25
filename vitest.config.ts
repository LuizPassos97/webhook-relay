import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { fileParallelism: false, testTimeout: 15000, hookTimeout: 30000, coverage: { provider: 'v8', include: ['apps/**/*.ts', 'packages/**/*.ts'], thresholds: { lines: 85, branches: 80 } } } });

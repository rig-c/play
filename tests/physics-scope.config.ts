import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const raw=process.env.TEST_PORT??'4397';const port=Number(raw);
if(!/^\d+$/.test(raw)||port<1024||port>65535)throw new Error('TEST_PORT must be a valid private test port');
export default defineConfig({testDir:'.',testMatch:['physics-scope.spec.ts','physics-scope-protocol.spec.ts'],workers:1,retries:0,timeout:180_000,reporter:'list',
 use:{baseURL:`http://localhost:${port}`,viewport:{width:900,height:640},deviceScaleFactor:1},
 projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'webkit',use:{browserName:'webkit'}}],
 webServer:{cwd:resolve(dirname(fileURLToPath(import.meta.url)),'..'),stdout:'pipe',stderr:'pipe',command:`bun tests/buildPhysicsScopeFixtures.ts && bunx tsc --noEmit && bunx vite build && bunx vite preview --port ${port} --strictPort`,port,reuseExistingServer:false,timeout:180_000}});

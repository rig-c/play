# Linked Source Development (`@rig-c/source`)

`@rig-c/play` ships a built bundle and declaration set (`dist/index.js` and `dist/*.d.ts`) in its published tarball (`files` in `package.json`). The published manifest exposes `./dist/index.js` for `import` and `./dist/index.d.ts` for `types`. Installed releases use these entries even when the consumer enables `@rig-c/source` for other packages.

In a linked workspace checkout where `@rig-c/play` is consumed directly from source without building `dist/`, enable the explicit `@rig-c/source` package export condition in the consuming tool.

## Package Export Contract

The checkout's `package.json` defines:

```json
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "@rig-c/source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

- **Default installed mode (no custom condition):** Node.js, Bun, TypeScript (`bundler` and `nodenext`), and Vite ignore `@rig-c/source` and resolve `./dist/index.d.ts` / `./dist/index.js`.
- **Explicit linked source mode (`@rig-c/source` enabled):** Resolvers select `./src/index.ts` directly without requiring `dist/` to exist or be rebuilt on source edits.
- **Published package:** The release packer removes the checkout-only condition from the staged manifest. The installed package resolves to `dist/` with either condition set.
- **Incomplete linked checkout:** Source mode needs `src/index.ts` and its dependencies. If both the source and built entries are missing, resolution fails.

## Consumer Wiring

### 1. Bun CLI / Runtime

Pass `--conditions=@rig-c/source` when running scripts or tests against a linked checkout:

```sh
bun --conditions=@rig-c/source ./cli.ts
```

### 2. TypeScript (`tsconfig.json`)

Add `@rig-c/source` to `compilerOptions.customConditions` (with `moduleResolution: "bundler"` and `allowImportingTsExtensions: true`, as `@rig-c/play` source and `@rig-c/core` source entries use TypeScript sources):

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "customConditions": ["@rig-c/source"],
    "allowImportingTsExtensions": true,
    "noEmit": true
  }
}
```

### 3. Vite (`vite.config.ts`)

Prepend `@rig-c/source` to Vite's client resolution conditions:

```ts
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    conditions: ['@rig-c/source', ...defaultClientConditions],
  },
});
```

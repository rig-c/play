# Linked Source Development (`@rig-c/source`)

`@rig-c/play` ships JavaScript entries, their shared chunk and declarations in the published tarball. The published manifest resolves both `@rig-c/play` and `@rig-c/play/composed-take` through `dist/`, even when the consumer enables `@rig-c/source` for other packages.

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
    },
    "./composed-take": {
      "@rig-c/source": "./src/composed-take.ts",
      "types": "./dist/composed-take.d.ts",
      "import": "./dist/composed-take.js"
    }
  }
}
```

- **Default installed mode (no custom condition).** Node.js, Bun, TypeScript (`bundler` and `nodenext`), and Vite use the built targets for the requested entry.
- **Explicit linked source mode (`@rig-c/source` enabled).** Resolvers select `./src/index.ts` or `./src/composed-take.ts` directly. The selected source file and its imports must be present in the linked checkout.
- **Published package.** The release packer removes the checkout-only condition from both exports in the staged manifest. Installed releases use the built targets with or without that condition.

See [mounting a composed take](REFERENCE.md#mounting-a-composed-take) for the subpath API.

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

// Ambient module declarations for the non-TypeScript things Vite resolves at
// build time; without them every `*.vue` import is "Cannot find module" the
// moment JS files are type-checked.
//
// `vite/client` covers the Vite-specific suffixes this project uses, so only
// the Vue single-file-component shape is spelled out below.
/// <reference types="vite/client" />

// `lib/monaco-surface.js` sets the `MonacoEnvironment` global `monaco-editor`
// declares, but it only imports `?worker` bundles itself, so on a check that
// covers `src/` alone nothing would have loaded that declaration.
/// <reference types="monaco-editor" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

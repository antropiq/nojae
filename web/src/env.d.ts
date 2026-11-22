// Ambient module declarations for the non-TypeScript things Vite resolves at
// build time. The TypeScript server has no idea what a `*.vue` file or a Vite
// `?worker` import is unless something says so: with them missing, every such
// import is "Cannot find module" the moment JS files are type-checked.
//
// `vite/client` carries the declarations for the Vite-specific suffixes this
// project actually uses -- `*?worker` (the Monaco workers in
// `lib/monaco-surface.js`), `*.mp3` (`composables/useSessionSound.js`) and the
// style imports in `main.js` -- so only the Vue single-file-component shape is
// spelled out here.
/// <reference types="vite/client" />

// `MonacoEnvironment` is a global `monaco-editor` declares (in
// `esm/vs/editor/editor.api.d.ts`), and `lib/monaco-surface.js` sets it. The
// two `.vue` surfaces reach it through a plain `import * as monaco`, but the
// surface module itself only imports `?worker` bundles, so on a check that
// covers `src/` alone nothing would have loaded the declaration, and those two
// assignments would read as unknown properties on `window`.
/// <reference types="monaco-editor" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

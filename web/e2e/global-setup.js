import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const WEB_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// The browser the suite drives, checked **before** anything is built: a run that
// cannot launch is not worth a minute of `vite build` first.
//
// `playwright.config.js` names no executable unless PLAYWRIGHT_EXECUTABLE_PATH is
// set, so by default this is the browser @playwright/test pins — the one
// `npx playwright install --with-deps chromium` downloads on this platform. Ask
// it where that lives and look: the launch error a missing download produces
// talks about a binary path, which says nothing about the command that fixes it.
// With an explicit PLAYWRIGHT_EXECUTABLE_PATH there is nothing to assert: the
// caller named the binary, and its own existence is theirs.
function requirePinnedBrowser() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return
  const executable = chromium.executablePath()
  if (existsSync(executable)) return
  throw new Error(
    `The Chromium this suite drives is not installed:\n  ${executable}\n` +
      'Install the browser this @playwright/test version pins, with its system ' +
      'dependencies, on your platform:\n' +
      '    npx playwright install --with-deps chromium\n' +
      '(https://playwright.dev/docs/intro). To drive a browser of your own ' +
      'instead, set PLAYWRIGHT_EXECUTABLE_PATH to its path.',
  )
}

// FastAPI only mounts the SPA when `web/dist` exists (see the static mount in
// src/api/server.py), so a e2e run against a stale or absent build silently
// tests the previous frontend. Build unless dist is there and the run was
// told to trust it (E2E_SKIP_BUILD=1, for iterating on specs while `npm run
// build -- --watch` feeds dist).
export default async function globalSetup() {
  requirePinnedBrowser()
  if (existsSync(join(WEB_ROOT, 'dist')) && process.env.E2E_SKIP_BUILD === '1') {
    return
  }
  // One command string, run through the shell: on Windows `npm` is `npm.cmd`,
  // and since the CVE-2024-27980 fix Node refuses to spawn a `.cmd`/`.bat`
  // without `shell: true`, so an `execFileSync('npm', [...])` dies with ENOENT
  // before the build starts. `execSync` always uses a shell — which is why this
  // is a string and not an argument array (an array plus a shell would also
  // earn a DEP0190 warning on every run). Nothing here takes user input.
  execSync('npm run build', { cwd: WEB_ROOT, stdio: 'inherit' })
}

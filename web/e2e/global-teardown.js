import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Every scratch workspace the specs create under the repo. They are fixtures,
// not project files: the teardown removes them after the whole suite, so an
// interrupted run does not leave a tree behind and a later run starts from the
// same state a clean checkout has. `e2e-ws-root` is kept between its file's
// tests on purpose (one admission seeds it, and a pool entry outlives a folder),
// so it is the last thing to go.
const WEB_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = path.dirname(WEB_ROOT)
const SCRATCHES = ['e2e-workspace', 'e2e-ws-root', 'e2e-two-tabs-a', 'e2e-two-tabs-b']

export default async function globalTeardown() {
  for (const name of SCRATCHES) {
    const target = path.join(REPO_ROOT, name)
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // Still held while a handle closes; the next attempt retries.
      }
      if (!fs.existsSync(target)) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

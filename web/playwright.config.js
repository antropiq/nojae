import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// Layer 2: end-to-end tests. Playwright drives a real Chromium against the
// real FastAPI app (built SPA + /api + SSE), never the Vite dev server, so
// what is exercised is what `nojae` actually serves.
//
// Not the app's own default port: that is where a developer's `nojae` usually
// sits, and sharing it would make the suite reuse whatever server and whatever
// build happened to be on disk — passing specs proving nothing. A dedicated
// port also means e2e and a manually-run app can coexist.
//
// `E2E_PORT` chooses it (default 8123), and it is a Playwright-side name rather
// than the app's `--port` boot flag on purpose: this harness spawns the server
// with `uvicorn`'s own parser (below), so the app under test runs on its
// unflagged defaults exactly as a human's plain `nojae` boot would, and the port
// it binds is handed to it on its command line. A spec that wants a flag starts
// its own server.
const PORT = Number(process.env.E2E_PORT ?? 8123)
const BASE_URL = `http://127.0.0.1:${PORT}`

// Which Chromium to drive. Unset, that is Playwright's own pinned browser — the
// one `npx playwright install --with-deps chromium` downloads, whatever the
// platform (see the "End-to-end tests" section of docs/SETUP.md). Nothing here
// names a binary: a hard-coded path is a machine's fact, it is wrong on every
// other machine, and a launch failure about a missing file explains nothing.
//
// PLAYWRIGHT_EXECUTABLE_PATH is the one override, for a run that must drive a
// browser of its own (a system Chromium, a channel build). It is an escape
// hatch, not a default.
const EXECUTABLE_PATH = process.env.PLAYWRIGHT_EXECUTABLE_PATH

// The suite's own model connection: `tests/nojae-test-settings.json`, **next to
// this file** — with the specs that read it and the stub server it points at.
// It used to sit in the installation's reserved `.nojae/`, which made an
// install-scoped fixture live in a per-workspace folder and kept it out of git;
// here it is a committed test resource, and no developer's working location
// decides the lookup. `src/core/appdb` reads the same path
// (`TEST_SETTINGS_DIR`), and `tests/test_appdb_test_fixture.py` pins that the
// two spellings agree.
//
// It is **a store fixture, not a UI payload**, so its member names are the
// *column* names — one `server` object holding one `model` object, with no ids
// (the harness assigns both). It is the only connection a spec may use. The app
// never creates or writes it, and with the switch below on there is no fallback
// in either direction: a missing fixture must stop the suite here rather than
// look like an app bug — or, worse, silently reach the developer's own store
// and key.
//
// The specs name their own folders per request; the config names none. There is
// therefore no second environment lookup here: a scenario's workspace is the
// field on its requests, never this file's business.
export const TEST_SETTINGS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  'tests',
  'nojae-test-settings.json',
)

if (!existsSync(TEST_SETTINGS_FILE)) {
  throw new Error(
    `E2E test settings file not found: ${TEST_SETTINGS_FILE}\n` +
      'It is the only model connection a e2e spec may use, and it is authored ' +
      'by hand — the app never creates it. It describes one server with one ' +
      'model, using the store\'s column names (see "Setting up tests for nojae" ' +
      'in docs/SETUP.md), and the stub model server this config starts answers ' +
      'the address it names.',
  )
}

// The fixture's own two values, read here rather than repeated, because they are
// the pair that has to match what the server under test resolves: the stub's
// address, which this config starts, and the model id it is advertised under.
// The stub serves **any** name it is asked for, so the model id never has to be
// kept in step by hand — but `/v1/models`, and the occupancy badge that reads
// it, answer the one `--model` is started with, so this starts that one.
const testSettings = JSON.parse(readFileSync(TEST_SETTINGS_FILE, 'utf8'))
const FAKE_SERVER_URL = String(testSettings.server?.url ?? '')
const FAKE_MODEL = String(testSettings.server?.model?.name ?? '')
let FAKE_SERVER_HOST = '127.0.0.1'
let FAKE_SERVER_PORT = NaN

try {
  const parsed = new URL(FAKE_SERVER_URL)
  FAKE_SERVER_HOST = parsed.hostname
  FAKE_SERVER_PORT = Number(parsed.port)
} catch {
  // Left as it is: the refusal below names the member, which is the whole answer.
}

if (!FAKE_MODEL || !Number.isInteger(FAKE_SERVER_PORT) || FAKE_SERVER_PORT <= 0) {
  throw new Error(
    `E2E test settings file ${TEST_SETTINGS_FILE} has no usable server.url / ` +
      'server.model.name. This config starts tools/openai_fake_server.py on the ' +
      'address the url names (host and port) and advertises it under that model ' +
      'id, so both have to be there before a spec runs.',
  )
}

// What the server under test is booted with, and nothing else.
//
// This used to be `readEnvFile('.env.test')` — the app-level keys, which lived
// in a file the suite parsed so those keys, and nothing ambient, decided what a
// spec talked to. There are no app-level keys any more: the debug switch, the
// endpoint-wait pair and the port are **boot flags** on the command line, and
// the connector interpreter is the running interpreter. So the only
// configuration a suite may still pin through the environment is what is
// genuinely environment-scoped — the three switches below — and they are written
// here rather than in a file, because there is no per-machine value left to
// carry. The precedence the parser existed to enforce is untouched: `webServer.env`
// is applied last when Playwright spawns the server, so these beat anything a
// parent process (a running app's own process tree, an agent's shell) exported.
//
// The debug switch and the wait's pair for a suite run are therefore the app's
// own defaults — off, 3 × 10 s — which is also what they were whenever `.env.test`
// left them commented out, i.e. what they are on every machine that ever ran
// this suite.

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // The app streams for as long as a model takes to answer, so the defaults
  // (5 s) are far too tight: an assertion here waits for a *stream*, not for a
  // DOM mutation. Timeouts only bound the wait — what makes a spec *deterministic*
  // is asserting on app state the composables own (an event count, a stream
  // phase), never on a sleep.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // Specs share one global server, one settings store and its catalogues, so
  // they must not race each other's writes. Two tabs inside one spec are how the
  // two-tab run stays deterministic; two specs racing over one server would not
  // be, and spec D7 refuses the cross-tab invalidation that could make it safe.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    // Streaming UI is the hardest thing here to debug: the trace records which
    // SSE chunk arrived when.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30_000,
    // Desktop browsers only — the app has no mobile layout, so a viewport
    // matrix would only add noise.
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // A path, not `channel` — channels name branded installs like "chrome".
        launchOptions: { executablePath: EXECUTABLE_PATH },
      },
    },
  ],
  // Two servers, in the order they are started: the **stub model server** the
  // suite answers, then the app under test. Playwright sets the entries up in
  // list order and takes them down in reverse, so the model is already serving
  // when the app boots and the app is gone before the stub stops.
  webServer: [
    {
      // `tools/openai_fake_server.py` — an OpenAI-compatible stub, stdlib-only,
      // serving the address and the model id the fixture names. Started here
      // rather than left to the developer: with it, the suite needs no reachable
      // model, and a streamed reply has an exactly-known shape (word-sized
      // frames, a finish reason, a usage block), which is what lets a spec
      // assert on a stream instead of merely surviving one.
      //
      // `reuseExistingServer` is off **on purpose**, unlike the app below: the
      // stub is this harness's own process, so a foreign listener on its port
      // would answer specs with something the suite does not control. Playwright
      // names the URL when that happens.
      name: 'fake-model',
      command:
        `python tools/openai_fake_server.py --host ${FAKE_SERVER_HOST} ` +
        `--port ${FAKE_SERVER_PORT} --model ${FAKE_MODEL}`,
      cwd: '..',
      url: `http://${FAKE_SERVER_HOST}:${FAKE_SERVER_PORT}/v1/models`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The app under test, served by FastAPI from `web/dist`. Requires
      // `npm run build` to have produced dist (see the static mount in
      // src/api/server.py) — `globalSetup` does that instead of trusting the
      // developer to remember.
      //
      // `uvicorn`'s own command, not the `nojae` console script, and that is the
      // point: this parser carries no boot flag, so the app under test runs on
      // the same defaults an unflagged `nojae` boot answers (debug off, the wait
      // on its pair of defaults) — the suite never needed a flag, and a spec that
      // wants one starts its own server. The endpoint itself arrives through
      // the fixture above, which the test switch below makes the store's rows.
      name: 'nojae',
      command: `python -m uvicorn src.api.server:app --host 127.0.0.1 --port ${PORT}`,
      cwd: '..',
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // Hermetic by default, mirroring tests/conftest.py on the Python side:
      // the endpoints stay live but no connector subprocess and no language
      // server is spawned for a spec that does not ask for one. A spec that
      // wants them starts its own server rather than loosening this globally.
      env: {
        NOJAE_DISABLE_MCP: '1',
        NOJAE_DISABLE_LSP: '1',
        // The switch that puts the server under test in test mode: it never opens
        // the install's `nojae.db`. It creates a temporary store instead and
        // materialises `web/tests/nojae-test-settings.json` into it as rows, so
        // no spec can reach the developer's live server and key. Applied last when
        // the server is spawned, exactly like the two flags above, which is what
        // beats an ambient value inherited from a running app's process tree.
        NOJAE_TEST_SETTINGS: '1',
      },
    },
  ],
  globalSetup: './e2e/global-setup.js',
  globalTeardown: './e2e/global-teardown.js',
})

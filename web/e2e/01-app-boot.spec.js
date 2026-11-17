import { expect, test } from '@playwright/test'

// Task 01 — level: UI state. Nothing here streams: the spec only checks what
// the app tells the user at boot (the store's models, tabs, the app bar's idle
// meters). Therefore every expected string is read from GET /api/config and
// GET /api/workspace instead of being written in the spec, so the spec follows
// the suite's fixture instead of hardcoding it.
test.describe('App boot: displayed configuration, tabs, idle meters', () => {
  // Reads the live config/workspace the assertions below are built from, then
  // opens the app on its default screen. The workspace read names **no** folder:
  // a fresh tab remembers none, and the answer is the installation folder it
  // lands on (spec D4). The app bar then shows that same canonical value.
  async function bootIdle(page) {
    const configRes = await page.request.get('/api/config')
    expect(
      configRes.ok(),
      `GET /api/config should succeed, got ${configRes.status()}`,
    ).toBe(true)
    const config = await configRes.json()

    const workspaceRes = await page.request.get('/api/workspace')
    expect(
      workspaceRes.ok(),
      `GET /api/workspace should succeed, got ${workspaceRes.status()}`,
    ).toBe(true)
    const workspace = await workspaceRes.json()

    await page.goto('/')

    return { config, workspace }
  }

  test('the app bar stays quiet about a configured store', async ({ page }) => {
    const { config } = await bootIdle(page)

    // `GET /api/config` answers per model: the suite's fixture is materialised
    // into the temporary store as one server with one model.
    expect(config.models.length).toBeGreaterThan(0)
    expect(config.models[0].name).toBeTruthy()
    expect(config.models[0].serverName).toBeTruthy()
    // A usable store that holds at least one model has nothing to say in the
    // app bar: which model a turn runs on is the composer's answer (D5, §5.4),
    // and the bar only speaks when the store is unusable or empty.
    await expect(page.locator('.brand-sub')).toHaveCount(0)
  })

  test('two tabs exist, WorkBench selected', async ({ page }) => {
    await bootIdle(page)

    await expect(page.getByRole('tab', { name: 'WorkBench' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByRole('tab', { name: 'Editor' })).toBeVisible()
    expect(await page.getByRole('tab').count()).toBe(2)
  })

  // The working location is *editable* here, not just displayed: the field and
  // its Set button live in the app bar, and the settings dialog has no part in
  // the switch (it has no section for it at all).
  test('app bar shows the tab\'s workspace, and offers to move it', async ({
    page,
  }) => {
    const { workspace } = await bootIdle(page)

    const field = page.locator('.appbar-location-input')
    await expect(field).toHaveValue(workspace.workspace)
    // A fresh tab has no stored folder, so the field is the server's `default`
    // — the installation folder — and nothing is pending to apply.
    await expect(field).toHaveValue(workspace.default)
    await expect(page.locator('.appbar-location-set')).toBeDisabled()

    // The dialog no longer carries that row of its own.
    await page.getByRole('button', { name: 'Open settings' }).click()
    const nav = page.locator('.settings-nav')
    await expect(nav.getByRole('button', { name: /working/i })).toHaveCount(0)
    await page.locator('.settings-dialog').getByRole('button', { name: 'Close' }).click()
  })

  // The clock and the two counters belong to the whole app, which has one
  // session at a time (a WorkBench reply or a batch turn). A fresh tab has no
  // conversation yet, so they read blank; they keep their figures once a turn
  // has been measured, and only Restart clears them (sessionStats.test.js).
  test('app bar carries the shared session meters', async ({ page }) => {
    await bootIdle(page)

    await expect(page.locator('.session-clock')).toHaveText('00:00:00')
    await expect(page.locator('.session-stat-badges .badge')).toHaveText([
      '— t/s',
      '— ctx',
    ])

    // The meters left the composer, so its column now owns the whole composer
    // row: the textarea and its action buttons get the full width.
    await page.getByRole('tab', { name: 'WorkBench' }).click()
    const col = await page.locator('.chat-textarea-col').boundingBox()
    const input = await page.locator('.chat-input').boundingBox()
    expect(
      Math.abs(col.width - input.width),
      'the composer column should fill the input row',
    ).toBeLessThan(1)
  })

  // The counters used to hug their (short) idle text, so a running session
  // widened them and shoved the centred tab strip around. Each now reserves
  // the width of its longest active figure.
  test('idle session counters already fit their active figures', async ({ page }) => {
    await bootIdle(page)

    const measured = await page
      .locator('.session-stat-badges .badge')
      .evaluateAll((badges) =>
        badges.map((badge) => {
          // The widest reading each counter can ever show (estimate marker
          // included), rendered as a clone of the badge itself so font,
          // padding and border are identical.
          const probe = badge.cloneNode(false)
          probe.textContent = badge.classList.contains('badge--rate')
            ? '≈ 123.4 t/s'
            : '≈ ctx 123.4k / 128k'
          badge.parentElement.appendChild(probe)
          const active = probe.getBoundingClientRect().width
          probe.remove()
          return {
            text: badge.textContent.trim(),
            idle: badge.getBoundingClientRect().width,
            active,
          }
        }),
      )

    expect(measured.map((m) => m.text)).toEqual(['— t/s', '— ctx'])
    for (const m of measured) {
      expect(
        m.idle,
        `the idle badge (${m.text}) must already be as wide as "${m.active}px" of active text`,
      ).toBeGreaterThanOrEqual(m.active)
    }
  })
})

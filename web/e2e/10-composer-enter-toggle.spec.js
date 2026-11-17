import { expect, test } from '@playwright/test'

// The composer's Enter-key toggle, in a real browser.
//
// The unit layer (`tests/composerEnterToggle.test.js`) pins the key handler:
// which Enter calls `send`, and which leaves the keydown un-prevented. What it
// cannot answer is the half that *is* the feature — that an un-prevented Enter
// in a textarea actually puts a newline on screen — because jsdom inserts
// nothing. So the newline is measured here, from the textarea's own value.
//
// Hermetic on purpose: `/api/chat` is stubbed, so no spec here waits on a model.
// A send is detected by what the app does locally when the request comes back —
// the draft goes empty and the turn appears in the output column.

const CHAT_OUTPUT = '.chat-output'
const TEXTAREA = '.chat-textarea'
const TOGGLE = '.chat-enter-mode'
const STAGE = '.chat-stage'
// A **sent** turn only: the composer's markdown preview is a `.chat-bubble`
// too, so an unscoped count would be answered by the draft nobody sent.
const USER_TURN = `${CHAT_OUTPUT} .chat-turn .chat-bubble`
const DRAFT = 'first line'

// The stub answers an error, which `startTurn` turns into: the user turn stays,
// the empty assistant turn is dropped, the app is idle again. Enough to tell
// "a send happened" from "nothing happened", with no model in the loop.
async function stubChat(page) {
  const requests = []
  await page.route(/\/api\/chat(?:\?|$)/, (route) => {
    requests.push(route.request().url())
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: '{"detail":"e2e stub"}',
    })
  })
  return requests
}

async function openComposer(page) {
  await page.goto('/')
  await page.getByRole('tab', { name: 'WorkBench' }).click()
  await expect(page.locator(TEXTAREA)).toBeVisible()
}

async function draft(page) {
  await page.locator(TEXTAREA).fill(DRAFT)
}

test('by default Enter sends and Shift+Enter writes a new line', async ({
  page,
}) => {
  const requests = await stubChat(page)
  await openComposer(page)

  // Off, so the button is not pressed and the placeholder says Enter sends.
  const toggle = page.locator(TOGGLE)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator(TEXTAREA)).toHaveAttribute(
    'placeholder',
    /Enter to send/,
  )

  await draft(page)
  await page.keyboard.press('Enter')
  await expect.poll(() => requests.length).toBe(1)
  // The draft left the composer: it became a turn.
  await expect(page.locator(TEXTAREA)).toHaveValue('')
  await expect(page.locator(USER_TURN)).toHaveCount(1)

  // Shift+Enter is the newline, and it sends nothing.
  await draft(page)
  await page.keyboard.press('Shift+Enter')
  await expect(page.locator(TEXTAREA)).toHaveValue(`${DRAFT}\n`)
  expect(requests).toHaveLength(1)
})

test('with the toggle on, Enter writes a new line and Shift+Enter sends', async ({
  page,
}) => {
  const requests = await stubChat(page)
  await openComposer(page)

  await page.locator(TOGGLE).click()
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator(TEXTAREA)).toHaveAttribute(
    'placeholder',
    /Shift\+Enter to send/,
  )

  // Enter is a plain Enter key: the newline lands in the textarea, and the
  // draft is still there to be finished.
  await draft(page)
  await page.keyboard.press('Enter')
  await expect(page.locator(TEXTAREA)).toHaveValue(`${DRAFT}\n`)
  expect(requests).toHaveLength(0)
  await expect(page.locator(USER_TURN)).toHaveCount(0)

  // Shift+Enter is the send now.
  await page.keyboard.press('Shift+Enter')
  await expect.poll(() => requests.length).toBe(1)
  await expect(page.locator(TEXTAREA)).toHaveValue('')
})

test('the row reads toggle, Stage, Send, and the toggle is lit when on', async ({
  page,
}) => {
  await stubChat(page)
  await openComposer(page)

  const toggle = page.locator(TOGGLE)
  const stage = page.locator(STAGE)
  const send = page.locator('.chat-send:not(.chat-stop)')
  await expect(toggle).toBeVisible()
  await expect(stage).toBeVisible()
  await expect(send).toBeVisible()

  // Three rects on one line, left to right in the order the keys reach them:
  // enter/Shift+Enter, then the staging chord, then the sending key. The
  // geometry is measured, not queried by class order, because "immediately
  // left of" is a statement about where the buttons land.
  const toggleBox = await toggle.boundingBox()
  const stageBox = await stage.boundingBox()
  const sendBox = await send.boundingBox()
  expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(stageBox.x + 1)
  expect(stageBox.x + stageBox.width).toBeLessThanOrEqual(sendBox.x + 1)
  expect(Math.round(toggleBox.y)).toBe(Math.round(stageBox.y))
  expect(Math.round(stageBox.y)).toBe(Math.round(sendBox.y))
  expect(Math.round(toggleBox.height)).toBe(Math.round(sendBox.height))
  expect(Math.round(stageBox.height)).toBe(Math.round(sendBox.height))

  // Off at rest, and the "on" state is carried by more than colour: the glyph
  // changes with it.
  const glyph = () => toggle.locator('svg').first().innerHTML()
  const atRest = await glyph()
  await toggle.click()
  expect(await glyph()).not.toBe(atRest)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
})

test('the choice is remembered across a reload', async ({ page }) => {
  await stubChat(page)
  await openComposer(page)

  await page.locator(TOGGLE).click()
  await page.reload()
  await page.getByRole('tab', { name: 'WorkBench' }).click()
  await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true')

  // …and the key follows it: Enter is still a newline, not a send.
  const requests = await stubChat(page)
  await draft(page)
  await page.keyboard.press('Enter')
  await expect(page.locator(TEXTAREA)).toHaveValue(`${DRAFT}\n`)
  expect(requests).toHaveLength(0)
})

import { expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The copy chip on an assistant reply — its *look* and its reach.
//
// The unit layer (`tests/workbenchMessageCopy.test.js`) pins what the chip
// copies and that every reply card carries one; jsdom loads no stylesheet and
// lays out nothing, so the half it cannot answer is the one this spec owns: the
// chip is half-visible at rest, comes up when the pointer enters the card, and
// sits on the card's top-right corner. That is CSS plus geometry, so it is
// decided here.
//
// Hermetic on purpose: the conversation arrives through the composer's own
// "Load session (JSON)" input rather than a streamed reply, so no spec here
// depends on a model answering — the session file is the fixture, and the
// texts in it are exactly the ones the clipboard is compared against.

const CHAT_OUTPUT = '.chat-output'
const REPLY_CARD = '.question-card'
const CHIP = '.chat-msg-copy'

// Two replies, so "copies only this one" is a comparison and not an assumption:
// the conversation's other texts must stay out of what lands on the clipboard.
const FIRST_REPLY = 'The console connector runs one command per call.'
const SECOND_REPLY = 'Fedit writes only through a backup.'
const USER_TURN = 'What are the two connectors?'

async function sessionFile() {
  const body = {
    format: 'nojae-chat-session',
    version: 4,
    messages: [
      { role: 'user', content: USER_TURN },
      { role: 'assistant', content: FIRST_REPLY },
      { role: 'user', content: 'And the editor one?' },
      { role: 'assistant', content: SECOND_REPLY },
    ],
  }
  const dir = await mkdtemp(join(tmpdir(), 'nojae-copy-'))
  const path = join(dir, 'session.json')
  await writeFile(path, JSON.stringify(body), 'utf8')
  return path
}

// The loaded conversation, with the reply cards of the *chat* panel only: the
// Benchmark tab renders `.question-card`s of its own and stays mounted.
async function openConversation(page) {
  await page.goto('/')
  await page.getByRole('tab', { name: 'WorkBench' }).click()
  await page
    .locator('.chat-file-input[accept*="json"]')
    .setInputFiles(await sessionFile())
  const cards = page.locator(`${CHAT_OUTPUT} ${REPLY_CARD}`)
  await expect(cards).toHaveCount(2)
  return cards
}

test('every reply card carries one copy chip on its top-right corner', async ({
  page,
}) => {
  const cards = await openConversation(page)

  for (const card of await cards.all()) {
    const chip = card.locator(CHIP)
    await expect(chip).toHaveCount(1)

    const box = await card.boundingBox()
    const mark = await chip.boundingBox()
    // The corner it marks: straddling the card's right edge and its top edge,
    // half outside and half over the panel (the same punched-corner chip a user
    // turn's avatar and pencil are).
    expect(mark.x + mark.width).toBeGreaterThan(box.x + box.width)
    expect(mark.y).toBeLessThan(box.y)
    // …and only half of it outside, not flung off the card.
    expect(mark.x + mark.width - (box.x + box.width)).toBeLessThan(mark.width)
    expect(box.y - mark.y).toBeLessThan(mark.height)

    // …and it stays clear of the reply: the card's top padding is the band the
    // chip's inner half occupies, so the first line of the answer is never
    // covered by it (the same reason a user bubble gives its chips a line).
    const content = await card.locator('.answer').boundingBox()
    expect(mark.y + mark.height).toBeLessThanOrEqual(content.y)
  }

  // A user bubble keeps its own chips but never a copy one.
  await expect(
    page.locator(`${CHAT_OUTPUT} .chat-bubble ${CHIP}`),
  ).toHaveCount(0)
})

test('the chip is half-visible at rest and comes up under the pointer', async ({
  page,
}) => {
  const cards = await openConversation(page)
  const card = cards.first()
  const chip = card.locator(CHIP)

  // At rest: present and readable, but recessed — neither invisible nor full.
  await expect(chip).toBeAttached()
  const rest = Number(await chip.evaluate((el) => getComputedStyle(el).opacity))
  expect(rest).toBeGreaterThan(0)
  expect(rest).toBeLessThan(1)

  // The pointer anywhere on the card raises it: the affordance must not ask the
  // user to land on a 1.6rem circle to find it.
  await card.locator('.answer').hover()
  await expect
    .poll(() => chip.evaluate((el) => getComputedStyle(el).opacity))
    .toBe('1')
})

test('clicking the chip copies that reply alone', async ({ page, context }) => {
  // Reading the clipboard back is the only way to tell "this reply" from "the
  // whole conversation", which is the distinction the feature is.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const cards = await openConversation(page)

  await cards.last().locator(CHIP).click()
  // The feedback the composer's own copy button uses, on this chip: it says it
  // landed, then goes quiet. Asserted first because it is the time-bound half
  // (the chip reverts after a moment), while the clipboard keeps its content.
  const chip = cards.last().locator(CHIP)
  await expect(chip).toHaveAttribute('aria-label', 'Reply copied')
  await expect(chip).toHaveAttribute('title', 'Copied')

  // Only this reply, never the conversation around it.
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(SECOND_REPLY)
})

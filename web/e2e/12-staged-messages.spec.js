import { expect, test } from '@playwright/test'
import fs from 'node:fs'

// Staged user messages, in a real browser: the composer can hold several user
// messages before any of them reaches the model, and the sending key flushes the
// whole set as **one** turn.
//
// Every case here reads two things the composables own — the body the app posted
// (intercepted, so it can be read without a model) and an element or a state the
// page renders — never a sleep and never the wording of an answer.
//
// Hermetic on purpose. `/api/chat` is answered here, never forwarded: either a
// complete reply, or a turn held open until the case releases it (that is how a
// busy conversation and a Stop/Pause are reached without a timer). `/api/config`
// is re-served with vision on, because the attach button is live only for a model
// declared vision-capable and the suite's own model need not be. Nothing else is
// routed, and nothing is written on the server, so there is nothing to sweep
// afterwards.

// One thing a browser cannot show, and it is worth saying rather than faking: a
// **non-empty strip while a reply streams**. Sending flushes the strip, staging
// is refused in that window and so are the strip's own two verbs, so the state is
// unreachable from the UI — the composable's read-only strip is exercised by the
// unit suite. What this file can assert is the refusal side: work typed into the
// composer during a reply is neither staged nor sent, and is still exactly where
// it was when the turn ends.

const CHAT_OUTPUT = '.chat-output'
const TEXTAREA = '.chat-textarea'
const TOGGLE = '.chat-enter-mode'
const STAGE = '.chat-stage'
const SEND = '.chat-send:not(.chat-stop)'
const STOP = '.chat-stop'
const PAUSE = '.chat-pause'
const LOAD_SESSION = '.chat-file-input[accept*="json"]'
const PICK_IMAGE = '.chat-file-input[accept*="image"]'

// A **sent** turn only: the composer's markdown preview and a strip row are
// `.chat-bubble`/`.answer` too, so an unscoped count would be answered by text
// nobody sent.
const USER_TURN = `${CHAT_OUTPUT} .chat-turn`
const REPLY_CARD = `${CHAT_OUTPUT} .chat-answer-card`
const STRIP_ROW = `${CHAT_OUTPUT} .chat-staged-row`
const STRIP_TEXT = `${STRIP_ROW} .answer`
const PENDING_CHIP = `${CHAT_OUTPUT} .chat-attachment--pending`
// The app's own alert line above the composer — a direct child of the pane, so
// a strip row's refusal sentence (announced on the same class) is not counted.
const ERROR_LINE = `${CHAT_OUTPUT} > .error-line`

const REPLY_TEXT = 'e2e stub reply'
// One complete reply: a token then the finish marker. Delivered whole, so the
// turn ends on the stream's own terms and the case never waits for a model.
const REPLY = [
  `event: token\ndata: ${JSON.stringify({ text: REPLY_TEXT })}\n\n`,
  `event: done\ndata: ${JSON.stringify({ took: 0.2, ttft: 0.1, decode: 0.1 })}\n\n`,
].join('')
// A reply the server cuts short because the user paused it: the terminal frame
// the composer reopens on, keeping the (here empty) partial turn's place in the
// conversation.
const PAUSE_ACK = `event: pause_ack\ndata: ${JSON.stringify({ paused: true })}\n\n`

// A 1×1 PNG. The app never decodes the bytes — it checks the type and the size,
// and carries the data URL — so a real image is the honest fixture and it costs
// one short literal.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

// A chat-template control-token run, assembled from its characters so this file
// never carries a complete one: the server strips such a run from incoming text,
// so a message made of nothing else looks non-empty in the strip and arrives
// empty — the blank user turn a whole request is refused over.
const PIPE = '|'
const controlRun = (name) => `<${PIPE}${name}${PIPE}>`
const BLANK = controlRun('im_start')

// Every `/api/chat` the app makes is answered here. `'reply'` streams a complete
// answer at once; `'hold'` keeps the turn in flight until `release()` is called,
// which is how a conversation is caught busy without a timer.
async function stubChat(page, { mode = 'reply', body = REPLY } = {}) {
  const bodies = []
  let open = null
  let gate = null
  let released = false
  await page.route(
    (url) => url.pathname === '/api/chat',
    async (route) => {
      bodies.push(route.request().postDataJSON())
      if (mode === 'hold') {
        if (!gate) gate = new Promise((resolve) => { open = resolve })
        if (!released) await gate
      }
      try {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body,
        })
      } catch {
        // A Stop aborts the fetch, so there is nobody left to answer.
      }
    },
  )
  return {
    bodies,
    // Let the held turn read its frames: the conversation goes idle again.
    release() {
      released = true
      open?.()
    },
  }
}

// The pause route the app arms before it waits for the stream's own ack.
async function stubPause(page) {
  await page.route(
    (url) => url.pathname === '/api/chat/pause',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ paused: true }),
      }),
  )
}

// The suite's model need not take images, so the catalogue the composer reads is
// re-served with every model declared vision-capable — the attach button's one
// gate. Everything else in the payload is the server's own answer.
async function enableVision(page) {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const body = await (await route.fetch()).json()
      for (const model of body.models ?? []) model.supportsVision = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    },
  )
}

// A store whose every agent has no model: no turn can run, so Send refuses. The
// rest of the payload is the server's, so the selection and the labels are real.
async function refuseAgent(page) {
  await page.route(
    (url) => url.pathname === '/api/agents',
    async (route) => {
      const body = await (await route.fetch()).json()
      body.agents = (body.agents ?? []).map((agent) => ({
        ...agent,
        modelId: null,
        modelName: null,
      }))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
    },
  )
}

async function openComposer(page) {
  await page.goto('/')
  await page.getByRole('tab', { name: 'WorkBench' }).click()
  await expect(page.locator(TEXTAREA)).toBeVisible()
}

// Staging as the user does it: the draft moves to the strip and the composer
// empties. Every caller asserts the strip's contents itself, so a stage that
// landed the wrong text cannot pass as "one more row".
//
// The wait before the chord is the Stage button's own enablement — the
// composable's verdict on whether the verb would accept anything — so a stage
// issued the instant a reply ended is neither raced nor made to sleep.
async function stageDraft(page, text) {
  await page.locator(TEXTAREA).fill(text)
  await expect(page.locator(STAGE)).toBeEnabled()
  await page.keyboard.press('Control+Enter')
  await expect(page.locator(TEXTAREA)).toHaveValue('')
}

// Attach one image through the hidden input the attach button opens, and wait
// for the chip the file reader produces — the list grows asynchronously, so
// counting it immediately after the pick would measure nothing. The button being
// live is the model's own answer (the catalogue was re-served with vision on), so
// it is awaited rather than assumed before the input is driven.
async function attach(page, name) {
  await expect(page.locator('.chat-attach')).toBeEnabled()
  const before = await page.locator(PENDING_CHIP).count()
  await page
    .locator(PICK_IMAGE)
    .setInputFiles({ name, mimeType: 'image/png', buffer: PNG })
  await expect(page.locator(PENDING_CHIP)).toHaveCount(before + 1)
}

// "No request has been made" — polled once, so a request that was issued has
// time to appear, and a case that made none resolves at once.
async function expectNoRequest(chat) {
  await expect
    .poll(() => chat.bodies.length, { timeout: 1000 })
    .toBe(0)
}

const imageParts = (message) =>
  Array.isArray(message?.content)
    ? message.content.filter((part) => part.type === 'image_url')
    : []

// The chord stages and posts nothing; the sending key flushes the whole set in
// exactly one request.
test('the staging chord stages, and the sending key flushes the strip in one request', async ({
  page,
}) => {
  const chat = await stubChat(page)
  await openComposer(page)

  // The chord: the draft moves to the strip and nothing is posted.
  await stageDraft(page, 'first staged thought')
  await expect(page.locator(STRIP_ROW)).toHaveCount(1)
  await expectNoRequest(chat)

  // The Stage button is the same verb, made visible.
  await page.locator(TEXTAREA).fill('second staged thought')
  await page.locator(STAGE).click()
  await expect(page.locator(STRIP_ROW)).toHaveCount(2)
  await expectNoRequest(chat)

  // Cmd is the same chord, so the gesture is not macOS-hostile.
  await page.locator(TEXTAREA).fill('third staged thought')
  await page.keyboard.press('Meta+Enter')
  await expect(page.locator(TEXTAREA)).toHaveValue('')
  await expect(page.locator(STRIP_ROW)).toHaveCount(3)
  await expectNoRequest(chat)
  await expect(page.locator(USER_TURN)).toHaveCount(0)

  // The sending key flushes all three in exactly one request, and the strip is
  // spent: its rows are in the conversation now, not waiting above it.
  await page.locator(SEND).click()
  await expect.poll(() => chat.bodies.length).toBe(1)
  await expect(page.locator(STRIP_ROW)).toHaveCount(0)
  await expect(page.locator(USER_TURN)).toHaveCount(3)
  await expect(page.locator(REPLY_CARD)).toHaveCount(1)
})

// Staging is a keyboard habit of its own: the Enter toggle is about newlines, so
// the chord must mean the same thing under both of its settings — and the
// newline it must not write is only measurable in a browser.
for (const enterSends of [true, false]) {
  const setting = enterSends ? 'Enter sends' : 'Shift+Enter sends'

  test(`Ctrl+Enter stages without sending or writing a newline (${setting})`, async ({
    page,
  }) => {
    const chat = await stubChat(page)
    await openComposer(page)
    if (!enterSends) {
      await page.locator(TOGGLE).click()
    }
    await expect(page.locator(TOGGLE)).toHaveAttribute(
      'aria-pressed',
      enterSends ? 'false' : 'true',
    )

    await page.locator(TEXTAREA).fill('a line that must not gain a newline')
    await page.keyboard.press('Control+Enter')

    // The same three answers under both settings: the text is in the strip, the
    // box it left is exactly empty (the chord prevented its own default, so no
    // newline landed in it), and nothing was sent.
    await expect(page.locator(STRIP_ROW)).toHaveCount(1)
    await expect(page.locator(STRIP_TEXT)).toHaveText([
      'a line that must not gain a newline',
    ])
    await expect(page.locator(TEXTAREA)).toHaveValue('')
    await expect(page.locator(USER_TURN)).toHaveCount(0)
    await expectNoRequest(chat)
  })
}

// A strip of two plus a non-empty draft is three user turns and one reply.
test('a strip of two plus a draft opens one turn of three user messages', async ({
  page,
}) => {
  const chat = await stubChat(page)
  await openComposer(page)

  await stageDraft(page, 'first staged')
  await stageDraft(page, 'second staged')
  await page.locator(TEXTAREA).fill('the draft')

  // The sending key: the draft is one more turn on the end of the strip, not a
  // precondition for it.
  await page.keyboard.press('Enter')
  await expect.poll(() => chat.bodies.length).toBe(1)

  // The thread the user sees is the thread the model got — three user turns in
  // flush order, and one reply that was opened for all of them.
  await expect(page.locator(USER_TURN)).toHaveCount(3)
  await expect(page.locator(REPLY_CARD)).toHaveCount(1)
  expect(chat.bodies[0].messages).toEqual([
    { role: 'user', content: 'first staged' },
    { role: 'user', content: 'second staged' },
    { role: 'user', content: 'the draft' },
  ])
})

// A refused send leaves the draft and the strip untouched.
test('a send refused by an unrunnable agent leaves the draft and the strip untouched', async ({
  page,
}) => {
  const chat = await stubChat(page)
  await refuseAgent(page)
  await openComposer(page)

  await stageDraft(page, 'staged one')
  await stageDraft(page, 'staged two')
  await page.locator(TEXTAREA).fill('the draft')

  await page.keyboard.press('Enter')

  // Nothing moved: the gate is the same one that disables Send and shows the
  // warning, so no request was made, the draft is still in the box and both
  // rows are still staged.
  await expect(page.locator('.chat-mode-warning')).toBeVisible()
  await expect(page.locator(SEND)).toBeDisabled()
  await expect(page.locator(TEXTAREA)).toHaveValue('the draft')
  await expect(page.locator(STRIP_ROW)).toHaveCount(2)
  await expectNoRequest(chat)
})

test('a reply in flight refuses both staging and sending, and moves nothing', async ({
  page,
}) => {
  const chat = await stubChat(page, { mode: 'hold' })
  await openComposer(page)

  await page.locator(TEXTAREA).fill('the opening')
  await page.keyboard.press('Enter')
  await expect.poll(() => chat.bodies.length).toBe(1)
  // Stop is on screen, which is the app's own statement that a turn is in
  // flight — no timer decides this.
  await expect(page.locator(STOP)).toBeVisible()

  // A strip cannot be non-empty while a reply streams — a send flushes it and
  // staging is refused — so the busy window's observable rule is that the work
  // typed now is neither staged nor sent, and stays exactly where it was.
  await page.locator(TEXTAREA).fill('typed while the reply streams')
  await expect(page.locator(STAGE)).toBeDisabled()
  await page.keyboard.press('Control+Enter')
  await expect(page.locator(STRIP_ROW)).toHaveCount(0)
  await expect(page.locator(TEXTAREA)).toHaveValue('typed while the reply streams')

  await page.keyboard.press('Enter')
  await expect(page.locator(TEXTAREA)).toHaveValue('typed while the reply streams')
  expect(chat.bodies).toHaveLength(1)

  chat.release()
  await expect(page.locator(SEND)).toBeVisible()
})

// One message that would be refused blocks the flush, is named, and leaves the
// others staged.
test('one message that would arrive empty blocks the whole flush and is named', async ({
  page,
}) => {
  const chat = await stubChat(page)
  await openComposer(page)

  await stageDraft(page, 'a good brief')
  // Looks like content in the strip; the server's stripping leaves nothing.
  await stageDraft(page, BLANK)
  await stageDraft(page, 'another good brief')
  await expect(page.locator(STRIP_ROW)).toHaveCount(3)

  await page.locator(SEND).click()

  // All-or-nothing: the flush names the row that would be refused and sends
  // none of the three, because a blank user turn is refused as a whole request.
  await expect(page.locator(ERROR_LINE)).toContainText('Nothing was sent')
  await expect(page.locator(ERROR_LINE)).toContainText('message 2')
  await expect(page.locator(STRIP_ROW)).toHaveCount(3)
  await expect(page.locator(STRIP_ROW).nth(1)).toHaveClass(
    /chat-staged-row--refused/,
  )
  await expect(page.locator('.chat-staged-refusal')).toHaveCount(1)
  await expect(page.locator(USER_TURN)).toHaveCount(0)
  await expectNoRequest(chat)
})

// The lifecycle, one gesture per case: Restart wipes the strip, and neither Stop
// nor Pause takes anything the user has staged or typed.
test('Restart clears the strip with the conversation', async ({ page }) => {
  const chat = await stubChat(page)
  await openComposer(page)

  await page.locator(TEXTAREA).fill('a turn already answered')
  await page.keyboard.press('Enter')
  await expect(page.locator(REPLY_CARD)).toHaveCount(1)
  await stageDraft(page, 'staged before the restart')
  await expect(page.locator(STRIP_ROW)).toHaveCount(1)

  // The one gesture that wipes everything takes the strip too: a queue that
  // outlived it would be the only survivor of a thread nobody can see.
  await page.getByRole('button', { name: 'Restart conversation' }).click()
  await expect(page.locator(STRIP_ROW)).toHaveCount(0)
  await expect(page.locator(USER_TURN)).toHaveCount(0)
  await expect(page.locator(REPLY_CARD)).toHaveCount(0)
})

// Stop and Pause end the turn in flight and take nothing the user has written.
// A strip cannot be non-empty while a reply streams — a send flushes it and
// staging is refused then — so the browser's observable half of that rule is the
// work typed during the reply: it is exactly where it was when the turn ends,
// and it stages afterwards onto the thread the ended turn left behind.
test('Stop ends the turn and keeps the work written during it', async ({ page }) => {
  const chat = await stubChat(page, { mode: 'hold' })
  await openComposer(page)

  await page.locator(TEXTAREA).fill('the opening')
  await page.keyboard.press('Enter')
  await expect(page.locator(STOP)).toBeVisible()

  await page.locator(TEXTAREA).fill('a comment written during the reply')
  await page.locator(STOP).click()
  await expect(page.locator(SEND)).toBeVisible()

  // Nothing the user wrote was part of the turn, so nothing went with it.
  await expect(page.locator(TEXTAREA)).toHaveValue('a comment written during the reply')
  // …and it is still stageable, onto the thread Stop left behind. Focus is put
  // back on the composer: the click that stopped the reply took it to a button.
  await page.locator(TEXTAREA).focus()
  await page.keyboard.press('Control+Enter')
  await expect(page.locator(STRIP_ROW)).toHaveCount(1)
  await expect(page.locator(STRIP_TEXT)).toHaveText(['a comment written during the reply'])
  await expect(page.locator(USER_TURN)).toHaveCount(1)
  chat.release()
})

test('Pause ends the reply and keeps the work written during it', async ({ page }) => {
  await stubPause(page)
  const chat = await stubChat(page, { mode: 'hold', body: PAUSE_ACK })
  await openComposer(page)

  await page.locator(TEXTAREA).fill('the opening')
  await page.keyboard.press('Enter')
  await expect(page.locator(STOP)).toBeVisible()

  await page.locator(TEXTAREA).fill('a comment written during the reply')
  await page.locator(PAUSE).click()
  // Armed: the button is inert until the stream's own ack lands.
  await expect(page.locator(PAUSE)).toBeDisabled()
  chat.release()
  await expect(page.locator(SEND)).toBeVisible()

  // The paused reply kept its place in the conversation, and the composer keeps
  // what was typed while it ran: neither the abort nor its ack touched it.
  await expect(page.locator(TEXTAREA)).toHaveValue('a comment written during the reply')
  await expect(page.locator(USER_TURN)).toHaveCount(1)
})

// A staged image survives edit → re-stage → flush, on its own message.
test('a staged image travels through edit and a second flush onto its own message', async ({
  page,
}) => {
  await enableVision(page)
  const chat = await stubChat(page)
  await openComposer(page)

  await attach(page, 'mockup.png')
  await page.locator(TEXTAREA).fill('the message that carries the mockup')
  await page.keyboard.press('Control+Enter')
  await stageDraft(page, 'the message that carries nothing')
  await expect(page.locator(STRIP_ROW)).toHaveCount(2)
  await expect(page.locator('.chat-staged-thumbs .chat-thumb-zoom')).toHaveCount(1)

  await page.locator(SEND).click()
  await expect.poll(() => chat.bodies.length).toBe(1)
  await expect(page.locator(USER_TURN)).toHaveCount(2)
  // The image rode on its own message: one multimodal turn, one plain one.
  expect(imageParts(chat.bodies[0].messages[0])).toHaveLength(1)
  expect(chat.bodies[0].messages[1].content).toBe('the message that carries nothing')

  // Edit-last returns the whole group, and the image with the message it
  // belongs to rather than with the composer.
  await page
    .getByRole('button', { name: 'Edit the last unanswered messages' })
    .click()
  await expect(page.locator(STRIP_ROW)).toHaveCount(2)
  await expect(page.locator(`${STRIP_ROW} .chat-thumb-zoom`)).toHaveCount(1)
  await expect(page.locator(STRIP_ROW).first().locator('.chat-thumb-zoom')).toHaveCount(1)
  await expect(page.locator(USER_TURN)).toHaveCount(0)

  // Re-flushed from the strip alone: the image lands on its own message again.
  await page.locator(SEND).click()
  await expect.poll(() => chat.bodies.length).toBe(2)
  await expect(page.locator(USER_TURN)).toHaveCount(2)
  expect(imageParts(chat.bodies[1].messages[0])).toHaveLength(1)
  expect(imageParts(chat.bodies[1].messages[1])).toHaveLength(0)
  await expect(page.locator(USER_TURN).first().locator('.chat-thumb')).toHaveCount(1)
  await expect(page.locator(USER_TURN).nth(1).locator('.chat-thumb')).toHaveCount(0)
})

// Three images on one message are three image parts, and edit-last returns all
// three.
test('a message with three images sends three image parts and gets all three back', async ({
  page,
}) => {
  await enableVision(page)
  const chat = await stubChat(page)
  await openComposer(page)

  await attach(page, 'one.png')
  await attach(page, 'two.png')
  await attach(page, 'three.png')
  await page.locator(TEXTAREA).fill('three mockups in one message')
  await page.keyboard.press('Control+Enter')
  await expect(page.locator(STRIP_ROW)).toHaveCount(1)
  await expect(page.locator('.chat-staged-thumbs .chat-thumb-zoom')).toHaveCount(3)

  await page.locator(SEND).click()
  await expect.poll(() => chat.bodies.length).toBe(1)
  expect(imageParts(chat.bodies[0].messages[0])).toHaveLength(3)
  await expect(page.locator(USER_TURN).first().locator('.chat-thumb')).toHaveCount(3)

  // The regression this most easily introduces: taking one image back where the
  // gesture used to mean one.
  await page
    .getByRole('button', { name: 'Edit the last unanswered messages' })
    .click()
  await expect(page.locator(STRIP_ROW)).toHaveCount(1)
  await expect(page.locator('.chat-staged-thumbs .chat-thumb-zoom')).toHaveCount(3)
})

// A seventh image in a flush is refused where it is added, naming the budget.
test('a seventh image in one flush is refused as it is added, naming the budget', async ({
  page,
}) => {
  await enableVision(page)
  await openComposer(page)

  for (const name of ['1.png', '2.png', '3.png', '4.png', '5.png', '6.png']) {
    await attach(page, name)
  }
  await expect(page.locator(PENDING_CHIP)).toHaveCount(6)

  // The bound is on the request a flush would make, so it is checked at the
  // moment of attaching and says what the budget is — never discovered at send.
  await page
    .locator(PICK_IMAGE)
    .setInputFiles({ name: '7.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.locator(ERROR_LINE)).toContainText('This image would make 7 images')
  await expect(page.locator(ERROR_LINE)).toContainText('at most 6 fit in one turn')
  await expect(page.locator(PENDING_CHIP)).toHaveCount(6)
})

// The group gesture returns every unanswered user turn, in order, out of the
// thread, and its affordance sits where the group begins.
test('edit-last takes a three-message group, from its first message', async ({
  page,
}) => {
  const chat = await stubChat(page)
  await openComposer(page)

  await stageDraft(page, 'one')
  await stageDraft(page, 'two')
  await page.locator(TEXTAREA).fill('three')
  await page.keyboard.press('Enter')
  await expect.poll(() => chat.bodies.length).toBe(1)
  await expect(page.locator(USER_TURN)).toHaveCount(3)
  await expect(page.locator(REPLY_CARD)).toHaveCount(1)

  // The affordance sits where the group begins — on its first message, and
  // nowhere else — so the gesture is discoverable at the start of the run.
  const edit = page.getByRole('button', { name: 'Edit the last unanswered messages' })
  await expect(edit).toHaveCount(1)
  await expect(page.locator(USER_TURN).first().locator('.chat-turn-edit')).toHaveCount(1)

  await edit.click()

  // All three back into the strip, in flush order, and all three out of the
  // thread: the group is what was unanswered, not one message of it.
  await expect(page.locator(STRIP_ROW)).toHaveCount(3)
  await expect(page.locator(STRIP_TEXT)).toHaveText(['one', 'two', 'three'])
  await expect(page.locator(USER_TURN)).toHaveCount(0)
  await expect(page.locator(REPLY_CARD)).toHaveCount(0)
})

// The session round trip: the file holds the multi-message turn, the strip never
// enters it, and loading brings the same turns back.
test('a saved session of a multi-message turn reloads as the same turns', async ({
  page,
}) => {
  const chat = await stubChat(page)
  await openComposer(page)

  await stageDraft(page, 'first of the set')
  await stageDraft(page, 'second of the set')
  await page.locator(TEXTAREA).fill('third of the set')
  await page.keyboard.press('Enter')
  await expect.poll(() => chat.bodies.length).toBe(1)
  await expect(page.locator(USER_TURN)).toHaveCount(3)

  // A message staged now is the control: the file holds the thread alone, so a
  // staged row travels in neither direction.
  await stageDraft(page, 'staged and never sent')

  const started = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save session as JSON' }).click()
  const path = await (await started).path()
  const file = JSON.parse(fs.readFileSync(path, 'utf8'))
  expect(file.messages.map((message) => message.role)).toEqual([
    'user',
    'user',
    'user',
    'assistant',
  ])
  expect(file.messages.slice(0, 3).map((message) => message.content)).toEqual([
    'first of the set',
    'second of the set',
    'third of the set',
  ])
  expect(JSON.stringify(file)).not.toContain('staged and never sent')

  // The round trip through the loader: the same turns come back, and the strip
  // belongs to the conversation this file replaced.
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator(LOAD_SESSION).setInputFiles(path)
  await expect(page.locator(USER_TURN)).toHaveCount(3)
  await expect(page.locator(`${USER_TURN} .answer`).first()).toHaveText('first of the set')
  await expect(page.locator(REPLY_CARD)).toHaveCount(1)
  await expect(page.locator(STRIP_ROW)).toHaveCount(0)
})

// Batch mode builds its own request and never reads the strip, so a non-empty
// strip leaves the dialog's own rules — and its dismissal — untouched.
test('a non-empty strip neither joins nor blocks a batch launch', async ({
  page,
}) => {
  await stubChat(page)
  await openComposer(page)

  await stageDraft(page, 'staged before the lot')

  // The dialog opens on its own rules, which never read the strip, and
  // dismissing it leaves the strip exactly as it was. No lot is started.
  await page.getByRole('button', { name: 'Batch mode' }).click()
  const dialog = page.locator('.batch-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator(STRIP_ROW)).toHaveCount(1)
  await expect(page.locator(STRIP_TEXT)).toHaveText(['staged before the lot'])
})

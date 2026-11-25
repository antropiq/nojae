import { reactive } from 'vue'

// The WorkBench bullet row's store: the prompt helpers behind the coloured
// bullets above the composer, which live in ``nojae.db`` and are therefore **the
// same in every workspace**. A row is a bullet, so there is no slot count to
// mirror, and the character cap arrives in the read's ``caps``.
//
// The one colour named here is the client's own drawing rule: an *empty* bullet
// is drawn gray whatever colour its row carries. The colour a **new** bullet
// starts with is the store's, from ``caps.defaultColor``.

export const PROMPT_HELPER_EMPTY_COLOR = '#808080'

const state = reactive({
  // ``[{ id, color, content }]`` straight from ``GET /api/prompt-helpers``, in
  // the store's insertion order. Empty until the first load: the bullets a fresh
  // install shows were seeded into the store, so they are never invented here.
  slots: [],
  // ``{ contentMaxChars, defaultColor }`` from the same read — the numbers and
  // the starting colour the form enforces, so none of them is spelled in the
  // client.
  caps: null,
  loaded: false,
  saving: false,
  error: null,
})

function describeError(body, fallback) {
  const detail = body?.detail
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      const field = Array.isArray(item?.loc)
        ? item.loc.filter((part) => part !== 'body').join('.')
        : ''
      return field ? `${field}: ${item?.msg ?? 'invalid'}` : item?.msg ?? 'invalid'
    })
    if (messages.length) return messages.join(' · ')
  }
  return fallback
}

// -- the decisions the bullet row and the dialog render -------------------------

// The number a bullet is drawn with: its **position**, not its id. The id is what
// the writes address a row by and never changes; the position is what the user
// sees, and it moves when a bullet before it is deleted.
export function bulletNumber(index) {
  return index + 1
}

export function bulletAt(index) {
  return state.slots[index] ?? null
}

// An empty bullet is always drawn default gray; the stored colour is kept but
// ignored until content comes back.
export function isFilled(slot) {
  return !!slot && slot.content !== ''
}

export function bulletColor(slot) {
  return isFilled(slot) ? slot.color : PROMPT_HELPER_EMPTY_COLOR
}

// The colour a **new** bullet starts with: the store's default, falling back to
// the client's gray only in the moment before the first read has answered.
export function newBulletColor() {
  return state.caps?.defaultColor ?? PROMPT_HELPER_EMPTY_COLOR
}

// The cap, as a sentence — or ``null`` when the content fits, or before a read
// has answered (the server then refuses in the same words).
export function capViolation(content) {
  const cap = state.caps?.contentMaxChars
  if (!Number.isFinite(cap) || content.length <= cap) return null
  return `Content exceeds the ${cap} character cap.`
}

// -- the routes ----------------------------------------------------------------

async function post(url, body, fallback) {
  state.error = null
  state.saving = true
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok) {
      state.error = describeError(payload, `${fallback} (${res.status}).`)
      return null
    }
    if (Array.isArray(payload?.slots)) {
      state.slots = payload.slots
      state.loaded = true
    }
    return state.slots
  } catch (exc) {
    state.error = `Could not reach the API: ${exc}`
    return null
  } finally {
    state.saving = false
  }
}

export function usePromptHelpers() {
  async function loadPromptHelpers() {
    try {
      const res = await fetch('/api/prompt-helpers')
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.error = describeError(body, `Could not load memory bullets (${res.status}).`)
        return
      }
      // Whatever count the store holds is the count, **including zero**: a user
      // who deleted every bullet has an empty row, not nine invented slots.
      if (Array.isArray(body?.slots)) {
        state.slots = body.slots
      }
      if (body?.caps) {
        state.caps = body.caps
      }
      state.loaded = true
    } catch (exc) {
      state.error = `Could not reach the API: ${exc}`
    }
  }

  // Persists one bullet by its id. Returns the new list, or ``null`` with
  // ``state.error`` set, so the dialog can stay open and show it.
  async function savePromptHelper(id, color, content) {
    if (state.saving) return null
    const violation = capViolation(content)
    if (violation) {
      state.error = violation
      return null
    }
    return post('/api/prompt-helpers/save', { id, color, content }, 'Could not save memory bullet')
  }

  // Appends one bullet. There is no free slot to fill, so the new row's id
  // arrives in the list the response carries.
  async function addPromptHelper(color, content) {
    if (state.saving) return null
    const violation = capViolation(content)
    if (violation) {
      state.error = violation
      return null
    }
    return post('/api/prompt-helpers/add', { color, content }, 'Could not add memory bullet')
  }

  // Removes one bullet. The store keeps a copy of the whole database before the
  // row goes, so the dialog's confirmation is the only guard the user needs.
  async function deletePromptHelper(id) {
    if (state.saving) return null
    return post('/api/prompt-helpers/delete', { id }, 'Could not delete memory bullet')
  }

  return {
    state,
    loadPromptHelpers,
    savePromptHelper,
    addPromptHelper,
    deletePromptHelper,
  }
}

// Put text on the system clipboard, answering whether it landed.
//
// The async Clipboard API is the route; the hidden-textarea `execCommand`
// fallback stays for a non-secure context (plain http on a LAN host), where
// `navigator.clipboard` is absent or refuses. Every copy surface in the app
// goes through here so the two of them (the composer's "Copy conversation"
// and a message's copy chip) cannot drift apart on the fallback.

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    document.body.removeChild(area)
    return ok
  }
}

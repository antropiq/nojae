"""The WorkBench prompt helpers: the bullets above the composer, as store rows.

The settings store's ``prompt_helpers`` table holds the text behind the coloured
bullets — one row a colour and a prompt the user reaches for often. This module is the
whole read and write side of that table **as the rest of the app speaks it**: the
constants the routes validate against, and the four calls a route wraps. It
writes no SQL and opens no file — :mod:`src.core.appdb` owns the store and is the
only module that speaks SQL (spec §4.1) — and it talks to no route, no model and
no browser.

There is **no count rule** (§4.5). The file this replaces held exactly nine slots
and answered anything else as an error, because the app was that file's only
writer and a wrong count meant corruption. In a table a row is a bullet: adding
and deleting are the normal operations, the count is simply the count, and the
"exactly nine" check and its error type are deleted rather than relaxed. What a
**created** store starts with — nine empty gray rows, so a first boot looks
exactly as it did — is the seeder's business (§4.3), not this module's.

The rows are install-scoped, like the rest of the store: a bullet is a habit of
the user rather than of one tree, so a working-location switch changes nothing
here (D11). The per-workspace file, its seeder, its state reader and the one-time
lift from the even older app-level file are all gone with it.
"""

import re
from typing import Any, Dict, List, Optional

from src.core import appdb

# -- the constants (module attributes, patchable) -------------------------------

#: The colour an unfilled bullet is drawn in. The store's seeder names the same
#: value for its own reason — it must not import the module that reads its rows —
#: so ``tests/test_appdb_seed.py`` pins the two together: a store seeded in one
#: colour while the bullet row falls back to another is a drift nobody notices
#: until a user does.
DEFAULT_COLOR = "#808080"

#: The cap on one bullet's text. It travels to the browser in the read's payload
#: (``caps``), so no cap is spelled in the client.
CONTENT_MAX_CHARS = 32000

#: What counts as a colour: a 6-digit hex triplet. The request model refuses
#: anything else with a message naming the field, because "a database column does
#: not make a bad value less bad" (§4.5): the store never holds a colour CSS
#: would reject, and no reader has to defend against one.
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

#: The one failure every call here can raise: the store could not be opened,
#: read or written, and the sentence names its path. An **alias**, not a second
#: type — :mod:`src.core.appdb` raises it, and a route that caught something
#: else would be catching a type this module cannot produce.
AppStoreError = appdb.AppStoreError


# -- the read and write sides --------------------------------------------------

def load_prompt_helpers() -> List[Dict[str, Any]]:
    """Every bullet the store holds, in insertion order.

    ``[{id, color, content}]``, at **any** count — including zero, which is the
    answer for a user who deleted every bullet and stands (§4.5). The ``id`` is
    what the writes below address a bullet by: once the count is the user's
    business there is no slot index to use.

    Raises :data:`AppStoreError` naming the path when the store cannot be read.
    An unusable store is a named state, never nine empty bullets — the same rule
    the file reader held for the file it replaces.
    """
    return appdb.load_prompt_helpers()


def payload() -> Dict[str, Any]:
    """The read's whole answer: the bullets, and the caps that bound them.

    ``{"slots": [...], "caps": {"contentMaxChars": int, "defaultColor": str}}``.
    The caps ride with the rows so the dialog enforces the server's numbers
    rather than a mirrored copy of them — the client has never been allowed to
    know a count, and it does not learn one here either.
    """
    return {
        "slots": load_prompt_helpers(),
        "caps": {
            "contentMaxChars": CONTENT_MAX_CHARS,
            "defaultColor": DEFAULT_COLOR,
        },
    }


def add_prompt_helper(color: str, content: str = "") -> List[Dict[str, Any]]:
    """Append one bullet and answer the whole list.

    An append, always: there is no free slot to fill and no index to aim at, so
    "add" means a new row and the new row's ``id`` is the store's to assign.
    """
    return appdb.add_prompt_helper(color, content)


def save_prompt_helper(
    helper_id: int, color: str, content: str
) -> Optional[List[Dict[str, Any]]]:
    """Rewrite one bullet; answers the whole list, or ``None`` for no such row.

    Saving empty ``content`` clears the bullet and keeps its colour, as it did
    with the file. ``None`` means the id named no row — the browser was holding
    an older list — which the route answers with the list it now has rather than
    by pretending a write landed.
    """
    return appdb.update_prompt_helper(helper_id, color, content)


def delete_prompt_helper(
    helper_id: int,
) -> Optional[List[Dict[str, Any]]]:
    """Remove one bullet, after D12's copy of the whole store.

    The copy is the store's own rule, kept in :mod:`src.core.appdb` so every
    destructive write of the database shares one helper, one folder and one
    retention sweep; this function only says that a bullet delete is one of them.

    ``None`` for an id that names no row, and then nothing was destroyed and no
    copy was taken.
    """
    return appdb.delete_prompt_helper(helper_id)

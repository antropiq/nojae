"""``prompt_helpers``: the memory bullets under the composer, read and written.

The smallest domain in the store: one read, three writes, and no vocabulary of
its own beyond the column list :mod:`appdb.rows` already holds. Everything it
shares — the read and write seams, the row builders, the pre-delete copy — is
read off the façade at call time, so a patch of ``appdb.PROJECT_ROOT`` moves what
these accessors answer. The wrapper the routes call is ``src.core.prompt_helpers``,
which validates the browser's payload and reaches these four by name; no file
here imports it.
"""

from typing import Any, Dict, List, Optional

import src.core.appdb as appdb

# -- the prompt-helper rows ------------------------------------------------------

def load_prompt_helpers() -> List[Dict[str, Any]]:
    """Every helper row, in insertion order.

    ``[{id, color, content}]``. There is **no count rule**: a row is a bullet and
    the count is simply the count, so a user who deleted every one of them has no
    rows and the bullet row renders nothing. The old "exactly nine or an error"
    existed because the app was one file's only writer and a wrong count meant
    corruption; in a table, adding and deleting are the normal operations.

    The ``id`` is in the answer because the writes below address a bullet by it —
    "update one" and "delete" have no slot index once the count is the user's
    business.

    Raises :class:`AppStoreError` like :func:`load_servers`: an unusable store
    is a named state, never nine empty bullets.
    """
    return [
        appdb._record(
            appdb._PROMPT_HELPER_COLUMNS, found, appdb._PROMPT_HELPER_JSON
        )
        for found in appdb._read(
            appdb._select("prompt_helpers", appdb._PROMPT_HELPER_COLUMNS, order="id")
        )
    ]


def add_prompt_helper(color: str, content: str = "") -> List[Dict[str, Any]]:
    """Append one bullet and answer the whole list as the browser renders it.

    An **append**, always: the row count is the user's business, so there is no
    slot to aim at and no free slot to fill. The new row's ``id`` is the one
    SQLite assigns, which is why the answer is the read rather than the values
    passed in.
    """
    appdb._write(
        "INSERT INTO prompt_helpers (color_code, content) VALUES (?, ?)",
        (color, content),
    )
    return appdb.load_prompt_helpers()


def update_prompt_helper(
    helper_id: int, color: str, content: str
) -> Optional[List[Dict[str, Any]]]:
    """Rewrite one bullet's colour and text; answers the whole list.

    ``None`` when no row carries that id — the id is the handle the read hands
    out, so a row that is not there means the browser was looking at an older
    list, and the caller answers with the list it now has.
    """
    changed = appdb._write(
        "UPDATE prompt_helpers SET color_code = ?, content = ? WHERE id = ?",
        (color, content, helper_id),
    )
    return appdb.load_prompt_helpers() if changed else None


def delete_prompt_helper(helper_id: int) -> Optional[List[Dict[str, Any]]]:
    """Remove one bullet, keeping a copy of the store first.

    Answers the whole list, or ``None`` when no row carried that id. The copy is
    taken **before** the ``DELETE`` and only for a row that exists: an UPDATE
    needs none, because the row it replaces is a field the user can retype, and a
    delete that deletes nothing destroys nothing.
    """
    found = appdb._read(
        appdb._select("prompt_helpers", appdb._PROMPT_HELPER_COLUMNS, "id = ?"),
        (helper_id,),
    )
    if not found:
        return None
    appdb.backup_before_delete()
    appdb._write("DELETE FROM prompt_helpers WHERE id = ?", (helper_id,))
    return appdb.load_prompt_helpers()

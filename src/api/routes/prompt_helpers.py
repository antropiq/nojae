"""The prompt-helper bullets of the settings store: one reader, three writes."""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException

from src.core import prompt_helpers

from src.api.routes.inputs import (
    PromptHelperCreateIn,
    PromptHelperDeleteIn,
    PromptHelperUpdateIn,
)

router = APIRouter()


def _helper_write(
    slots: Optional[List[Dict[str, Any]]], what: str, helper_id: Optional[int]
) -> Dict[str, Any]:
    """One addressed prompt-helper write's answer, mapped to its status.

    ``None`` from the store means the id named no row — the browser was
    working from a list that has since changed — so it is a 404 naming it,
    never a list that says nothing happened. A list is the new truth and is
    returned whole, so the caller re-baselines rather than splicing.

    An unusable store is a 422 carrying the sentence that names its path
    (never a 500); each route catches that one type around its own call.
    """
    if slots is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"no prompt helper with id {helper_id} — it cannot be {what}; "
                "reload the bullets."
            ),
        )
    return {"slots": slots}


@router.get("/prompt-helpers")
def get_prompt_helpers() -> Dict[str, Any]:
    """Every prompt-helper bullet the store holds, at whatever count.

    ``{"slots": [{id, color, content}…], "caps": {...}}``. There is **no
    count rule**: the read answers zero rows for a user who deleted every
    bullet. The ``caps`` are the numbers the dialog enforces, so none is
    spelled in the client.

    An unusable store is a 422 naming its path, never an empty list: the
    silent empty answer is the state this app refuses everywhere.

    This answers *about* the store; it is not a way to read it — no
    ``?path=``, no SQL and no file. The store is itself invisible to
    ``/api/fs/*`` and to both connectors.
    """
    try:
        return prompt_helpers.payload()
    except prompt_helpers.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/prompt-helpers/add")
def post_prompt_helpers_add(body: PromptHelperCreateIn) -> Dict[str, Any]:
    """Append one bullet and return the whole list.

    An **add**, not a fill: with no count rule there is no free slot to aim
    at, so the new row's id comes back in the list the response carries.
    A bad colour or oversized content is a 422 naming the field.

    Not gated on a reply streaming: a turn resolves its connection once, at
    its start, so a bullet saved mid-turn cannot change what that turn says
    (the same for the two writes below).
    """
    try:
        return {"slots": prompt_helpers.add_prompt_helper(
            body.color, body.content
        )}
    except prompt_helpers.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/prompt-helpers/save")
def post_prompt_helpers_save(body: PromptHelperUpdateIn) -> Dict[str, Any]:
    """Rewrite one bullet and return the whole list.

    Addressed by ``id`` — the handle the read hands out — because a slot
    index stopped meaning anything the moment the count became the user's.
    Empty ``content`` clears the bullet and keeps its colour.
    """
    try:
        slots = prompt_helpers.save_prompt_helper(
            body.id, body.color, body.content
        )
    except prompt_helpers.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _helper_write(slots, "saved", body.id)


@router.post("/prompt-helpers/delete")
def post_prompt_helpers_delete(body: PromptHelperDeleteIn) -> Dict[str, Any]:
    """Remove one bullet and return what is left.

    The destructive write of the three, so the whole settings store lands in
    the app's dated backup folder before the row goes, through the same
    helper every file replacement already uses. An id that names no row is a
    404, and then nothing was destroyed and no copy was taken.
    """
    try:
        slots = prompt_helpers.delete_prompt_helper(body.id)
    except prompt_helpers.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _helper_write(slots, "deleted", body.id)

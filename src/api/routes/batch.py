"""The two reads of a task lot: its numbered files, and its prefixes."""

from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request

from src.core import batch as batch_core

from src.api.routes.seam import require_workspace

router = APIRouter()


@router.get("/batch/tasks")
def get_batch_tasks(
    request: Request, prefix: str = "", dir: str = ""
) -> Dict[str, Any]:
    """List the numbered task lot of ``prefix`` in **this request's** ``dir``.

    Names, sizes, the first heading and the big-picture body — never a task
    body: the model opens its task file with the connectors, which is why
    there is no file-read route here. All the rules live in ``core/batch.py``;
    this route only turns a :class:`core.batch.BatchListingError` into its
    HTTP status.

    **The lot is the folder the request names**: ``dir`` stays relative,
    exactly as it is, because the folder travels in the field and never in
    the path. The field is asked for *first*, so a folder that was named and
    refused is a 422 carrying the seam's sentence rather than a listing of
    some other folder.
    """
    require_workspace(request)
    try:
        return batch_core.task_lot(prefix, dir)
    except batch_core.BatchListingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.get("/batch/prefixes")
def get_batch_prefixes(request: Request, dir: str = "") -> Dict[str, Any]:
    """Every task prefix available in **this request's** workspace's ``dir``.

    The batch dialog's dropdown: it lists the lots the folder actually
    holds, so a prefix is chosen rather than typed. One ``scandir`` of the
    same folder the task listing reads, with its same locks and its same
    "is a lot file" rule -- so a prefix is offered exactly when listing it
    would return a non-empty lot. Names only, no file content.

    Same field, same refusal: two tabs on two folders are offered two
    different dropdowns.
    """
    require_workspace(request)
    try:
        return batch_core.task_prefixes(dir)
    except batch_core.BatchListingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)

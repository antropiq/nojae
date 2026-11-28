# Bugs

## rwk-03: the "exactly one `Query(`" check is not true of the surface it describes

The task's done-list asks for `git grep -n "Query(" src/api/routes` to return exactly
one hit. It returns two, and it returned two for `src/api/routes.py` before the split:
besides the seam's `Query(default=None, alias=WORKSPACE_QUERY, …)`, the Editor's
`GET /api/fs/stat` takes `path: List[str] = Query(default_factory=list)`.

The real invariant — that the **workspace field** is declared once — is what
`tests/test_workspace_seam.py::test_the_query_name_is_spelled_once_in_the_api` asserts
(read as an AST on `alias=WORKSPACE_QUERY`), and it passes. Not fixed here: this is a
wording slip in the task's check, not a change of the app's surface.

## rwk-05: the "names only `fs.py`" check is not true of the surface it describes

The task's done-list asks for

```
grep -rln "write_file\|create_path\|rename_path\|move_paths_batch\|trash_path" src/api/routes
```

to name only `fs.py`. It names `fs.py` **and** `inputs.py`, and it has done so since
task 03 moved the request models: `FileSaveIn`'s own docstring says
``editorfs.write_file`` owns the size cap. That sentence is a *read* of the write
core's name, not a call to it, and it travels verbatim with the model.

The two standing caller guards already record both files
(`tests/test_write_surface_isolation.py::test_the_write_core_is_called_from_the_routes_and_nowhere_else`
and its twin in `tests/test_editorfs_write.py`), and task 03's own text listed them as
the pair. This task narrows the route entry from `routes/__init__.py` to `routes/fs.py`
and leaves `inputs.py` there, which is what the guards assert and what passes. Not
fixed here: the check's wording, not the app's surface.

## rwk-06: the "only `hubs.py` and `workspace.py`" check omits a helper name

The task's done-list asks for

```
grep -rn "_hub_pool\|_acquire_hub_set\|_read_hub_set\|_mcp_payload\|_lsp_payload" src/api/routes
```

to name only `hubs.py` and `workspace.py`. It also names `__init__.py`, and it has to
while the chat route is still there: `POST /api/chat` admits the turn's hub set with
`_acquire_hub_set_async`, the one helper the pattern above does not list (its
`_acquire_hub_set` alternative matches it only as a substring of the definition, never
at the chat call site). Task 08 moves that call site to `chat.py` and the check reads
true from there on.

The alternative would be to give `__init__.py` a second copy of the helper, which the
task forbids ("Do not duplicate a helper to avoid it"), or to move the chat route early,
which is task 08's perimeter. Not fixed here: the check's wording, not the app's
surface.

## rwk-08: the hub-helper check names `chat.py`, and that is the honest answer

Task 06's note above expected this check to read true once the chat route moved. It
does not: `grep -rln "_hub_pool|_acquire_hub_set|_read_hub_set|_mcp_payload|_lsp_payload" src/api/routes`
now names `hubs.py`, `workspace.py` **and** `chat.py`, because `POST /api/chat` admits
the turn's hub set with `_acquire_hub_set_async` — its import and its bare call site,
both of which the pattern matches. That is the shape the lot asks for (the helper lives
in `hubs.py` alone, is imported by name and called bare), so the third file is not a
leak and no helper was copied. Not fixed here: the check's wording, not the app's
surface.

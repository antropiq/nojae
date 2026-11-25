"""Document sync and the LSP requests behind each tool action.

didOpen/didChange bookkeeping, then one request per catalogue action, its
result handed to ``rendering`` for the text the model sees. They keep no state
of their own; the manager owns the policy check that produced ``path`` and the
loop the timeouts run on.

The document's text may come from the caller instead of the disk: the Editor's
buffer is routinely dirtier than the file, and a question about what is on
screen must be answered against what is on screen. ``None`` means "read the
file"; a given text is synced as a full-text change and never written back.
"""

import asyncio
from pathlib import Path
from typing import Any, Dict, NamedTuple, Optional

from . import constants, rendering
from .constants import DEFAULT_MAX_DIAGNOSTICS, DIAGNOSTICS_WAIT_SECONDS, REQUEST_TIMEOUT
from .session import ServerSession


class DocumentSync(NamedTuple):
    """What one :func:`sync_document` did.

    ``uri`` and ``version`` are the document as the server now holds it.
    ``text_version`` is the version the text the server holds was *sent* at —
    ``version`` when this sync changed the text, an older number when it did
    not.

    That second number is what ``editor.diagnostics_answer`` needs: an analysis
    published for a version below it describes text nobody is looking at any
    more, so it is not a verdict — while an unchanged re-ask keeps accepting
    the payload already in the inbox, which describes exactly what is open.
    """

    uri: str
    version: int
    #: The version the text now on the server was sent at: equal to ``version``
    #: when this sync changed the text, lower when it was already held.
    text_version: int


async def sync_document(
    session: ServerSession, path: Path, text: Optional[str] = None
) -> DocumentSync:
    """didOpen/didChange the document, answer what was sent.

    ``text`` is the caller's own content — the Editor's buffer — and ``None``
    means "read the file". An empty string is a legitimate buffer, so the test
    is ``is None``, never truthiness. A given text is capped here rather than
    upstream: it is not on disk, so the manager's ``stat`` never saw it.
    """
    from lsprotocol import types as lsp
    from pygls import uris as lsp_uris

    uri = lsp_uris.from_fs_path(str(path)) or "file://" + str(path)
    if text is None:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise RuntimeError(f"could not read {path}: {exc}") from exc
    elif len(text.encode("utf-8")) > constants.MAX_DOCUMENT_BYTES:
        raise RuntimeError(
            f"buffer exceeds the {constants.MAX_DOCUMENT_BYTES} byte cap"
        )
    store = session.documents
    language_id = session.info.get("languageId") or rendering.language_id_for_suffix(
        path.suffix
    )
    version = store.next_version(uri)
    first_open = store.version(uri) is None
    if first_open:
        store.add(uri, version, text, language_id)
        session.client.text_document_did_open(
            lsp.DidOpenTextDocumentParams(
                text_document=lsp.TextDocumentItem(
                    uri=uri,
                    language_id=language_id or "plaintext",
                    version=version,
                    text=text,
                )
            )
        )
    else:
        store.update(uri, version, text)
        session.client.text_document_did_change(
            lsp.DidChangeTextDocumentParams(
                text_document=lsp.VersionedTextDocumentIdentifier(
                    uri=uri, version=version
                ),
                content_changes=[
                    lsp.TextDocumentContentChangeWholeDocument(text=text)
                ],
            )
        )
    # The version the text *now on the server* was sent at, which a caller
    # compares an inbox payload's version against to tell "an analysis of this
    # text" from "an analysis of text this sync replaced".
    text_version = store.text_version(uri)
    assert text_version is not None  # just written above
    return DocumentSync(uri=uri, version=version, text_version=text_version)


def position(arguments: Dict[str, Any]) -> Any:
    from lsprotocol import types as lsp

    line = arguments.get("line")
    character = arguments.get("character")
    if not isinstance(line, int) or not isinstance(character, int) or line < 0:
        raise RuntimeError(
            "line and character must be non-negative integers (0-based, as "
            "reported by lsp_*_diagnostics)"
        )
    return lsp.Position(line=line, character=max(int(character), 0))


async def fetch_diagnostics(session: ServerSession, root: Path, uri: str) -> str:
    """Pull diagnostics when the server advertises 3.17 pull support, else
    wait for the publishDiagnostics push on the inbox."""
    from lsprotocol import types as lsp

    limit = session.info.get("maxDiagnostics") or DEFAULT_MAX_DIAGNOSTICS
    if session.pull_diagnostics:
        report = await asyncio.wait_for(
            session.client.text_document_diagnostic_async(
                lsp.DocumentDiagnosticParams(
                    text_document=lsp.TextDocumentIdentifier(uri=uri)
                )
            ),
            timeout=REQUEST_TIMEOUT,
        )
        items = list(getattr(report, "items", None) or [])
        related = getattr(report, "related_documents", None) or {}
        for related_report in related.values():
            items.extend(getattr(related_report, "items", None) or [])
        return rendering.truncate(rendering.render_diagnostics(root, items, limit, uri))
    version = session.documents.version(uri)
    pushed = await session.inbox.wait(uri, version, DIAGNOSTICS_WAIT_SECONDS)
    if pushed is None:
        # An empty answer would be a lie: the server may still be indexing.
        return (
            "No diagnostics published by the server within "
            f"{DIAGNOSTICS_WAIT_SECONDS:.0f}s — the file may be clean, or "
            "the server is still indexing; call this tool again if in doubt."
        )
    return rendering.truncate(rendering.render_diagnostics(root, pushed, limit, uri))


async def workspace_symbols(session: ServerSession, arguments: Dict[str, Any]) -> str:
    """The one action that needs no document: a whole-workspace symbol query."""
    from lsprotocol import types as lsp

    query = arguments.get("query")
    if not isinstance(query, str) or not query.strip():
        return "Error: query is required"
    result = await asyncio.wait_for(
        session.client.workspace_symbol_async(lsp.WorkspaceSymbolParams(query=query)),
        timeout=REQUEST_TIMEOUT,
    )
    symbols = result if isinstance(result, list) else getattr(result, "items", None)
    root = Path(session.info["workspaceRoot"]).resolve()
    return rendering.truncate(rendering.render_symbols(root, symbols or []))


async def run_action(
    session: ServerSession, action: str, arguments: Dict[str, Any], path: Path
) -> str:
    """One catalogue action against an already policy-checked file."""
    from lsprotocol import types as lsp

    root = Path(session.info["workspaceRoot"]).resolve()
    uri = (await sync_document(session, path)).uri
    document = lsp.TextDocumentIdentifier(uri=uri)

    if action == "diagnostics":
        return await fetch_diagnostics(session, root, uri)
    if action == "hover":
        result = await asyncio.wait_for(
            session.client.text_document_hover_async(
                lsp.HoverParams(text_document=document, position=position(arguments))
            ),
            timeout=REQUEST_TIMEOUT,
        )
        return rendering.truncate(rendering.render_hover(result))
    if action == "definition":
        result = await asyncio.wait_for(
            session.client.text_document_definition_async(
                lsp.DefinitionParams(text_document=document, position=position(arguments))
            ),
            timeout=REQUEST_TIMEOUT,
        )
        return rendering.truncate(rendering.render_locations(root, result))
    if action == "references":
        result = await asyncio.wait_for(
            session.client.text_document_references_async(
                lsp.ReferenceParams(
                    text_document=document,
                    position=position(arguments),
                    context=lsp.ReferenceContext(
                        include_declaration=bool(arguments.get("includeDeclaration", True))
                    ),
                )
            ),
            timeout=REQUEST_TIMEOUT,
        )
        return rendering.truncate(rendering.render_locations(root, result))
    if action == "completion":
        limit = arguments.get("limit") or 20
        result = await asyncio.wait_for(
            session.client.text_document_completion_async(
                lsp.CompletionParams(text_document=document, position=position(arguments))
            ),
            timeout=REQUEST_TIMEOUT,
        )
        return rendering.truncate(rendering.render_completion(result, int(limit)))
    if action == "document_symbols":
        result = await asyncio.wait_for(
            session.client.text_document_document_symbol_async(
                lsp.DocumentSymbolParams(text_document=document)
            ),
            timeout=REQUEST_TIMEOUT,
        )
        return rendering.truncate(rendering.render_document_symbols(result))
    if action == "signature_help":
        result = await asyncio.wait_for(
            session.client.text_document_signature_help_async(
                lsp.SignatureHelpParams(text_document=document, position=position(arguments))
            ),
            timeout=REQUEST_TIMEOUT,
        )
        return rendering.truncate(rendering.render_signature_help(result))
    if action == "formatting":
        result = await asyncio.wait_for(
            session.client.text_document_formatting_async(
                lsp.DocumentFormattingParams(
                    text_document=document,
                    options=lsp.FormattingOptions(tab_size=4, insert_spaces=True),
                )
            ),
            timeout=REQUEST_TIMEOUT,
        )
        text = session.documents.text(uri) or path.read_text(
            encoding="utf-8", errors="replace"
        )
        try:
            relative = str(path.relative_to(root))
        except ValueError:
            relative = str(path)
        return rendering.truncate(rendering.render_formatting(relative, text, result or []))
    return f"Error: unsupported LSP action '{action}'"

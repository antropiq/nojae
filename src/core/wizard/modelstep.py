"""The wizard's model step: one call per step, and its three outcomes (§5).

These are the first model calls in the app that belong to **no conversation**, so
the rules that keep them honest are stated here once:

* **one seam.** The call goes out through :func:`send`, which calls
  ``core.llmkit.chat_completion`` and nothing else. That shape takes no ``tools``
  argument and sends no ``stream`` key, so the wizard's calls are tool-less and
  non-streaming *by construction*: nothing is offered to the model to execute, and
  no token stream reaches a dialog. There is no loop here either — one call, one
  answer — which is what keeps a preparation dialog from becoming a second,
  unsupervised agent loop.
* **one attempt.** It never consults the seam's retryability verdict, never
  sleeps and never retries. The chat turn waits out a refused round because a
  whole reply depends on it; a dialog that silently sleeps through a 30-second
  backoff is worse than a named failure, so the endpoint's own sentence is shown
  and the user presses the button again.
* **the connection is an argument.** ``model``, ``server_url``, ``api_key`` and
  the sampling the store holds arrive in a :class:`Connection` and are never
  re-resolved here: resolution is the route's, once, at the dialog's start — the
  chat's "once, at a turn's start" rule applied to a wizard. Nothing in this
  module reads ``.env``, the settings store or a request.
* **three outcomes, and the difference is the point.** ``ok`` carries parsed
  candidates (or the prepared member), ``empty`` says the model answered and
  found nothing, ``failed`` names why there is no answer — and "no language
  server found", "the endpoint refused", "the endpoint could not be reached" and
  "the answer could not be read" are four different sentences, because a user can
  act on the difference.
* **no numbers, ever.** The response's ``usage`` is discarded and no timing is
  taken: these tokens enter neither the session clock nor the cost badges, and no
  value this module returns is a number about the call.

:func:`send` is the test's seam, the way the LSP hub's command resolution is: a
test re-points that one attribute and captures the request, rather than patching
``llmkit`` globally.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple

# ``httpx`` is imported for its **error type** and nothing else: this module names
# no client, builds no request and opens no socket — the one call it makes is
# ``llmkit.chat_completion``'s. ``TransportError`` is what a failure *before the
# response head* raises, and the wizard must tell that apart from a refusal, so
# the distinction is made on the type the seam itself raises.
import httpx

from src.core.llmkit import LLMRequestError, chat_completion

from . import prompts

#: The three outcomes. They are the API's `outcome` values too, spelled once so
#: the route, the composable and the dialog cannot drift apart.
OK = "ok"
EMPTY = "empty"
FAILED = "failed"

#: The sentences this module owns. The refusal case is **not** here: it reuses
#: the endpoint's own sentence (``str(LLMRequestError)``), which names the status,
#: the URL and the upstream message.
EMPTY_SENTENCE = "No language server found for this folder."
UNREACHABLE_LEAD = "Could not reach the model endpoint: "
FAILED_LEAD = "The model call failed: "
UNREADABLE_LEAD = "The model's answer could not be read: "


@dataclass(frozen=True)
class Connection:
    """One resolved model connection, as a step receives it.

    Built by the route from the agent the panel is showing, once per wizard: the
    values are the settings store's own (``model``, the server's URL and key, the
    sampler columns), and this module never looks any of them up again.
    """

    model: str
    server_url: str
    api_key: str = ""
    sampling: Mapping[str, Any] = field(default_factory=dict)


def send(
    *,
    model: str,
    server_url: str,
    messages: List[Dict[str, str]],
    api_key: str,
    sampling: Mapping[str, Any],
) -> Dict[str, Any]:
    """The one seam call this package makes — and the test's one patchable name.

    ``chat_completion``'s own signature is the guarantee that matters here: it
    has no ``tools`` parameter and sends no ``stream`` key, so a call through this
    function is tool-less and non-streaming whatever a caller passes.
    """
    return chat_completion(
        model=model,
        server_url=server_url,
        messages=messages,
        api_key=api_key,
        sampling=dict(sampling or {}),
    )


def _result(
    outcome: str,
    sentence: Optional[str] = None,
    proposals: Optional[List[Dict[str, Any]]] = None,
    prepared: Optional[Dict[str, Any]] = None,
    notes: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """The step's answer — plain JSON-ready values, and no number among them."""
    return {
        "outcome": outcome,
        "sentence": sentence,
        "proposals": proposals or [],
        "prepared": prepared,
        "notes": notes or [],
    }


def _failed(sentence: str) -> Dict[str, Any]:
    return _result(FAILED, sentence=sentence)


def _answer_text(payload: Any) -> str:
    """The one assistant text an OpenAI-shaped body carries.

    The wizard asks for one JSON object and reads nothing else from the envelope:
    ``usage`` is exactly what this function never looks at.
    """
    if not isinstance(payload, dict):
        raise prompts.AnswerShapeError("the response body is not a JSON object")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise prompts.AnswerShapeError("the response carries no choices")
    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str):
        raise prompts.AnswerShapeError("the response carries no message content")
    return content


def _ask(
    connection: Connection, messages: List[Dict[str, str]]
) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """One attempt at one question: ``(answer text, failure result)``.

    Exactly one of the two is ``None``. Every failure shape is named separately
    and none is waited on: a refusal contributes the endpoint's own sentence, a
    transport failure says the endpoint could not be reached, anything else says
    the call failed.
    """
    try:
        payload = send(
            model=connection.model,
            server_url=connection.server_url,
            messages=messages,
            api_key=connection.api_key,
            sampling=connection.sampling,
        )
    except LLMRequestError as exc:
        # The endpoint's own words, verbatim — status, URL and upstream message.
        return None, _failed(str(exc))
    except httpx.TransportError as exc:
        return None, _failed(f"{UNREACHABLE_LEAD}{exc}")
    except Exception as exc:  # noqa: BLE001 — a broken call is a named state
        return None, _failed(f"{FAILED_LEAD}{exc}")
    try:
        return _answer_text(payload), None
    except prompts.AnswerShapeError as exc:
        return None, _failed(f"{UNREADABLE_LEAD}{exc}")


def propose(
    connection: Connection,
    facts: Dict[str, Any],
    declaration_path: str,
) -> Dict[str, Any]:
    """The LSP flow's first step: servers this folder lacks, best first.

    ``facts`` is the scan's payload from
    :func:`src.core.editorfs.projectfacts.project_facts`; ``declaration_path`` is
    the absolute path of the file the entry will belong in, resolved by the
    caller that knows which family is being prepared.

    An empty list is the ``empty`` outcome — the model answered well and found
    nothing fits — which is a stop, not a failure: neither list offers "none of
    these" (§3).
    """
    answer, failure = _ask(
        connection, prompts.propose_messages(facts, declaration_path)
    )
    if failure is not None:
        return failure
    try:
        proposals, notes = prompts.parse_proposals(answer or "")
    except prompts.AnswerShapeError as exc:
        return _failed(f"{UNREADABLE_LEAD}{exc}")
    if not proposals:
        return _result(EMPTY, sentence=EMPTY_SENTENCE, notes=notes)
    return _result(OK, proposals=proposals, notes=notes)


def prepare(
    family: str,
    connection: Connection,
    candidate: Dict[str, Any],
    facts: Dict[str, Any],
    declaration_path: str,
) -> Dict[str, Any]:
    """The second step of both families: the complete member for one candidate.

    ``candidate`` is a catalogue entry's ``member`` group for ``mcp`` and a
    proposal for ``lsp`` — the one thing the two flows do not share. There is no
    ``empty`` outcome here: an answer without a member is an answer that could not
    be read, which is a named failure rather than a list holding nothing.
    """
    answer, failure = _ask(
        connection,
        prompts.prepare_messages(family, candidate, facts, declaration_path),
    )
    if failure is not None:
        return failure
    try:
        prepared, notes = prompts.parse_prepared(answer or "")
    except prompts.AnswerShapeError as exc:
        return _failed(f"{UNREADABLE_LEAD}{exc}")
    return _result(OK, prepared=prepared, notes=notes)

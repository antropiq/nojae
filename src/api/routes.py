"""REST + SSE endpoints for the WorkBench and the Editor."""

import asyncio
import base64
import binascii
import json
import re
import threading
from contextlib import suppress
from pathlib import Path
from typing import (
    Any,
    AsyncIterator,
    Dict,
    List,
    Literal,
    Optional,
    Tuple,
    Union,
    get_args,
)

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from src.api.events import sse_format
from src.config import (
    agent_connection_refusal,
    agent_instructions_block,
    load_endpoints_config,
    max_tool_iteration,
    network_fail_budget,
)
from src.core.mcphub import (
    load_externals,
    mcp_settings_file_state,
    set_externals_enabled,
)
from src.core.mcphub import catalogue as mcp_catalogue
from src.core.lsphub import (
    all_servers,
    lsp_settings_file_state,
    lsp_settings_template_state,
    set_lsp_enabled,
)
from src.core import editorfs
from src.core.editorfs import policy_seed
from src.core import agent_modes
from src.core import appdb
from src.core import hubpool
from src.core import prompt_helpers
from src.core import termhub
from src.core.termhub import policy as term_policy
from src.core.termhub import drivers as term_drivers
from src.core import batch as batch_core
from src.core import skills as skills_core
from src.core import wizard as wizard_core
from src.core import workspace as workspace_seam
from src.core.chat import stream_chat
from src.core.llmkit.client import models_url
from src.core.llmkit.sanitize import sanitize_content
from src.core.models import EndpointsConfig, ReasoningEffort


class SettingsFieldsMixin(BaseModel):
    """Tolerant request fields: JSON scalars are accepted and stringified.

    ``null`` means "unset" and unknown keys are ignored, so hand-written
    clients may post numbers (``"temp": 0.2``) or omit optional fields.
    """

    model_config = ConfigDict(extra="ignore")

    @field_validator("*", mode="before")
    @classmethod
    def _stringify_scalars(cls, value: Any) -> Any:
        if value is None:
            return ""
        if isinstance(value, (dict, list, BaseModel)) or isinstance(value, bool):
            return value
        if isinstance(value, (str, int, float)):
            return str(value)
        raise ValueError("expected a string or number")


class PromptHelperFields(BaseModel):
    """The two fields one bullet carries, and the strictness they are held to.

    Shared by the create and the update body: the store refuses a bad colour or an
    over-cap content in words naming the field. The cap is **not** spelled in the
    client either — it arrives in the read's ``caps`` — so this is the one place
    the number is checked.
    """

    model_config = ConfigDict(extra="ignore")

    color: str = prompt_helpers.DEFAULT_COLOR
    content: str = ""

    @field_validator("color")
    @classmethod
    def _require_hex_color(cls, value: str) -> str:
        if not prompt_helpers.COLOR_RE.match(value):
            raise ValueError("color must be a 6-digit hex color (e.g. #808080)")
        return value

    @field_validator("content")
    @classmethod
    def _cap_content(cls, value: str) -> str:
        if len(value) > prompt_helpers.CONTENT_MAX_CHARS:
            raise ValueError(
                f"content exceeds the {prompt_helpers.CONTENT_MAX_CHARS} "
                "character cap"
            )
        return value


class PromptHelperCreateIn(PromptHelperFields):
    """A bullet being **added**: colour and text, and no id — the store assigns it."""


class PromptHelperUpdateIn(PromptHelperFields):
    """A bullet being **rewritten**, addressed by the id the read handed out.

    Saving empty ``content`` clears the bullet and keeps its colour.
    """

    id: int = Field(ge=1)


class PromptHelperDeleteIn(BaseModel):
    """A bullet being **deleted**: its id, and nothing else.

    Deliberately not a subclass of the fields above: a body that could smuggle a
    colour or text would be a second way to write a row through the route that
    removes it.
    """

    model_config = ConfigDict(extra="ignore")

    id: int = Field(ge=1)


# -- the servers and models routes' bodies --------------------------------------

#: The range each sampler column accepts, keyed by the **payload** name the read
#: uses (so a body round-trips what the read answered). The dialog has always
#: declared these ranges; here they are enforced on the way in rather than only
#: drawn, because a ``REAL`` column will happily hold a temperature of ``-4``.
#:
#: ``None`` means the app states no bound in that direction — a presence penalty
#: is legitimately negative, and inventing a ceiling for it would refuse a value
#: the model accepts. The numbers travel to the browser in the read's ``caps``,
#: so no range is spelled in the client either.
SAMPLER_RANGES: Dict[str, tuple] = {
    "temperature": (0.0, None),
    "topP": (0.0, 1.0),
    "topK": (0.0, None),
    "minP": (0.0, None),
    "repeatPenalty": (0.0, None),
    "presencePenalty": (None, None),
}

#: The reasoning levels the app knows, read off the one type that declares them
#: (:data:`src.core.models.ReasoningEffort`) rather than copied. A value outside
#: this set is refused in a message naming the field; the set travels to the
#: browser in the read's ``caps``.
REASONING_LEVELS: tuple = get_args(ReasoningEffort)


def _sampler_range_sentence(field: str) -> str:
    """The range as a sentence, for the 422 that names it."""
    low, high = SAMPLER_RANGES[field]
    if low is not None and high is not None:
        return f"{field} must be between {low} and {high}"
    if low is not None:
        return f"{field} must be at least {low}"
    return f"{field} must be at most {high}"


class SamplerFieldsMixin(BaseModel):
    """The six samplers, the reasoning level and the vision flag, and their rules.

    Shared by the model create and the model update, because both write the same
    columns and a rule spelled twice is a rule that stops agreeing with itself.

    An **empty field is unset**, not zero: the tolerant pass below turns ``""``
    into ``None``, which becomes a ``NULL`` column, which
    :meth:`EndpointsConfig.from_store` omits from the request body. A ``0`` stays
    a ``0``, because the two are different values.
    """

    model_config = ConfigDict(extra="ignore")

    name: str = ""
    sysPrompt: str = ""
    temperature: Optional[float] = None
    topP: Optional[float] = None
    topK: Optional[int] = None
    minP: Optional[float] = None
    repeatPenalty: Optional[float] = None
    presencePenalty: Optional[float] = None
    reasoning: Optional[str] = None
    supportsVision: bool = False

    @field_validator(
        "temperature", "topP", "topK", "minP", "repeatPenalty", "presencePenalty",
        "reasoning", mode="before",
    )
    @classmethod
    def _blank_is_unset(cls, value: Any) -> Any:
        """``""`` and ``null`` both mean "this column holds nothing"."""
        if value is None:
            return None
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("name", mode="before")
    @classmethod
    def _require_name(cls, value: Any) -> str:
        """Same rule as a server's: a model is named, and a blank is refused in words."""
        if not isinstance(value, str) or not value.strip():
            raise ValueError("name must not be empty")
        return value.strip()

    @field_validator("sysPrompt", mode="before")
    @classmethod
    def _keep_sys_prompt(cls, value: Any) -> Any:
        """An empty prompt is a **value**, not "unset": it means the default.

        So it is deliberately outside :meth:`_blank_is_unset` — the column is
        ``NOT NULL DEFAULT ''``, and :meth:`EndpointsConfig.from_store` reads an
        empty one as ``DEFAULT_LLM_SYSPROMPT``.
        """
        if value is None:
            return ""
        return value

    @field_validator("temperature", "topP", "topK", "minP", "repeatPenalty",
                     "presencePenalty")
    @classmethod
    def _require_in_range(cls, value: Optional[float], info) -> Optional[float]:
        field = info.field_name
        low, high = SAMPLER_RANGES[field]
        if value is None:
            return None
        if (low is not None and value < low) or (high is not None and value > high):
            raise ValueError(_sampler_range_sentence(field))
        return value

    @field_validator("reasoning")
    @classmethod
    def _require_known_level(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        level = value.strip().lower()
        if not level:
            return None
        if level not in REASONING_LEVELS:
            raise ValueError(
                "reasoning must be one of "
                f"{', '.join(REASONING_LEVELS)} (or empty for unset)"
            )
        return level


def _model_columns(body: SamplerFieldsMixin) -> Dict[str, Any]:
    """The body's sampler columns, as the store write's keyword arguments.

    One mapping for the create and the update, because the two write the same
    columns and a second spelling of the list is how they stop agreeing. The
    payload's camelCase names are mapped to the store's snake_case keyword
    arguments **here**, at the one seam that speaks to the browser: this is the
    request model's vocabulary meeting :mod:`src.core.appdb`'s call signature.
    """
    return {
        "sys_prompt": body.sysPrompt,
        "temperature": body.temperature,
        "top_p": body.topP,
        "top_k": body.topK,
        "min_p": body.minP,
        "repeat_penalty": body.repeatPenalty,
        "presence_penalty": body.presencePenalty,
        "reasoning": body.reasoning,
        "supports_vision": body.supportsVision,
    }


class ModelCreateIn(SamplerFieldsMixin):
    """A model being **added**: its fields, and the server it belongs to."""

    serverId: int = Field(ge=1)


class ModelUpdateIn(SamplerFieldsMixin):
    """A model being **rewritten**: its fields, and the id the read handed out.

    No ``serverId``: a model is never moved between servers, because that would
    silently re-point every agent running on it, and the dialog offers no such
    action.
    """

    id: int = Field(ge=1)


class ServerIn(BaseModel):
    """A server's three fields, as the dialog edits them.

    The create and the update take their own body models, so a create cannot
    address a row.
    """

    model_config = ConfigDict(extra="ignore")

    name: str = ""
    url: str = ""
    apiKey: str = ""

    # ``mode="before"`` so a ``null`` is answered by the field's own sentence
    # naming it, not FastAPI's generic type error.
    @field_validator("name", "url", mode="before")
    @classmethod
    def _require_text(cls, value: Any, info) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{info.field_name} must not be empty")
        return value.strip()

    @field_validator("url", mode="after")
    @classmethod
    def _require_http_url(cls, value: str) -> str:
        """The same rule the live model listing already holds its URL to."""
        if not value.lower().startswith(("http://", "https://")):
            raise ValueError("url must start with http:// or https://")
        return value

    @field_validator("apiKey", mode="before")
    @classmethod
    def _blank_key(cls, value: Any) -> str:
        """An empty key is a real value: a server that needs no authorization."""
        if value is None:
            return ""
        if not isinstance(value, str):
            raise ValueError("apiKey must be a string")
        return value.strip()


class ServerCreateIn(ServerIn):
    """A server being **added**: its fields, and no id."""


class ServerUpdateIn(ServerIn):
    """A server being **rewritten**: its fields, and the id the read handed out."""

    id: int = Field(ge=1)


class ServerDeleteIn(BaseModel):
    """A server being **deleted**: its id, and nothing else.

    Same discipline as :class:`PromptHelperDeleteIn`: a route that removes a row
    is not a second way to write one, so a body that could carry a name or a key
    is refused rather than ignored.
    """

    model_config = ConfigDict(extra="ignore")

    id: int = Field(ge=1)


class ModelDeleteIn(BaseModel):
    """A model being **deleted**: its id, and nothing else.

    Same discipline as :class:`ServerDeleteIn`.
    """

    model_config = ConfigDict(extra="ignore")

    id: int = Field(ge=1)


class McpIn(BaseModel):
    """MCP connector activation as sent by the settings dialog.

    ``enabled`` is the whole payload: the tool-loop cap this route used to carry
    is an **agent** column now, so a ``maxIterations`` here would be a second
    writer of a value this section no longer owns.
    """

    model_config = ConfigDict(extra="ignore")

    enabled: List[str] = []


class LspIn(BaseModel):
    """Language-server activation as sent by the settings dialog.

    ``enabled`` is the whole payload: the route writes the declaration's
    ``enable`` flag and nothing else. The tool-loop cap it used to carry is not
    this route's to set — it is a per-agent column now.
    """

    model_config = ConfigDict(extra="ignore")

    enabled: List[str] = []


class LspQueryIn(BaseModel):
    """One Editor-pane question to the language-server hub.

    ``action`` is the app's own vocabulary — never an LSP method name: the hub
    is the only thing that speaks the protocol. It is a plain string rather than
    a ``Literal`` on purpose, because the editor's action table lives in
    ``core/lsphub/editor.py`` and a copy of it here would be a second authority
    that drifts; an action the table does not know is answered quietly by the
    hub, not refused with a 422.

    ``line`` and ``character`` are **0-based**, LSP-native, and absent for the
    actions that need no position (the browser's ``lib/`` module does the
    ``+1``). ``text`` travels **only when the buffer is dirty**: the buffer is
    the source of truth, so a clean buffer omits it and the hub reads the file.
    ``lspEnabled`` is the conversation-scoped allowlist the Tools panel holds;
    ``None`` means "no filter" — the failed-snapshot case, which must not blind
    the pane.
    """

    model_config = ConfigDict(extra="ignore")

    action: str
    path: Optional[str] = None
    line: Optional[int] = None
    character: Optional[int] = None
    text: Optional[str] = None
    lspEnabled: Optional[List[str]] = None


class FileSaveIn(BaseModel):
    """A save of one whole editor buffer (``PUT /api/fs/file``).

    ``ifUnmodifiedSince`` is the ``mtime`` the read that filled this buffer
    reported — the optimistic-concurrency token the save guard compares against
    the disk. ``None`` skips the guard; the route logs that, because the SPA
    always sends the token and its absence is the shape of a client bug.

    The size cap is deliberately *not* a validator here: a Pydantic one would
    answer ``422``, but over-cap must be the read route's ``413`` naming the
    size. ``editorfs.write_file`` owns it.
    """

    model_config = ConfigDict(extra="ignore")

    path: str
    text: str = ""
    ifUnmodifiedSince: Optional[float] = None


class FileRenameIn(BaseModel):
    """A rename, and therefore a move (``POST /api/fs/rename``).

    ``to`` is the whole workspace-relative **target path**, not a new leaf name:
    that is what makes a move the same route as a rename, and it puts the
    target's parent chain under the same gate as any other path. A name-only
    field would push the joining into the client and leave the server unable to
    check the folder a file lands in.
    """

    model_config = ConfigDict(extra="ignore")

    frm: str = Field(alias="from")
    to: str


class FileMoveBatchIn(BaseModel):
    """Several files into one folder that already exists (``POST /api/fs/move-batch``).

    ``paths`` are the whole workspace-relative **source** paths and ``to_parent``
    is the destination **folder** ("" is the working location) — deliberately two
    fields, never a joined target: the server joins each source's own name to
    that folder, so the ancestor gate always sees the folder the file really
    lands in. That is ``FileCreateIn``'s argument in reverse — on either side, a
    client that joined the path itself could hide what the gate must check.

    No name field either: this route moves, it never renames, so there is one
    basename rule in the app, not two.
    """

    model_config = ConfigDict(extra="ignore")

    paths: List[str]
    to_parent: str


class FileCreateIn(BaseModel):
    """A new file or folder (``POST /api/fs/create``).

    ``path`` is the whole workspace-relative path of the thing to create — its
    parent must already exist, so this is one name per request and never a
    ``mkdir -p``. ``dir`` picks a folder over an empty file.

    A name-only field is deliberately *not* offered: a client that joined a name
    to a folder itself could hide the joining from the ancestor-chain gate.
    """

    model_config = ConfigDict(extra="ignore")

    path: str
    dir: bool = False


# -- the agents routes' bodies --------------------------------------------------

def _agent_field_sentence(problem: Optional[str], field: str) -> str:
    """A core validation problem as the 422 that names the field.

    The core (``core.agent_modes``) owns the rules — the slug pattern, the label
    and persona caps, the cap's floor — and its sentences already name the field;
    this only puts the field name in front so the dialog can place the message.
    """
    return f"{field}: {problem}"


class AgentFieldsMixin(BaseModel):
    """The fields one agent carries, and the strictness they are held to.

    Shared by the create and the update, because both write the same columns and
    a rule spelled twice is a rule that stops agreeing with itself. The bounds
    themselves are **not** repeated here: the core's ``_mode_id_problem`` /
    ``_label_problem`` / ``_persona_problem`` / ``_tool_iteration_problem`` are
    the one authority, and their sentences name the field.

    ``modelId`` is nullable on purpose: an agent with no model is a legal save
    that makes the agent unrunnable, which is the composer's warning, not a form
    error.
    """

    model_config = ConfigDict(extra="ignore")

    label: Optional[str] = None
    maxToolIteration: Optional[int] = None
    mcpEnable: Optional[bool] = None
    lspEnable: Optional[bool] = None
    systemMessage: Optional[str] = None
    modelId: Optional[int] = None

    @field_validator("label", "systemMessage", mode="before")
    @classmethod
    def _blank_is_unset(cls, value: Any) -> Any:
        """``""`` and ``null`` both mean "this column holds nothing".

        For a **label** that means "unset", which a create refuses with a message
        naming the field and an update reads as "leave it alone"; for a persona it
        means "use the model's own prompt", stored as ``''``.
        """
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("modelId", mode="before")
    @classmethod
    def _blank_model_is_none(cls, value: Any) -> Any:
        """The dropdown's empty option is an explicit "no model", not an omission."""
        if value is None or value == "":
            return None
        return value


class AgentCreateIn(AgentFieldsMixin):
    """An agent being **added**: its id, its label, and the rest of its fields.

    The **id** is the caller's, unlike every other create in this app: it is the
    slug a chat payload and every saved session file on disk carry, and the dialog
    derives it from the label the user typed. A duplicate id or a duplicate label
    is a 422 naming the field.
    """

    id: str = ""


class AgentUpdateIn(AgentFieldsMixin):
    """An agent being **rewritten**: the id it was read under, and its fields.

    The id is immutable — renaming it would silently orphan every saved session
    that names it — so a rename is an add plus a delete and this route does not
    offer one. ``modelId`` **absent from the body** leaves the association alone,
    while sending ``null`` clears it (the dropdown's empty option); which of the
    two it was is read off ``model_fields_set`` by the route, because pydantic
    gives an omitted field and an explicit ``null`` the same value.
    """

    id: str = ""


class AgentDeleteIn(BaseModel):
    """An agent being **deleted**: its id, and nothing else.

    Same discipline as :class:`ServerDeleteIn`.
    """

    model_config = ConfigDict(extra="ignore")

    id: str = ""


# -- the connector wizard's bodies ----------------------------------------------
#
# Two posts, and both name the agent the panel is showing: the wizard's model
# steps run on **that** agent's connection, resolved once per request, and there
# is no server-side default agent to fall back to. A blank or unknown id is the
# 422 naming ``agentMode``, exactly as a chat turn's is.


class WizardProposeIn(BaseModel):
    """The LSP flow's first step: propose servers for this folder.

    Nothing else travels: the scan facts are *this server's* answer about the
    folder the request names, so a client cannot hand the model facts about a
    project it is not working on.
    """

    model_config = ConfigDict(extra="ignore")

    agentMode: str = ""


class WizardPrepareIn(BaseModel):
    """The second step of either family: prepare one chosen candidate.

    ``candidate`` is page 1's own answer, handed back unread: for ``mcp`` it
    carries only the catalogue entry's ``id`` (looked up again here, so a command
    line can only ever come from the catalogue), and for ``lsp`` it is the
    proposal the model made. ``family`` is the one the button that opened the
    dialog fixed — never a question, and never a third name.
    """

    model_config = ConfigDict(extra="ignore")

    agentMode: str = ""
    family: str = ""
    candidate: Dict[str, Any] = Field(default_factory=dict)


# Base64-decoded image size limit for multimodal chat messages; the client
# applies the same limit before reading a file.
MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024
_CHAT_IMAGE_DATA_URL = re.compile(
    r"^data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$"
)


class ChatImageUrl(BaseModel):
    """Image reference inside a multimodal chat content part."""

    model_config = ConfigDict(extra="ignore")

    url: str

    @field_validator("url")
    @classmethod
    def _require_data_url(cls, value: str) -> str:
        match = _CHAT_IMAGE_DATA_URL.match(value)
        if match is None:
            raise ValueError(
                "image_url.url must be a base64 data URL "
                "(data:image/png|jpeg|webp|gif;base64,...)"
            )
        try:
            decoded = base64.b64decode(match.group(2), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"image data is not valid base64: {exc}") from exc
        if len(decoded) > MAX_CHAT_IMAGE_BYTES:
            raise ValueError(
                f"image is too large ({len(decoded)} bytes, max "
                f"{MAX_CHAT_IMAGE_BYTES})"
            )
        return value


class ChatContentPart(BaseModel):
    """One OpenAI-style multimodal content part (text or image_url)."""

    model_config = ConfigDict(extra="ignore")

    type: Literal["text", "image_url"]
    text: Optional[str] = None
    image_url: Optional[ChatImageUrl] = None

    @field_validator("text")
    @classmethod
    def _neutralise_control_tokens(cls, value: Optional[str]) -> Optional[str]:
        # Runs are removed before any shape check sees the text, so a part that
        # was only a run reads as empty to the validators below and to
        # ``ChatIn._require_turns``: control tokens alone are a 422, never a
        # silent empty turn.
        return None if value is None else sanitize_content(value)

    @model_validator(mode="after")
    def _require_payload(self) -> "ChatContentPart":
        if self.type == "text" and self.text is None:
            raise ValueError("text content part requires text")
        if self.type == "image_url" and self.image_url is None:
            raise ValueError("image_url content part requires image_url")
        return self


class ChatMessage(BaseModel):
    """One chat turn as sent by the chat screen.

    ``content`` is a plain string or a list of multimodal parts (user messages
    only) so images travel as base64 data URLs in the OpenAI format.
    """

    model_config = ConfigDict(extra="ignore")

    role: Literal["user", "assistant"]
    content: Union[str, List[ChatContentPart]]

    @model_validator(mode="after")
    def _require_payload(self) -> "ChatMessage":
        if isinstance(self.content, str):
            # Same rule as the text parts: runs are gone before the shape
            # checks, so history that only smuggled control tokens is refused.
            self.content = sanitize_content(self.content)
        if not isinstance(self.content, str):
            if self.role == "assistant":
                raise ValueError("assistant messages must use plain text content")
            if not self.content:
                raise ValueError("message content must not be empty")
            has_image = any(part.type == "image_url" for part in self.content)
            has_text = any(
                part.type == "text" and (part.text or "").strip()
                for part in self.content
            )
            if not has_image and not has_text:
                raise ValueError("message content must not be empty")
        return self

    def payload(self) -> Dict[str, Any]:
        """Shape the message for the LLM client (parts dumped to plain dicts)."""
        if isinstance(self.content, str):
            return {"role": self.role, "content": self.content}
        return {
            "role": self.role,
            "content": [part.model_dump(exclude_none=True) for part in self.content],
        }


class ChatIn(BaseModel):
    """Chat request body: the full conversation history."""

    model_config = ConfigDict(extra="ignore")

    messages: List[ChatMessage]
    # Conversation-scoped MCP filter: the connectors whose tools this conversation
    # may use, intersected with the Settings-activated set. ``None`` is "no filter".
    mcpEnabled: Optional[List[str]] = None
    # Same conversation-scoped filter for the language servers.
    lspEnabled: Optional[List[str]] = None
    # The agent this turn runs as (see core.agent_modes). **Required**: there is
    # no server-side default agent, so a body with no ``agentMode`` is the 422
    # naming the field rather than a turn that runs as some agent the client never
    # chose. No default at all is what makes the validator below the only answer.
    agentMode: str

    # Batch mode only: the task lot's big-picture text, which ``core.chat``
    # appends to the system message of *every* task turn. Capped by the very
    # number the listing enforced when it handed the body over, so the two sides
    # cannot drift. Not otherwise validated: this is a single-user app and the
    # same person already owns the workspace's ``sysprompt``, so a caller-chosen
    # system block grants no new privilege.
    batchContext: Optional[str] = None

    @field_validator("batchContext")
    @classmethod
    def _cap_batch_context(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        # Read through the module so a patch of the cap (the tests) applies.
        cap = batch_core.MAX_BATCH_LOT_BYTES
        if len(value.encode("utf-8")) > cap:
            raise ValueError(
                f"batchContext is too large ({len(value.encode('utf-8'))} "
                f"bytes, max {cap})"
            )
        return value

    @field_validator("messages")
    @classmethod
    def _require_turns(cls, value: List[ChatMessage]) -> List[ChatMessage]:
        if not value:
            raise ValueError("messages must not be empty")
        for message in value:
            # Only a blank *user* turn is a client bug. A blank assistant turn
            # is a legitimate artefact (a sanitised run-only answer, or a round
            # that ended before any text), and refusing it would answer every
            # later turn of that conversation with a 422 the user cannot clear
            # from the UI — the brick is worse than the empty turn.
            if (
                message.role == "user"
                and isinstance(message.content, str)
                and not message.content.strip()
            ):
                raise ValueError("message content must not be empty")
        return value

    @field_validator("agentMode")
    @classmethod
    def _mode_id_shape(cls, value: Optional[str]) -> str:
        """The *shape* of an agent id — not whether it exists, and not emptiness.

        Only the shape belongs in the model: "is this an agent that exists right
        now" is a question about rows that may have changed a second ago, so a
        ``Literal[...]`` or an enum here would freeze the list at import time.
        The existence check is ``resolve_mode()``'s job, called from ``post_chat``.

        **A missing id is the 422 naming the field**: there is no server-side
        default agent to fall back to, so an empty value is refused here rather
        than normalised to ``None``.
        """
        if value is None or not value.strip():
            raise ValueError(
                "agentMode is required: the agent this turn runs as — nojae has "
                "no default agent to fall back to"
            )
        if len(value) > agent_modes.MAX_MODE_ID_CHARS or re.match(
            agent_modes.MODE_ID_PATTERN, value
        ) is None:
            raise ValueError(
                "agentMode must be an agent id: a lowercase letter, then "
                "letters, digits, '_' or '-' (up to "
                f"{agent_modes.MAX_MODE_ID_CHARS} characters)"
            )
        return value


# Strong references to in-flight chat pump tasks (the event loop only keeps
# weak references to bare tasks), **keyed by the workspace each reply is about**
# and valued with that reply's canonical root — so "is a reply streaming" can be
# asked *of a workspace*, the only form of the question that means anything when
# two folders are served at once.
_CHAT_TASKS: Dict[Any, str] = {}


class ChatHandle:
    """One in-flight chat reply, so another request can pause it.

    ``POST /api/chat/pause`` is a separate HTTP request from the reply's own
    stream, so the pause flag has to live somewhere the two requests share. It
    is **keyed by workspace**, not held in one process-wide slot: the reply a tab
    may pause is the reply running on *that tab's* folder, and a second tab's
    turn is nobody else's to stop.
    """

    def __init__(self, pause_event: threading.Event, cancel_event: threading.Event) -> None:
        self.pause_event = pause_event
        self.cancel_event = cancel_event


# One handle per workspace, set for the duration of that workspace's streaming
# reply (cleared when its SSE generator ends), so a finished or aborted reply can
# never be paused afterwards. Two workspaces therefore hold two replies at the
# same time — nothing here serialises them, and nothing may: turns are never
# queued across tabs.
_CHAT_HANDLES: Dict[str, ChatHandle] = {}


def _arm_chat_handle(
    root: str, cancel_event: threading.Event, pause_event: threading.Event
) -> None:
    """Publish this workspace's in-flight reply so /chat/pause can reach it."""
    _CHAT_HANDLES[root] = ChatHandle(pause_event=pause_event, cancel_event=cancel_event)


def _clear_chat_handle(root: str, cancel_event: threading.Event) -> None:
    """Retire a workspace's handle, but only if it is still this reply's.

    Per key, with the rule the process-wide slot already had: a newer
    conversation on the same folder must never be un-registered by an old
    stream's ``finally``, and a reply on another folder is not this one's to
    clear either.
    """
    handle = _CHAT_HANDLES.get(root)
    if handle is not None and handle.cancel_event is cancel_event:
        _CHAT_HANDLES.pop(root, None)


def _chat_reply_handle(root: str) -> Optional[ChatHandle]:
    """The reply a request about ``root`` may pause, or ``None``."""
    return _CHAT_HANDLES.get(root)


def _chat_streaming_on(root: str) -> bool:
    """Is a reply streaming **on this workspace**? (Not: anywhere.)

    The wider question the hub-restart routes ask — it covers a reply whose
    handle is not armed yet, because those routes tear down what that reply is
    using. Keyed by the same canonical root the reply was armed under, so a
    reply on A never holds B's hub still.
    """
    return root in _CHAT_TASKS.values()


def workspace_is_busy(root: str) -> bool:
    """The pool's **veto**: is this workspace mid-work?

    Handed to :meth:`src.core.hubpool.HubPool.set_busy_predicate` at startup, so
    the pool can refuse to let go of a workspace whose tools are in use without
    importing this layer. The answer is the workspace's, never the process's: a
    reply on A says nothing about B.

    A **running batch** is covered by the same fact: every task of a lot is a
    chat turn on the workspace the lot was launched from, so a lot in progress
    keeps this answer true while it works. What it does not cover is the few
    seconds' pause between two relaunches of a task, which only costs a rebuild
    of a folder the tab is still pointed at.

    The wider question (``_chat_streaming_on``) is the one to ask, not the armed
    handle: the pool would be tearing down the very hub that reply is about to
    call.
    """
    return _chat_streaming_on(root)


def _refuse_if_chat_streaming(what: str, root: str) -> None:
    """409 while a chat reply is in flight **on ``root``** — the one place.

    A reply is the only other writer of *its* workspace, so a mutation landing
    in the middle of one races the model's own tool edits. Its **subject** is
    the folder the request names, so a save in B is not refused by a reply
    streaming against A. The check is the same per-workspace slot
    ``POST /api/chat/pause`` reads; the client-side rule in ``useEditorMode``
    is the *display* of this and the server is the enforcement.

    (The hub-restart routes ask the wider question instead —
    :func:`_chat_streaming_on`, which also covers a reply whose handle is not
    armed yet — because they tear down what that reply is using. A file write
    only needs to know a reply is streaming.)
    """
    if _chat_reply_handle(root) is not None:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot {what} while a chat reply is streaming on {root}",
        )


def _model_ids(payload: Any) -> List[str]:
    """Extract model ids from an OpenAI-compatible /models payload."""
    data = payload.get("data") if isinstance(payload, dict) else None
    ids = [
        item["id"]
        for item in data or []
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    ]
    return sorted(set(ids))


# Last known context window per (models url, model id): success is cached
# indefinitely (n_ctx only changes with a server restart, which also flips the
# key), failures fall back to the stale value or None.
_CTX_WINDOW_CACHE: Dict[tuple, int] = {}


def _context_window(server_url: str, api_key: str, model: str) -> Optional[int]:
    """Context window (tokens) of the configured model, None when unknown.

    Reads ``meta.n_ctx`` from an OpenAI-compatible ``/models`` entry
    (llama.cpp exposes it); a server that omits it is not an error — the
    chat occupancy badge then just shows the used side without a limit.

    Only the entry whose ``id`` is this model counts: a name the server does
    not list answers None rather than crediting another model's window.
    """
    if not server_url.strip():
        return None
    url = models_url(server_url)
    key = (url, model)
    try:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        with httpx.Client(timeout=3.0) as client:
            response = client.get(url, headers=headers)
            response.raise_for_status()
            payload = response.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        entries = [item for item in data or [] if isinstance(item, dict)]
        entry = next((item for item in entries if item.get("id") == model), None)
        meta = entry.get("meta") if entry else None
        n_ctx = meta.get("n_ctx") if isinstance(meta, dict) else None
        if isinstance(n_ctx, int) and n_ctx > 0:
            _CTX_WINDOW_CACHE[key] = n_ctx
            return n_ctx
    except (httpx.HTTPError, ValueError):
        pass
    return _CTX_WINDOW_CACHE.get(key)


def _active_connector_ids() -> List[str]:
    """Connector ids whose tools chat may use.

    The one gate is each connector's ``enable`` flag in the workspace's
    ``.nojae/mcp-settings.json`` — nothing else has to agree.
    """
    connectors, _errors = load_externals()
    return [connector["id"] for connector in connectors if connector["enable"]]


def _active_server_ids() -> List[str]:
    """Language-server ids whose tools chat may use.

    One gate decides: the entry's ``enable`` flag in the workspace's
    ``.nojae/lsp-settings.json``, the same rule :func:`_active_connector_ids`
    follows for MCP.

    Not to be confused with a request's ``lspEnabled``: that is the
    **conversation**-scoped allowlist the Tools panel holds, which only narrows
    the ids computed here (see :func:`_allowed_server_ids`).
    """
    servers, _errors = all_servers()
    return [server["id"] for server in servers if server["enable"]]


def _allowed_server_ids(enabled: Optional[List[str]]) -> List[str]:
    """The activated server ids, narrowed by a caller's allowlist.

    One implementation, shared by chat (``_lsp_tool_kwargs``) and the Editor
    pane's query route, so the two can never disagree about what "this server is
    switched on" means. The intersection keeps the declaration the authority: a
    stale id silently drops and a server whose ``enable`` flag is off can never
    leak back in. ``None`` means "no filter" — the failed-snapshot case, which
    must not blind the pane.
    """
    server_ids = _active_server_ids()
    if enabled is not None:
        allowed = set(enabled)
        server_ids = [server_id for server_id in server_ids if server_id in allowed]
    return server_ids


#: The key :func:`_mcp_tool_kwargs` records the admitted MCP tool names under,
#: for :func:`turn_can_open_a_file` alone. It is **not** a ``stream_chat``
#: keyword: the route pops it out of the merged dict before the splat — a key
#: left in would arrive as an unexpected keyword argument and break every
#: tool-capable turn.
MCP_TOOL_NAMES_KWARG = "mcp_tool_names"


def turn_can_open_a_file(tool_kwargs: Dict[str, Any]) -> bool:
    """Can this turn open a file at all?

    The skills catalogue is an instruction to *read a file*, so it is only ever
    issued when reading one is possible: the answer is yes exactly when at least
    one **MCP** tool survived the three admission gates into the turn's tool
    kwargs. MCP tools are this app's only file-reading surface; LSP tools answer
    queries only and never file bytes — so an LSP-only turn, a tools-off agent
    and a connector that is declared and enabled but never started all answer no.

    The verdict reads the names :func:`_mcp_tool_kwargs` recorded at admission
    rather than a name pattern, a tool count or a hub lookup: a second lookup
    could disagree with the first. The caller passes the kwargs **as the merge
    returned them**; the route pops the recorded key before ``stream_chat`` sees
    the dict.
    """
    return bool(tool_kwargs.get(MCP_TOOL_NAMES_KWARG))


def _mcp_tool_kwargs(
    manager: Any,
    enabled: Optional[List[str]] = None,
    agent: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Extra ``stream_chat`` kwargs when MCP connectors are active for chat.

    ``manager`` is **this workspace's** connector manager — the one the turn's
    :class:`~src.core.hubpool.HubSet` holds, resolved once at the turn's start —
    or ``None`` when the workspace has none. It is handed in rather than looked up
    here because only the caller knows which folder the turn is about.

    ``enabled`` is the conversation-scoped connector allowlist from the chat
    body, intersected with the Settings-activated ids so Settings stays the
    authority — a connector deactivated there can never leak back into a running
    conversation. ``None`` means no filter. Returns ``{}`` when nothing is active,
    so the no-MCP call shape stays untouched. When tools *are* admitted the dict
    also carries :data:`MCP_TOOL_NAMES_KWARG`, which the route pops before
    ``stream_chat`` is called.

    ``agent`` is the row the turn resolved at its start, and it is where the
    tool-loop cap comes from — a per-agent column, so a save that lands mid-turn
    cannot move the number the loop is running with.
    """
    if manager is None:
        return {}
    connector_ids = _active_connector_ids()
    if enabled is not None:
        allowed = set(enabled)
        connector_ids = [cid for cid in connector_ids if cid in allowed]
    try:
        tools, tool_to_server = manager.active_tool_defs(connector_ids)
    except Exception:  # noqa: BLE001 — never block chat because of the hub
        return {}
    if not tools:
        return {}

    def tool_executor(name: str, arguments: Dict[str, Any]) -> str:
        return manager.call_tool_sync(tool_to_server[name], name, arguments)

    return {
        "tools": tools,
        "tool_executor": tool_executor,
        "tool_servers": tool_to_server,
        "max_tool_iterations": max_tool_iteration(agent),
        # The merged dict keeps no provenance, so the admission site is the only
        # place that can say which tools are MCP's. The route drops the key.
        MCP_TOOL_NAMES_KWARG: set(tool_to_server),
    }


# Chat-side budget for one LSP tool call: covers a lazy server's cold start
# (``initialize`` may take ``INIT_TIMEOUT`` while it indexes the project) plus
# the request and the diagnostics wait.
LSP_TOOL_TIMEOUT = 90.0


def _lsp_tool_kwargs(
    manager: Any, enabled: Optional[List[str]] = None
) -> Dict[str, Any]:
    """Extra ``stream_chat`` kwargs when language servers are active for chat.

    ``manager`` is this workspace's language-server manager, for the same reason
    :func:`_mcp_tool_kwargs` takes its own: which folder a turn is about is the
    caller's answer, not this one's.

    Same conversation-scoped filter as MCP: ``enabled`` is intersected with
    the Settings-activated ids, so a server disabled in Settings can never
    leak back into a running conversation. ``{}`` when nothing is active.
    """
    if manager is None:
        return {}
    server_ids = _allowed_server_ids(enabled)
    try:
        tools, tool_to_server = manager.active_tool_defs(server_ids)
    except Exception:  # noqa: BLE001 — never block chat because of the hub
        return {}
    if not tools:
        return {}

    def tool_executor(name: str, arguments: Dict[str, Any]) -> str:
        return manager.call_tool_sync(
            tool_to_server[name], name, arguments, timeout=LSP_TOOL_TIMEOUT
        )

    return {
        "tools": tools,
        "tool_executor": tool_executor,
        "tool_servers": tool_to_server,
    }


def _chat_tool_kwargs(
    hub_set: Any,
    mcp_enabled: Optional[List[str]] = None,
    lsp_enabled: Optional[List[str]] = None,
    mode: Optional[agent_modes.AgentMode] = None,
    agent: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """The single tool loop of ``stream_chat``, fed by both hubs.

    ``hub_set`` is **the turn's workspace's** :class:`~src.core.hubpool.HubSet`
    (or ``None``), resolved once at the turn's start like the agent's row and
    the connection: a turn's tools belong to the folder it was asked about, and
    they stay that folder's whatever another tab does to the pool afterwards.

    Three levels gate the tools that reach that loop and they only ever
    **intersect**: **Settings** (``_active_connector_ids`` /
    ``_active_server_ids``, the whole install), the **agent mode**
    (``mode.mcptools`` / ``mode.lsptools``, one hub) and the **conversation**
    (``mcp_enabled`` / ``lsp_enabled``, one connector). All three narrow the
    same allowlist, so Settings stays the authority and an open mode can never
    *grant* a connector the user unticked.

    The merge lives here (not in ``core/chat.py``): ``stream_chat`` keeps
    taking one ``tools`` list, one executor and one iteration cap, and the
    ``tool_servers`` map is what makes every tool call attributable to its
    hub in the Chat UI. MCP tools win a name clash (LSP tool names are
    namespaced, so in practice they cannot collide).

    ``mode=None`` means "no mode gate" and keeps the no-mode call shape
    byte-for-byte.

    ``agent`` is the row the turn resolved **at its start**, and the iteration
    cap rides with it: the number is a per-agent column, so the loop is bounded
    by what the agent said when the turn began and a save that lands mid-turn
    cannot move it.
    """
    # A mode with the flag false must take the hub away from the *model*, not
    # just from the prompt. ``[]`` — not ``None``, which is the "no filter"
    # sentinel on ``mcp_enabled``/``lsp_enabled``: passing ``None`` here would
    # open the hub wide. This is the one line to get wrong. The empty allowlist
    # makes both helpers return ``{}``, so ``stream_chat`` receives no ``tools``
    # key at all and no ``TOOL_NOTICE`` is appended.
    if mode is not None and not mode.mcptools:
        mcp_enabled = []
    if mode is not None and not mode.lsptools:
        lsp_enabled = []
    mcp_kwargs = _mcp_tool_kwargs(
        getattr(hub_set, "mcp", None), mcp_enabled, agent
    )
    lsp_kwargs = _lsp_tool_kwargs(getattr(hub_set, "lsp", None), lsp_enabled)
    if not mcp_kwargs and not lsp_kwargs:
        return {}
    if not lsp_kwargs:
        return mcp_kwargs
    if not mcp_kwargs:
        # LSP-only: every LSP tool is listed as uncapped, so an agent's LSP
        # round-trips are never bounded by ``max_tool_iterations`` (that knob is
        # MCP's). The cap value is still carried so the gauge's
        # ``maxIterations`` matches the agent's own value whenever it does move.
        return {**lsp_kwargs, "max_tool_iterations": max_tool_iteration(agent),
                "uncapped_tool_names": set(lsp_kwargs["tool_servers"])}

    tools = list(mcp_kwargs["tools"])
    tool_to_server = dict(mcp_kwargs["tool_servers"])
    for definition in lsp_kwargs["tools"]:
        name = definition["function"]["name"]
        if name in tool_to_server:
            continue
        tool_to_server[name] = lsp_kwargs["tool_servers"][name]
        tools.append(definition)
    mcp_executor = mcp_kwargs["tool_executor"]
    lsp_executor = lsp_kwargs["tool_executor"]
    lsp_tool_names = set(lsp_kwargs["tool_servers"])

    def tool_executor(name: str, arguments: Dict[str, Any]) -> str:
        if name in lsp_tool_names:
            return lsp_executor(name, arguments)
        return mcp_executor(name, arguments)

    return {
        "tools": tools,
        "tool_executor": tool_executor,
        "tool_servers": tool_to_server,
        "uncapped_tool_names": lsp_tool_names,
        "max_tool_iterations": max_tool_iteration(agent),
        # Carried through the merge so :func:`turn_can_open_a_file` still sees
        # the MCP admission. The route pops it before ``stream_chat`` is called.
        MCP_TOOL_NAMES_KWARG: mcp_kwargs[MCP_TOOL_NAMES_KWARG],
    }


# --- the workspace of a request ------------------------------------------------

#: The one name the folder travels under, and the one place it is spelled. A
#: query parameter **everywhere**, including the routes that take a body: the
#: client then has one helper and the server one reader, and a folder whose name
#: is not latin-1 survives (a header would not). Nothing else carries it — not a
#: body field, not a header, not the address bar.
WORKSPACE_QUERY = "workspace"

#: The routes whose answer is the **installation's** and which therefore must
#: keep answering even while a tab's folder has gone away. Listed here so the
#: invariant is a fact of this module rather than of a habit, and asserted by
#: ``tests/test_workspace_seam.py``.
#:
#: The connector wizard's two reads are here because page 1's MCP list is
#: committed data and its header line says who the dialog runs as — both about
#: the install, neither about a folder, so a tab whose folder was deleted can
#: still open the wizard. Its scan and its two posts are workspace-scoped.
INSTALLATION_SCOPED_PATHS = (
    "/api/config",
    "/api/prompt-helpers",
    "/api/servers",
    "/api/models",
    "/api/agents",
    "/api/wizard/catalogue",
    "/api/wizard/connection",
)


async def _workspace_scope(
    # ``Request``/``WebSocket`` annotated bare and defaulted to ``None``, so the
    # one dependency serves both kinds of connection. ``Optional[...]`` here is
    # **not** an option — it turns the parameter into a pydantic field and the
    # router refuses to build, which the terminal's WebSocket route would hit at
    # import.
    request: Request = None,  # type: ignore[assignment]
    websocket: WebSocket = None,  # type: ignore[assignment]
    workspace: Optional[str] = Query(
        default=None, alias=WORKSPACE_QUERY, include_in_schema=False
    ),
):
    """Resolve the request's workspace and enter the seam's scope for it.

    The router's **one** dependency, so no route can forget the field or spell
    it. It resolves the raw text through :func:`src.core.workspace.resolve`,
    keeps all three answers on the connection's ``state``, and enters the scope
    for the request — cleared afterwards, whatever the route did, including a
    streaming reply whose worker thread inherited a *copy* of the context.

    It **never refuses**: a 422 belongs where a folder is actually needed
    (:func:`require_workspace`), because the installation-scoped routes above
    must answer even when the folder a tab named has been deleted; and an
    invalid value is a sentence the caller deserves verbatim, not a status.

    There is no default folder: no surface answers about a folder it was not
    given, so an empty, absent or unusable one draws the seam's own sentence.
    """
    connection = request if request is not None else websocket
    # The **boot read**: a tab that remembers no folder has nothing to name, so
    # ``GET /api/workspace`` with no field answers about the installation folder
    # — the folder a new tab lands on. It is the one route that may be asked
    # without a field, because it is how the client learns which folder to name
    # next. The answer is the same ``Workspace`` every other request gets, and
    # the scope is entered for it.
    if workspace is None and connection.url.path == "/api/workspace":
        workspace = workspace_seam.installation()
    connection.state.workspace_raw = workspace
    resolved, refusal = workspace_seam.resolve(workspace)
    connection.state.workspace_refusal = refusal
    if resolved is None:
        # Named, and refused: **no scope is entered**. Entering one for another
        # folder would be the substitution nothing may do, and a workspace-scoped
        # route cannot get past ``require_workspace`` to use it anyway. An
        # installation-scoped route answers with no scope, which is exactly what
        # it needs to keep working about a folder that has gone.
        yield None
        return
    # ``workspace`` is what ``require_workspace`` hands a route: the folder this
    # request is about. A folder that was named and refused never reaches here.
    connection.state.workspace = resolved
    with workspace_seam.scope(resolved.root):
        yield resolved


def workspace_refusal(connection: Union[Request, WebSocket]) -> Optional[str]:
    """The sentence the connection's field drew, or ``None`` when it was accepted.

    The one reader of the resolver's refusal, so the routes that answer with a
    *status* (:func:`require_workspace`) and the one that answers with a socket
    close (the terminal) cannot describe the same wrong folder differently.
    """
    return getattr(connection.state, "workspace_refusal", None)


def require_workspace(connection: Union[Request, WebSocket]) -> workspace_seam.Workspace:
    """The resolved workspace of this request, or the refusal as a 422.

    Called by every **workspace-scoped** route and by no installation-scoped one.
    The sentence is the seam's — built once, in
    :func:`src.core.workspace.resolve`, so the same wrong folder is described the
    same way wherever it is asked about — and the status is this layer's choice,
    which is why the seam answers sentences and never statuses.

    It never substitutes a folder for the one that was refused: a caller that
    gets an exception has no answer at all, which is the point.
    """
    refusal = workspace_refusal(connection)
    if refusal:
        raise HTTPException(
            status_code=422,
            detail=refusal,
        )
    return connection.state.workspace


def build_router() -> APIRouter:
    """Create the API router."""
    # The router's **one** dependency: every route under this prefix resolves the
    # ``workspace`` field of its request and answers inside that scope, so no
    # route can forget the field, spell its name, or enter the scope itself — not
    # even the terminal's WebSocket, which carries it in its query string.
    # Refusing is :func:`require_workspace`'s job, not this one's.
    router = APIRouter(prefix="/api", dependencies=[Depends(_workspace_scope)])

    def _agent_row_for(mode: agent_modes.AgentMode) -> Dict[str, Any]:
        """The store's row for the agent a turn selected, as the seam wants it.

        The mode read and the row are the same source — the ``agents`` table —
        so one lookup answers what :func:`src.config.load_endpoints_config` and
        :func:`src.config.agent_connection_refusal` need.

        A mode with no row is answered as an agent with no model. That is
        reachable only for a reserved id, whose mode is rendered from code even
        when its row is gone; the connection then refuses with the sentence
        naming the agent, which is the honest answer rather than a silent one.
        """
        row, _findings = appdb.resolve_agent(mode.id)
        return row or {"id": mode.id, "label": mode.label, "modelId": None}

    def _load_config(agent: Dict[str, Any]) -> EndpointsConfig:
        """The connection **one agent** runs on, or the refusal a turn answers with.

        Two kinds of refusal, in the shape the client already renders: a
        ``ValidationError`` from a sampler column pydantic rejects keeps the 422
        field list, and everything :func:`src.config.agent_connection_refusal`
        names — no model, a model whose server row is missing, an unusable store
        — answers 422 with that one sentence.

        **A turn resolves once, at its start**: the caller holds this answer for
        the whole turn, so a settings save that lands mid-turn cannot split the
        reply that is streaming. That invariant is why the store's write routes
        are not gated on a streaming reply.
        """
        config, error = load_endpoints_config(agent)
        if isinstance(error, str):
            raise HTTPException(status_code=422, detail=error)
        if error is not None:
            raise HTTPException(
                status_code=422,
                detail=json.loads(error.json()),
            )
        assert config is not None
        return config

    def _store_block() -> Dict[str, Any]:
        """Is nojae's settings store usable, and the one sentence when it is not.

        The only thing the app bar says about the connection: whether *this* turn
        can run is the composer's business, because that is where the agent is
        chosen and where the fix is one click away. One warning in two places
        would mean two sentences to keep in step.
        """
        state = appdb.store_state()
        return {
            "usable": state["state"] == "ok",
            "sentence": None if state["state"] == "ok" else state["sentence"],
        }

    def _retry_budget_block() -> Dict[str, Any]:
        """The endpoint-wait budget the screen must be able to read.

        The pair this **run** was booted with (``--network-max-retry`` /
        ``--network-wait-for``, or the defaults). Read at call time, so what the
        screen shows is what the next refused round will spend.

        There is no "written value was unusable" note to carry: an unusable flag
        stops the boot, so a running app has nothing of the kind left to report.
        """
        max_retry, wait_seconds = network_fail_budget()
        return {"maxRetry": max_retry, "waitSeconds": wait_seconds}

    @router.get("/config")
    def get_config() -> Dict[str, Any]:
        """Everything the two views read about the connection, **per model**.

        ``{"models": [{id, name, serverId, serverName, serverUrl,
        supportsVision, contextWindow}], "store": {usable, sentence},
        "retryBudget": {maxRetry, waitSeconds}}``.

        A **list**, not one connection, and deliberately so: which model a view
        is looking at is the composer's answer, not this route's, so the vision
        flag and the occupancy gauge's context-window cap arrive with the model
        they describe rather than as "the" model's. Nothing here resolves an
        agent and nothing here invents a default model: an install with no
        models answers an empty list, and the app bar's store-level line says so.

        The ``retryBudget`` block is the effective pair the endpoint-wait guard
        reads at call time — what this run was booted with, the only source
        those two numbers have and so the only thing worth showing.
        """
        try:
            servers = appdb.load_servers()
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        models = [
            {
                "id": model["id"],
                "name": model["name"],
                "serverId": server["id"],
                "serverName": server["name"],
                "serverUrl": server["url"],
                "supportsVision": model["supportsVision"],
                # The occupancy gauge's cap: this model's context window
                # (meta.n_ctx), None when its server does not expose it.
                "contextWindow": _context_window(
                    server["url"], server["apiKey"] or "none", model["name"]
                ),
            }
            for server in servers
            for model in server["models"]
        ]
        return {
            "models": models,
            "store": _store_block(),
            "retryBudget": _retry_budget_block(),
        }

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

    # -- the servers and models routes -------------------------------------------

    def _connection_caps() -> Dict[str, Any]:
        """The numbers and words the form enforces, so none is spelled in the client.

        The sampler ranges and the reasoning levels are the same tables the request
        models above validate against — one authority, sent to the dialog so its
        fields and its refusals cannot disagree about a bound.
        """
        return {
            "samplerRanges": {
                field: {"min": low, "max": high}
                for field, (low, high) in SAMPLER_RANGES.items()
            },
            "reasoningLevels": list(REASONING_LEVELS),
        }

    def _connection_envelope(servers: List[Dict[str, Any]]) -> Dict[str, Any]:
        """The connection read's whole answer, for a read **and every write**.

        One envelope for both, so a write cannot blank the caps the form's
        bounds come from or the unassigned count the band's actionable line
        reads. ``caps`` is static; ``unassigned`` is re-derived because a server
        or model delete nulls the agents that pointed at it.
        """
        try:
            agents = appdb.resolve_agents()["agents"]
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {
            "servers": servers,
            "caps": _connection_caps(),
            "unassigned": {
                "agentsWithoutModel": sum(
                    1 for agent in agents if agent["modelId"] is None
                ),
                "agents": len(agents),
            },
        }

    def _connection_write(
        servers: Optional[List[Dict[str, Any]]], what: str, row_id: Optional[int]
    ) -> Dict[str, Any]:
        """One addressed server/model write's answer, mapped to its status.

        ``None`` from the store means the id named no row — the browser was working
        from a list that has since changed — which is a 404 naming it, the same
        shape the prompt-helper writes answer. A list is the new truth and is
        returned whole, in the read's envelope, so the dialog re-baselines on the
        server's rows rather than splicing the one it sent.
        """
        if servers is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"no row with id {row_id} — it cannot be {what}; "
                    "reload the servers."
                ),
            )
        return _connection_envelope(servers)

    def _require_free_server_name(name: str, servers: List[Dict[str, Any]],
                                  keep_id: Optional[int] = None) -> None:
        """422 naming ``name`` when another server already answers to it.

        The app refuses before the database does, in words: the ``UNIQUE``
        constraint stays the last line for the two-tabs-saving-at-once case, but
        the dialog's own mistake gets the dialog's own sentence. ``keep_id`` is
        the row being renamed, which may of course keep its name.
        """
        for server in servers:
            if server["id"] != keep_id and server["name"] == name:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"name: a server named {name!r} already exists — server "
                        "names are how the dialog tells them apart."
                    ),
                )

    def _require_free_model_name(server: Dict[str, Any], name: str,
                                 keep_id: Optional[int] = None) -> None:
        """422 naming ``name`` when that server already holds a model of it."""
        for model in server["models"]:
            if model["id"] != keep_id and model["name"] == name:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"name: {server['name']!r} already has a model named "
                        f"{name!r} — a model is chosen from its own server's list."
                    ),
                )

    @router.get("/servers")
    def get_servers() -> Dict[str, Any]:
        """Every server **with its models**, plus the caps and the unassigned count.

        ``{"servers": [{id, name, url, apiKey, models: [...]}], "caps": {...},
        "unassigned": {"agentsWithoutModel": n, "agents": n}}`` — servers in
        insertion order, each server's models in theirs. There is no separate
        model list and no "app defaults" surface: the nesting is the shape the
        dialog renders.

        The API key is in here on purpose — this route answers only the dialog
        that edits it. "Never to a connector, a log or a tool listing" is those
        surfaces' rule, and this route is not reachable from a tool, which
        ``tests/test_write_surface_isolation.py`` asserts.

        ``unassigned`` is the one cross-store line — "2 of 4 agents have no
        model" — so a fresh install's dialog can say every agent is unrunnable
        without the client holding two stores. It is a derived count: no agent's
        text leaves the server here.

        An unusable store is a 422 naming its path, never an empty list: the
        silent empty answer is the state this app refuses everywhere.
        """
        try:
            servers = appdb.load_servers()
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return _connection_envelope(servers)

    @router.post("/servers/add")
    def post_servers_add(body: ServerCreateIn) -> Dict[str, Any]:
        """Append one server and return the whole list.

        An **add**, not a fill: the new row's id is the store's to assign and
        comes back in the list. A duplicate name is a 422 naming the field.

        Not gated on a reply streaming: a turn resolves its connection once, at
        its start, so a server saved mid-turn cannot change what it says.
        """
        try:
            _require_free_server_name(body.name, appdb.load_servers())
            servers = appdb.add_server(body.name, body.url, body.apiKey)
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"servers": servers}

    @router.post("/servers/save")
    def post_servers_save(body: ServerUpdateIn) -> Dict[str, Any]:
        """Rewrite one server and return the whole list.

        Addressed by ``id`` — the handle the read hands out. Every field is
        written, so a cleared key clears; an id that names no row is a 404. No
        copy is kept: an update replaces a field the user can retype.
        """
        try:
            servers = appdb.load_servers()
            _require_free_server_name(body.name, servers, keep_id=body.id)
            written = appdb.update_server(body.id, body.name, body.url, body.apiKey)
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return _connection_write(written, "saved", body.id)

    @router.post("/servers/delete")
    def post_servers_delete(body: ServerDeleteIn) -> Dict[str, Any]:
        """Remove one server **and its models**, and return what is left.

        The cascade is the schema's, which is why this is the destructive write
        of the server routes: one delete takes the models under it with it and
        leaves every agent that pointed at one with no model. The whole store
        therefore lands in the app's dated backup folder first, through the same
        helper every file replacement already uses. An id that names no row is a
        404, and then nothing was destroyed and no copy was taken.
        """
        try:
            servers = appdb.delete_server(body.id)
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return _connection_write(servers, "deleted", body.id)

    @router.post("/models/add")
    def post_models_add(body: ModelCreateIn) -> Dict[str, Any]:
        """Append one model under its server and return the whole list.

        A ``serverId`` naming no row is a 404 naming it — the browser was adding
        a model to a server that has since been deleted. A duplicate name under
        that server is a 422 naming the field.
        """
        try:
            servers = appdb.load_servers()
            server = next((s for s in servers if s["id"] == body.serverId), None)
            if server is None:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        f"no server with id {body.serverId} — a model belongs to "
                        "one; reload the servers."
                    ),
                )
            _require_free_model_name(server, body.name)
            written = appdb.add_model(
                body.serverId, body.name, **_model_columns(body)
            )
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return _connection_write(written, "added", body.serverId)

    @router.post("/models/save")
    def post_models_save(body: ModelUpdateIn) -> Dict[str, Any]:
        """Rewrite one model and return the whole list.

        Every column but its server is written, so a cleared sampler clears to
        ``NULL`` and is omitted from the next request body — the same "member
        absent means" the file's reader held, now per column. A model is never
        moved between servers: that would silently re-point every agent running
        on it, and there is no route that asks for it.
        """
        try:
            servers = appdb.load_servers()
            row = next(
                (
                    model
                    for server in servers
                    for model in server["models"]
                    if model["id"] == body.id
                ),
                None,
            )
            if row is None:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        f"no model with id {body.id} — it cannot be saved; "
                        "reload the servers."
                    ),
                )
            server = next(s for s in servers if s["id"] == row["serverId"])
            _require_free_model_name(server, body.name, keep_id=body.id)
            written = appdb.update_model(body.id, body.name, **_model_columns(body))
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return _connection_write(written, "saved", body.id)

    @router.post("/models/delete")
    def post_models_delete(body: ModelDeleteIn) -> Dict[str, Any]:
        """Remove one model and return what is left.

        The agents pointing at it are **not** deleted: the schema nulls their
        ``model_id``, so each becomes unrunnable until it is given another rather
        than losing its persona. That is visible as the unassigned count above
        and the composer's warning, not as a silent failure. The store is copied
        first.
        """
        try:
            servers = appdb.delete_model(body.id)
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return _connection_write(servers, "deleted", body.id)

    # -- the workspace's own tools, reached only through the pool ---------------

    def _hub_pool(request: Request) -> hubpool.HubPool:
        """The app's one pool — the only thing a hub route reaches for tools.

        A hub is bound to a folder at birth, so a route that wanted "the" hub was
        asking a question with no answer: the pool is the only owner.
        """
        pool = getattr(request.app.state, "hubpool", None)
        if pool is None:
            raise HTTPException(
                status_code=503, detail="the workspace hub pool is not available"
            )
        return pool

    def _acquire_hub_set(request: Request) -> Tuple[Optional[Any], bool]:
        """This workspace's :class:`~src.core.hubpool.HubSet`, admitting it.

        ``(hub_set, built)``: the flag is the **visible restart** — true when
        this request is the one that brought the folder's tools up, so the panel
        can say its tools are coming back instead of leaving the tab to infer it
        from an empty list.

        Called from a **synchronous** route, which FastAPI runs in a worker
        thread: the admission is dispatched onto the pool's own loop and waited
        for here. An async route awaits :func:`_acquire_hub_set_async` instead —
        blocking the loop the admission runs on would be a deadlock.
        """
        resolved = require_workspace(request)
        pool = _hub_pool(request)
        acquired = pool.acquire_sync(resolved.root)
        if acquired.refusal is not None:
            raise HTTPException(status_code=429, detail=acquired.refusal)
        return acquired.hub_set, acquired.built

    async def _acquire_hub_set_async(
        request: Request,
    ) -> Tuple[Optional[Any], bool]:
        """:func:`_acquire_hub_set` for a route that already runs on the loop."""
        resolved = require_workspace(request)
        pool = _hub_pool(request)
        acquired = await pool.acquire(resolved.root)
        if acquired.refusal is not None:
            raise HTTPException(status_code=429, detail=acquired.refusal)
        return acquired.hub_set, acquired.built

    def _read_hub_set(request: Request) -> Tuple[Optional[Any], bool]:
        """The workspace's set **without admitting it** — a read asks, not builds.

        A folder someone only meant to browse must be left exactly as it was: no
        reserved folder, no connector process, no language-server index. So this
        reads the pool's already-live set (which may be none) and answers the
        ceiling's sentence when the pool could not admit the folder at all — the
        refusal a read is entitled to, without the write a read must not do.
        """
        resolved = require_workspace(request)
        pool = _hub_pool(request)
        refusal = pool.admission_refusal(resolved.root)
        if refusal is not None:
            raise HTTPException(status_code=429, detail=refusal)
        return pool.live(resolved.root), False

    def _mcp_payload(
        manager: Any,
        built: bool,
        extra_errors: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Connector list (live ``.nojae/mcp-settings.json`` scan) merged with manager status.

        Connectors are active on their file ``enable`` flag — the single source
        of truth. Secret material (``headers``/``env``) is stripped.

        The scan is a read of **the workspace in scope**, so the rows are this
        folder's declaration and the statuses come from this folder's manager —
        A's panel can never show B's connectors. ``manager`` is ``None`` when
        the folder has no live set, which is the honest "nothing is running
        here" answer rather than an empty list pretending to be a declaration.
        """
        statuses = {s["id"]: s for s in (manager.status() if manager else [])}
        connectors, errors = load_externals()
        if extra_errors:
            errors = errors + list(extra_errors)
        payload_connectors = []
        for connector in connectors:
            status = statuses.get(connector["id"], {})
            payload_connectors.append(
                {
                    key: value
                    for key, value in connector.items()
                    if key not in ("headers", "env")
                }
                | {
                    "active": connector["enable"],
                    "status": status.get("status", "stopped"),
                    "error": status.get("error"),
                }
            )
        return {
            "installed": bool(manager and manager.installed),
            "connectors": payload_connectors,
            "externalsError": "\n".join(errors) if errors else None,
            "built": built,
        }

    @router.get("/mcp")
    def get_mcp(request: Request) -> Dict[str, Any]:
        """List **this workspace's** declared MCP connectors with live status."""
        hub_set, built = _acquire_hub_set(request)
        return _mcp_payload(hub_set.mcp if hub_set else None, built)

    @router.post("/mcp")
    def post_mcp(body: McpIn, request: Request) -> Dict[str, Any]:
        """Activate MCP connectors for the Chat tab.

        Toggles write the entry ``enable`` flag back to the workspace's
        ``.nojae/mcp-settings.json`` (the only activation source) and
        start/stop the connector right away.

        There is no ``maxIterations`` in either direction: the tool-loop cap this
        route used to write is a per-agent column now.

        The declaration it writes is **the request's workspace's** — the path is
        built per call from the scope the router entered — and the connectors it
        hot-starts or stops are that workspace's own. Like every other
        ``enable``-flag write it is not gated on a streaming reply: a turn
        resolves its tools once, at its start.
        """
        hub_set, built = _acquire_hub_set(request)
        requested = [item.strip() for item in body.enabled if item.strip()]
        connectors, _errors = load_externals()
        connector_ids = {connector["id"] for connector in connectors}
        unknown = [item for item in requested if item not in connector_ids]
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown MCP connectors: {', '.join(unknown)}",
            )
        enabled = set(requested)
        write_errors = (
            set_externals_enabled({cid: cid in enabled for cid in connector_ids})
            if connector_ids
            else []
        )
        manager = hub_set.mcp if hub_set is not None else None
        if manager is not None and hasattr(manager, "start_connector"):
            for connector in connectors:
                connector_id = connector["id"]
                current = manager.connector_status(connector_id)
                if connector_id in enabled and current not in ("running", "starting"):
                    manager.start_connector(connector_id)
                elif connector_id not in enabled and current in ("running", "starting"):
                    manager.stop_connector(connector_id)
        return _mcp_payload(manager, built, extra_errors=write_errors)

    @router.post("/mcp/restart")
    async def post_mcp_restart(request: Request) -> Dict[str, Any]:
        """Restart **this workspace's** MCP hub: reconnect from its own declaration.

        Everything is torn down (client sessions and, with them, every local
        stdio child process) and rebuilt from a fresh scan of the declaration
        file, so an edit made by hand — a new connector, a changed ``command``,
        another ``cwd`` — takes effect without restarting the web app.
        Validation problems do not abort the restart: the connectors that did
        parse come back up and the errors are returned in ``externalsError``.

        The rebuild is the workspace's own: :meth:`src.core.hubpool.HubSet.restart_mcp`
        re-scans inside *that* folder's scope, so a restart in A leaves B's
        connectors, sessions and statuses exactly as they were. The gate is the
        per-workspace one too — only a reply streaming on **this** folder holds
        these connectors still.

        Awaited, so the response carries the real post-restart status (a failing
        connector burns its whole retry window — the button stays busy).
        """
        resolved = require_workspace(request)
        if _chat_streaming_on(resolved.root):
            raise HTTPException(
                status_code=409,
                detail=f"Cannot restart the MCP hub while a chat reply is streaming on {resolved.root}",
            )
        hub_set, _built = await _acquire_hub_set_async(request)
        manager = hub_set.mcp if hub_set is not None else None
        if hub_set is None or manager is None or not hasattr(manager, "restart"):
            raise HTTPException(status_code=503, detail="MCP hub is not available")
        await hub_set.restart_mcp()
        # The payload re-scans the file, so it re-derives the same validation
        # errors — they must not be passed as extra_errors or they appear twice.
        # ``built`` is true because this request really did rebuild the tools:
        # the flag means "these tools were just rebuilt", which an admission and
        # a restart both answer, and never "the list happens to be empty".
        return _mcp_payload(manager, True)

    def _lsp_payload(
        manager: Any,
        built: bool,
        extra_errors: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Language-server list (file scan + validation errors) + live status.

        A server is active when its ``enable`` flag says so — the one gate, the
        same answer ``_mcp_payload`` gives for a connector. Secret material
        (``env``) is stripped. There is no ``maxIterations`` here: the tool-loop
        cap is a per-agent column, not a hub setting.

        The scan reads **the workspace in scope** and the statuses come from
        that workspace's own manager, so A's panel lists A's servers and B's
        lists B's. A declared-but-unconnected server is still published from its
        declared tools (the manager answers that from its declaration), which is
        unchanged by being asked per workspace.
        """
        statuses = {s["id"]: s for s in (manager.status() if manager else [])}
        servers, errors = all_servers()
        if extra_errors:
            errors = errors + list(extra_errors)
        payload_servers = []
        for server in servers:
            status = statuses.get(server["id"], {})
            payload_servers.append(
                {
                    key: value
                    for key, value in server.items()
                    if key not in ("env", "initializationOptions")
                }
                | {
                    "active": server["enable"],
                    "status": status.get("status", "stopped"),
                    "error": status.get("error"),
                    "toolCount": status.get("toolCount", 0),
                }
            )
        return {
            "installed": bool(manager and manager.installed),
            "servers": payload_servers,
            "serversError": "\n".join(errors) if errors else None,
            "built": built,
        }

    @router.get("/lsp")
    def get_lsp(request: Request) -> Dict[str, Any]:
        """List **this workspace's** declared language servers with live status."""
        hub_set, built = _acquire_hub_set(request)
        return _lsp_payload(hub_set.lsp if hub_set else None, built)

    @router.post("/lsp")
    def post_lsp(body: LspIn, request: Request) -> Dict[str, Any]:
        """Activate language servers for the Chat tab.

        Activation writes one place: the ``enable`` flag of every declared entry
        in ``.nojae/lsp-settings.json`` — the declaration file is the only LSP
        gate, so a ticked row is the whole decision and the file is the record
        of it. Running servers are hot-started/stopped right away. There is no
        tool-loop cap here: that is a per-agent column, not an LSP setting.

        The declaration written is the **request's workspace's**, and the servers
        hot-started or stopped are that workspace's own; like the MCP toggle
        above, this write is never gated on a streaming reply.
        """
        hub_set, built = _acquire_hub_set(request)
        requested = [item.strip() for item in body.enabled if item.strip()]
        servers, _errors = all_servers()
        known_ids = {server["id"] for server in servers}
        unknown = [item for item in requested if item not in known_ids]
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown LSP servers: {', '.join(unknown)}",
            )
        enabled = set(requested)
        write_errors = (
            set_lsp_enabled({sid: sid in enabled for sid in known_ids})
            if known_ids
            else []
        )
        manager = hub_set.lsp if hub_set is not None else None
        if manager is not None and hasattr(manager, "start_server"):
            for server in servers:
                server_id = server["id"]
                current = manager.server_status(server_id)
                # Only ``running`` means "nothing to do": the hub treats a live
                # session or an in-flight attempt as a no-op, so a server stuck
                # in ``starting`` can be re-activated from the panel instead of
                # waiting for a full hub restart.
                if server_id in enabled and current != "running":
                    manager.start_server(server_id)
                elif server_id not in enabled and current in ("running", "starting"):
                    manager.stop_server(server_id)
        return _lsp_payload(manager, built, extra_errors=write_errors)

    @router.post("/lsp/restart")
    async def post_lsp_restart(request: Request) -> Dict[str, Any]:
        """Restart **this workspace's** LSP hub: respawn from its own declaration.

        Every language server of the folder the request names is shut down
        (``shutdown``/``exit``, then SIGTERM/SIGKILL) and respawned from a fresh
        scan of **that folder's** declaration file, so a hand-edited entry — a
        new server, a changed ``command``, another ``workspaceRoot`` — takes
        effect without restarting the web app. The one activation gate (the
        entry's ``enable`` flag) is re-applied exactly as at admission, so a
        declaration whose flags are all off stays dormant. Invalid entries never
        spawn: the valid ones come back up and the problems are reported in
        ``serversError``.

        The rebuild is the workspace's own
        (:meth:`src.core.hubpool.HubSet.restart_lsp`), so a restart in A leaves
        B's servers running and their statuses untouched, and the gate is the
        per-workspace one: only a reply streaming on **this** folder holds these
        servers still.

        Awaited, so the response carries real post-restart status (a cold
        language-server start is multi-second — the button stays busy).
        """
        resolved = require_workspace(request)
        if _chat_streaming_on(resolved.root):
            raise HTTPException(
                status_code=409,
                detail=f"Cannot restart the LSP hub while a chat reply is streaming on {resolved.root}",
            )
        hub_set, _built = await _acquire_hub_set_async(request)
        manager = hub_set.lsp if hub_set is not None else None
        if hub_set is None or manager is None or not hasattr(manager, "restart"):
            raise HTTPException(status_code=503, detail="LSP hub is not available")
        await hub_set.restart_lsp()
        # The payload re-scans the file, so it re-derives the same validation
        # errors — they must not be passed as extra_errors or they appear twice.
        # ``built`` true, for the same reason as the MCP restart above.
        return _lsp_payload(manager, True)

    @router.post("/lsp/query")
    def post_lsp_query(body: LspQueryIn, request: Request) -> Dict[str, Any]:
        """Answer one Editor-pane question about a buffer, as structured JSON.

        The Editor's code pane asks the hub one question at a time in the app's
        own vocabulary — ``status``, ``diagnostics``, ``definition``, ``hover``,
        ``references`` — and gets back the envelope ``core/lsphub/editor.py``
        defines: the answering server's id, a one-line reason when there is
        none, and the action's structured answer. No JSON-RPC crosses this
        boundary and no LSP method name appears in the browser; the hub stays
        the only thing that talks to a language server. The answer carries
        positions, hover text and diagnostic items, never file bytes — this is
        not a second file reader.

        ``diagnostics`` is answered from what the hub already holds, without
        waiting: a cold file answers "not analysed yet" rather than blocking.
        Waiting belongs to the model's tool, which has a deadline and a reader
        expecting an answer.

        A ``POST`` because the buffer's text travels with it when the buffer is
        dirty, and that can be large: a ``GET`` would put a megabyte in a query
        string. A plain ``def``, not ``async def``, so FastAPI runs it in a
        threadpool — the hub bridge blocks on a future, and blocking the event
        loop would stall every other request.

        It is a **read**: it names no write route, writes nothing, and is
        therefore not refused while a chat reply streams. A file no server
        claims is a quiet answer (``server: null`` with a reason), never an
        error — the gesture falls through to whatever Monaco would have done.

        The servers asked are **the tab's workspace's own**, so a pane on A
        never gets an answer out of B's index.
        """
        hub_set, _built = _acquire_hub_set(request)
        manager = hub_set.lsp if hub_set is not None else None
        if manager is None:
            # The hub is disabled in tests and in a hermetic e2e run: the pane
            # must degrade to the status quo, so this is the quiet envelope
            # rather than a 500.
            return {
                "status": "no_server",
                "server": None,
                "reason": "the language-server hub is not available",
                "action": body.action,
                "result": None,
            }
        position = None
        if body.line is not None and body.character is not None:
            position = {"line": body.line, "character": body.character}
        return manager.query_editor_sync(
            body.action,
            body.path,
            position=position,
            text=body.text,
            allowed_ids=_allowed_server_ids(body.lspEnabled),
        )

    def _policy_block(root: str) -> Dict[str, Any]:
        """What the workspace's policy file looks like, **read-only**.

        The pool seeds a default ``.nojae/read-write-policy.json`` when it admits
        a folder, so this reader must not write one: the app bar reads a folder
        far more often than the pool admits it, and a read that leaves a folder
        in someone's project is the mistake the seeding rules forbid. ``state``
        is ``existing`` / ``absent`` / ``failed`` here, and the app bar leaves
        ``absent`` as the plain fact it is.

        ``root`` is the folder being reported on, spelled by the caller.
        """
        return policy_seed.policy_file_state(root)

    def _mcp_settings_block(root: str) -> Dict[str, Any]:
        """What the workspace's MCP declaration file looks like, **read-only**.

        A reserved-folder reader: the MCP seed runs at admission, so a GET
        reports the file instead of leaving one behind. ``absent`` is a plain
        fact — a workspace whose seed failed has no MCP connectors, and the
        Settings → MCP panel says so.
        """
        return mcp_settings_file_state(root)

    def _lsp_settings_block(root: str) -> Dict[str, Any]:
        """What the workspace's LSP declaration file looks like, **read-only**.

        The declaration is hand-written — only its *template* is seeded (its
        entries are per-machine) — so this report is the panel's way to say
        "no language servers declared yet" and point at the template.
        """
        return lsp_settings_file_state(root)

    def _lsp_template_block(root: str) -> Dict[str, Any]:
        """What the workspace's LSP template file looks like, **read-only**.

        A reserved-folder reader: the template seed runs at admission, so a GET
        reports the file instead of leaving one behind. ``absent`` is a plain
        fact — the example is still committed, the workspace just lost the
        copy-me shortcut.
        """
        return lsp_settings_template_state(root)

    @router.get("/workspace")
    def get_workspace(request: Request) -> Dict[str, Any]:
        """Report **one workspace**: the folder, and the four reserved files in it.

        The app bar's only read of a folder, and the one the tab's field asks
        before adopting what it typed. Two tabs on two folders each see their own
        policy and their own declarations. It is a **read**: it validates and
        reports, and seeds nothing — a folder someone only meant to browse is
        left as it was.

        ``{"workspace", "default", "policy", "mcpSettings", "lspSettings",
        "lspSettingsTemplate", "hubs"}``: ``workspace`` is the resolved root,
        ``default`` the installation folder a new tab lands on, the four blocks
        the reserved folder's read-only state, and ``hubs`` the pool's answer
        about this folder — the two hub payloads of **this workspace's** own set
        plus :meth:`src.core.hubpool.HubPool.summary`.

        The hub half is a **read of the pool, not an admission**: this route is
        asked far more often than a folder is admitted, and admission seeds a
        reserved folder and starts processes. A folder whose tools are not alive
        is therefore answered with an empty catalogue and ``installed: false`` —
        a different answer from the ceiling's sentence, and the two must not be
        merged. The panel routes themselves do admit, which is where a returning
        tab's tools come back visibly.

        A folder that cannot be a workspace answers 422 with the seam's sentence
        and nothing else: no answer here is ever about a *different* folder. A
        folder the pool cannot admit answers 429 with the pool's sentence, from
        here as from the hub routes.
        """
        resolved = require_workspace(request)
        root = resolved.root
        hub_set, built = _read_hub_set(request)
        return {
            "workspace": root,
            "default": workspace_seam.installation(),
            "policy": _policy_block(root),
            "mcpSettings": _mcp_settings_block(root),
            "lspSettings": _lsp_settings_block(root),
            "lspSettingsTemplate": _lsp_template_block(root),
            "hubs": {
                "mcp": _mcp_payload(hub_set.mcp if hub_set else None, built),
                "lsp": _lsp_payload(hub_set.lsp if hub_set else None, built),
                "pool": _hub_pool(request).summary(),
            },
        }

    @router.get("/fs/tree")
    def get_fs_tree(request: Request, path: str = "") -> Dict[str, Any]:
        """One directory level of **this request's** workspace, for the Editor tab.

        ``path`` is relative to the folder the request named ("" is its root).
        One level per call keeps the first paint at one ``listdir`` however big
        the checkout is. All the rules live in ``core/editorfs``; this route
        only turns a :class:`~src.core.editorfs.policy.WorkspacePathError` into
        its HTTP status. This route reads — the write routes are browser-only.
        """
        # Asked before anything touches disk: a folder that was named and refused
        # answers 422 and is never browsed. The root itself is not an argument —
        # the scope this request entered is what ``core/editorfs`` resolves
        # against.
        require_workspace(request)
        try:
            return editorfs.list_dir(path)
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    @router.get("/fs/file")
    def get_fs_file(request: Request, path: str) -> Dict[str, Any]:
        """The whole text of one workspace-relative file, for the Editor tab.

        A name the tree pruned answers **404** here, never the policy refusal
        another surface would give it — a refusal would confirm the file exists.
        Past the size cap the answer is 413 naming the size; a binary file
        answers ``binary: true`` with no ``text`` key, so the pane can label it.

        ``mtime`` is the token both the save guard and the freshness probe
        compare: the client sends it back as ``ifUnmodifiedSince``, and a disk
        mtime that has moved answers 409 instead of overwriting someone else's
        change. This route reads; the write routes are browser-only.
        """
        require_workspace(request)
        try:
            return editorfs.read_file(path)
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    @router.get("/fs/search")
    def get_fs_search(
        request: Request,
        path: str = "",
        q: str = "",
        caseSensitive: bool = False,
        regex: bool = False,
    ) -> Dict[str, Any]:
        """Every match of one query inside one scope of **this request's** workspace.

        ``path`` is the scope and uses the tree's convention — "" meaning the
        whole workspace — so the row a gesture was made on is what gets searched.
        ``q`` defaults to "" so an unset query reaches the core's one-sentence
        refusal rather than a framework validation error.

        All the rules live in :func:`src.core.editorfs.search.search_workspace`
        (a search sees exactly what the tree shows); this route only turns the
        core's errors into their HTTP status: 400 for a bad pattern (carrying
        ``re``'s own message), 422 for a scope outside the workspace or refused
        by a lock, 404 for a scope that is absent or hidden. This route reads.
        """
        require_workspace(request)
        try:
            return editorfs.search_workspace(
                path, query=q, case_sensitive=caseSensitive, regex=regex
            )
        except editorfs.SearchQueryError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    @router.get("/fs/files")
    def get_fs_files(request: Request) -> Dict[str, Any]:
        """Every candidate path of the quick-open finder, for the whole workspace.

        Fetched once per dialog open and filtered per keystroke in the browser,
        so this is one bounded walk per open, not per keystroke. All the rules
        live in :func:`src.core.editorfs.quickopen.list_workspace_files` —
        notably that read-only paths are excluded: the finder is a shortcut to
        files you will *edit*. This route only transports the core's dict.
        """
        require_workspace(request)
        return editorfs.list_workspace_files()

    # -- the guarded write surface (browser-only) ------------------------------

    @router.put("/fs/file")
    def put_fs_file(request: Request, body: FileSaveIn) -> Dict[str, Any]:
        """One whole editor buffer, back to disk (``PUT /api/fs/file``).

        The rules all live in :func:`src.core.editorfs.files.write_file`,
        including the atomic temp-file + ``os.replace`` that keeps the file's
        mode and its exact bytes (CRLF included, no normalisation).

        Refused while a chat reply streams on **this request's** workspace: that
        reply may be editing these very files through its tools, so a save
        landing in the middle of one would race the model — and a reply
        streaming against another folder does not lock this one's files. The
        payload answers the new ``size``/``mtime`` so the caller re-baselines on
        the server's truth.

        This is a **browser** surface: no MCP connector, LSP tool or chat code
        path may call it, which ``tests/test_editorfs_write.py`` asserts.
        """
        # Asked before anything else: the folder is what the write resolves
        # against, and it is what the streaming refusal is about. Nothing below
        # re-reads it, so a save cannot answer about another folder.
        resolved = require_workspace(request)
        _refuse_if_chat_streaming("save", resolved.root)
        try:
            return editorfs.write_file(
                body.path, body.text, if_unmodified_since=body.ifUnmodifiedSince
            )
        except editorfs.WorkspaceSaveConflict as exc:
            # The object, not the sentence: the client offers reload-or-
            # overwrite, and that choice needs both numbers, not prose.
            raise HTTPException(status_code=exc.status_code, detail=exc.detail_object)
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    @router.post("/fs/create")
    def post_fs_create(request: Request, body: FileCreateIn) -> Dict[str, Any]:
        """One new file or folder inside the working location.

        The rules live in :func:`src.core.editorfs.mutate.create_path` — notably
        a policy-hidden parent answers 422, never the 404 a caller would read as
        "the name is free", and an occupied name is refused by ``O_EXCL`` rather
        than checked first, so no race can overwrite.

        Refused while a chat reply streams, like every other write. The payload
        answers ``path``/``dir``/``size``/``mtime`` — the shape a save answers,
        so the client re-baselines the new empty buffer on the server's truth.

        Browser-only, like every route under ``/fs`` that mutates disk.
        """
        resolved = require_workspace(request)
        _refuse_if_chat_streaming("create a file or folder", resolved.root)
        try:
            return editorfs.create_path(body.path, is_dir=body.dir)
        except editorfs.WorkspacePathExists as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail_object)
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    @router.delete("/fs/file")
    def delete_fs_file(request: Request, path: str) -> Dict[str, Any]:
        """One file or one whole folder, moved to the trash (``DELETE /api/fs/file``).

        The rules live in :func:`src.core.editorfs.mutate.trash_path`, including
        the **all-or-nothing subtree check**: one hidden or read-only descendant
        refuses the whole delete, naming that descendant, and nothing moves.

        Nothing is ``unlink``ed — a delete lands in ``.nojae/trash/<batch>/`` of
        the **request's** workspace, so one tab's bytes never file themselves
        inside another's reserved folder, and is swept after the retention days.
        That folder is reserved, so the pane cannot list it: a batch is restored
        with ``mv`` in a terminal.

        Refused while a chat reply streams, like every other write. The answer
        carries ``entries`` — the descendant count from the server's own walk —
        so the confirmation the UI already showed matches what happened.

        Browser-only, like every route under ``/fs`` that mutates disk.
        """
        resolved = require_workspace(request)
        _refuse_if_chat_streaming("delete a file or folder", resolved.root)
        try:
            return editorfs.trash_path(path)
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    @router.post("/fs/rename")
    def post_fs_rename(request: Request, body: FileRenameIn) -> Dict[str, Any]:
        """One path to another path — a rename, which is also a move.

        The rules live in :func:`src.core.editorfs.mutate.rename_path`, whose
        key one is that **both ends** go through the write gate — ``to`` plus
        every one of its ancestors, which is what refuses an innocent file
        moving into ``.git/…`` or the reserved folder. A cross-device move
        (``EXDEV``) is refused rather than copied.

        Refused while a chat reply streams, like every other write. Nothing is
        backed up here, deliberately: the bytes did not change and the trash
        plus git already describe the move. The payload answers
        ``from``/``to``/``dir``/``size``/``mtime`` so the caller can re-point
        its open buffers and re-baseline on the server's truth.

        Browser-only, like every route under ``/fs`` that mutates disk.
        """
        resolved = require_workspace(request)
        _refuse_if_chat_streaming("rename a file or folder", resolved.root)
        try:
            return editorfs.rename_path(body.frm, body.to)
        except editorfs.WorkspacePathExists as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail_object)
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    @router.post("/fs/move-batch")
    def post_fs_move_batch(request: Request, body: FileMoveBatchIn) -> Dict[str, Any]:
        """Several files into one existing folder — one request, or nothing moves.

        The rules live in :func:`src.core.editorfs.mutate.move_paths_batch`,
        which is ``rename_path``'s rules asked of every entry.

        The transaction is the **ordering**: every entry is validated before any
        of them is applied, so a refusal leaves the whole set at home. The apply
        loop itself is *not* atomic across paths — there is no filesystem
        transaction to borrow — and it owns that: it stops at the first
        ``OSError`` and the payload's ``moved`` array says exactly what landed
        instead of pretending the list did.

        Refused while a chat reply streams, like every other write. Nothing is
        backed up, as for a rename: the bytes did not change. The payload answers
        ``{"moved": [{"from", "to", "mtime"}…], "to_parent"}`` so the caller can
        re-point its open buffers and re-list the two folders it touched.

        Browser-only, like every route under ``/fs`` that mutates disk.
        """
        resolved = require_workspace(request)
        _refuse_if_chat_streaming("move files", resolved.root)
        try:
            return editorfs.move_paths_batch(body.paths, body.to_parent)
        except editorfs.WorkspacePathExists as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail_object)
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    @router.get("/fs/stat")
    def get_fs_stat(
        request: Request, path: List[str] = Query(default_factory=list)
    ) -> Dict[str, Any]:
        """``mtime``/``size``/``exists`` for a handful of exact paths.

        The freshness probe: the client names the files it has open, so nothing
        has to poll a tree or run a file watcher. Every path goes through the
        same gate as the tree, measured from the folder this request named.
        """
        require_workspace(request)
        try:
            return {"paths": editorfs.stat_paths(path)}
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    @router.get("/fs/status")
    def get_fs_status(request: Request) -> Dict[str, Any]:
        """Which files of **this request's** workspace git considers unstaged.

        One call for the whole tree (not one per row). A workspace that is not a
        git repository answers ``repo: false`` with an empty list — the silent,
        non-error case the UI is expected to ignore.

        Read-only like the rest of ``/api/fs``: ``GIT_OPTIONAL_LOCKS=0`` keeps
        even ``git status`` from touching the index on disk.
        """
        require_workspace(request)
        try:
            return editorfs.git_status()
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    @router.get("/fs/diff")
    def get_fs_diff(request: Request, path: str) -> Dict[str, Any]:
        """The two sides of one file: ``original`` as of ``HEAD``, ``modified``
        as it sits on disk.

        Returned as two texts rather than a patch so the editor renders the diff
        itself. The disk side goes through the same reader as the file read, so
        the size cap, the binary answer and the policy refusal are identical
        here. A file with no committed side (added, untracked) gets an empty
        ``original``.
        """
        require_workspace(request)
        try:
            return editorfs.file_diff(path)
        except editorfs.WorkspacePathError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    # -- terminal: one PTY per WebSocket ---------------------------------------

    @router.get("/terminal")
    def get_terminal(request: Request) -> Dict[str, Any]:
        """The live terminal sessions (pid, cwd, started, bytes) — for the
        settings panel. An orphan must be nameable, so whatever the registry
        holds is reported here; the shells themselves are driven by the WS,
        never by this route.

        One registry, every workspace: the sessions are the **app's**, not a
        folder's, so this lists them all and each row names the folder that
        session was **born in** — neither moves when a tab re-points.
        """
        # A workspace-scoped route, like every other one: a refused folder is
        # the seam's sentence, never a silent substitution.
        require_workspace(request)
        hub = getattr(request.app.state, "terminal", None)
        return {"sessions": hub.list_sessions() if hub is not None else []}

    @router.websocket("/terminal")
    async def terminal_ws(websocket: WebSocket) -> None:
        """One shell on one PTY, bridged to the browser's xterm pane.

        Guards, in order, each refusing *before* any process is spawned: the
        Origin check (the app has no CORS/CSRF layer, so this is the one cheap
        defence against a random page reaching a shell), **the workspace** (the
        router-level dependency resolves the folder the socket names), the
        driver check (a session needs an available pseudo-terminal driver —
        ``termhub.drivers``' capability answer, not a platform name), and the
        concurrent-session cap. A real shell can change anything the app's user
        can — which is why it is *never* an MCP or LSP tool, only this route,
        used by the SPA. The tools stay read-only; a shell is a human surface.

        A socket has no per-request body, so its folder arrives **when the
        socket opens**, as the same query parameter every workspace-scoped
        request carries. A live shell keeps the folder it was born in whatever
        the tab later points at: this route never re-roots, kills or relaunches
        an open session, and a **new** shell (this pane's reconnect) starts in
        the tab's current folder. The frame stream still carries no path: ``cd``
        inside the shell is the user's own business. The session owns the
        framing and teardown, this route only adapts the socket to it.
        """
        hub = getattr(websocket.app.state, "terminal", None)
        if hub is None:  # pragma: no cover - lifespan always sets it
            await websocket.close(termhub.CLOSE_CODE_UNSUPPORTED, "Terminal unavailable")
            return

        headers = {k.lower(): v for k, v in websocket.headers.raw}
        allowed, reason = term_policy.origin_allowed(headers)
        if not allowed:
            await websocket.close(
                termhub.CLOSE_CODE_POLICY, f"Origin refused: {reason}"
            )
            return

        # The folder this shell will be born in. A refused one is answered with
        # the seam's sentence — the same words the 422 routes use — in an
        # ``error`` frame (the pane's own error line) and as the policy close
        # reason. Nothing is reserved and nothing spawns: the refusal comes
        # before ``hub.create``, so the registry and the cap are untouched.
        refusal = workspace_refusal(websocket)
        if refusal:
            await websocket.accept()
            await websocket.send_json({"type": "error", "message": refusal})
            # A close reason is capped at 123 bytes by the protocol, so the
            # sentence is bounded here (`termhub.close_reason`) rather than
            # letting the close frame fail and the pane see a bare 1006.
            await websocket.close(
                termhub.CLOSE_CODE_POLICY, termhub.close_reason(refusal)
            )
            return

        if not term_drivers.driver_available():
            await websocket.accept()
            await websocket.send_json(
                {
                    "type": "error",
                    "message": termhub.NO_DRIVER_MESSAGE,
                }
            )
            await websocket.close(
                termhub.CLOSE_CODE_UNSUPPORTED, termhub.NO_DRIVER_MESSAGE
            )
            return

        if hub.is_full():
            await websocket.close(
                termhub.CLOSE_CODE_CAPACITY,
                f"Too many terminal sessions (cap {hub.capacity()})",
            )
            return

        # Publish a frame straight to the socket. Raises when the client is
        # gone, which the session's reader treats as "stop pumping".
        async def emit(event: Dict[str, Any]) -> None:
            await websocket.send_json(event)

        async def receive_frame():
            try:
                text = await websocket.receive_text()
            except (WebSocketDisconnect, RuntimeError):
                return None
            try:
                frame = json.loads(text)
            except (json.JSONDecodeError, ValueError):
                # Malformed frame: ignored by the session, not fatal.
                return {"type": ""}
            return frame if isinstance(frame, dict) else {"type": ""}

        try:
            session = hub.create(emit)
        except termhub.SessionCapacity as exc:
            await websocket.close(termhub.CLOSE_CODE_CAPACITY, str(exc))
            return

        await websocket.accept()
        try:
            # One session per connection: no attach, no reuse.
            session.spawn(cols=termhub.DEFAULT_COLS, rows=termhub.DEFAULT_ROWS)
        except (termhub.TerminalUnsupported, OSError) as exc:
            hub.drop(session.id)
            await websocket.send_json({"type": "error", "message": str(exc)})
            await websocket.close(termhub.CLOSE_CODE_UNSUPPORTED, "Could not spawn shell")
            return

        try:
            await session.run(receive_frame)
        finally:
            hub.drop(session.id)
            with suppress(Exception):
                await websocket.close()

    @router.get("/lsp/log")
    def get_lsp_log(request: Request, server: str = "") -> Dict[str, Any]:
        """Tail of one language server's log file (for the settings panel).

        The log is the **request's workspace's** server's: two workspaces can
        declare the same id, and the panel that shows one must not tail the
        other's file.
        """
        hub_set, _built = _acquire_hub_set(request)
        manager = hub_set.lsp if hub_set is not None else None
        if manager is None or not server:
            raise HTTPException(status_code=404, detail="No LSP log available")
        log = manager.log_tail(server) if hasattr(manager, "log_tail") else ""
        return {"server": server, "log": log}

    @router.get("/models")
    async def get_models(serverUrl: str = "", apiKey: str = "") -> Dict[str, Any]:
        """List models exposed by an OpenAI-compatible server URL."""
        url = serverUrl.strip()
        if not url:
            raise HTTPException(status_code=422, detail="No server URL provided")
        if not url.lower().startswith(("http://", "https://")):
            raise HTTPException(
                status_code=422, detail="Server URL must start with http:// or https://"
            )
        url = models_url(url)
        headers = {}
        if apiKey.strip():
            headers["Authorization"] = f"Bearer {apiKey.strip()}"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(url, headers=headers)
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Could not fetch models from {url}: {exc}",
            ) from exc
        return {"models": _model_ids(payload)}

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

    # -- the connector wizard's routes ------------------------------------------
    #
    # One dialog, two families, and every route here is **transport**: it resolves
    # the workspace and the connection, calls core, and turns the answer into a
    # status. No rule about the wizard lives in this file — the catalogue, the
    # scan, the two prompts and the three snippet checks each own their half, and
    # these functions only join them.
    #
    # What none of them may do: nothing here writes a declaration, starts a
    # connector or a language server, installs a package, or reaches a declaration
    # writer, a `/api/fs` write, the seeding path or a settings-store write.
    # Discovery therefore acquires no hub set either — the declared ids come from
    # the loaders directly, which is also why a folder the pool refused is still
    # scannable and still preparable.

    def _wizard_agent(agent_id: str) -> Dict[str, Any]:
        """The store's row for the agent the panel is showing, or a 422 naming it.

        Never a silent default agent: an id that names no row is a typo, and
        answering it with another agent would answer the user's question with the
        wrong one. The detail lists what *is* available, in the chat route's own
        words, with the field's name in front so the client can place it.
        """
        raw = (agent_id or "").strip()
        mode, _mode_findings = agent_modes.resolve_mode(raw)
        if mode is None:
            available = ", ".join(
                entry.id for entry in agent_modes.resolve_modes()["modes"]
            )
            raise HTTPException(
                status_code=422,
                detail=(
                    f"agentMode: unknown agent mode {raw!r}. "
                    f"Available: {available}"
                ),
            )
        return _agent_row_for(mode)

    def _wizard_connection(agent: Dict[str, Any]) -> wizard_core.modelstep.Connection:
        """The connection **this request** runs on, resolved once and held.

        Exactly the chat turn's rule: one resolution at the step's start, so a
        settings save landing mid-dialog cannot split it. The refusal is
        :func:`src.config.agent_connection_refusal`'s sentence, reused verbatim,
        and it costs 422 here because a dialog opened on a live button must not
        then answer with a model the user never chose.
        """
        config = _load_config(agent)
        models = config.model_list()
        if not models:
            raise HTTPException(
                status_code=400, detail="No models configured (ENDPOINT)"
            )
        return wizard_core.modelstep.Connection(
            model=models[0],
            server_url=config.serverUrl,
            api_key=config.apiKey,
            sampling=config.to_kwargs(),
        )

    def _wizard_names(
        agent: Dict[str, Any]
    ) -> Tuple[Optional[str], Optional[str]]:
        """``(model name, server name)`` for the header line, or ``(None, None)``.

        The read must answer even when the store is damaged — that is exactly the
        state in which the button has to explain itself rather than 500. So an
        unusable row, a model whose server is gone and an unopenable store all
        degrade to "this is not known", beside the refusal
        :func:`agent_connection_refusal` already answered with.
        """
        model_id = agent.get("modelId")
        if model_id is None:
            return None, None
        try:
            model = appdb.model_row(model_id)
            server = appdb.server_row(model["serverId"]) if model else None
        except appdb.AppStoreError:
            # The refusal already names the store's path; this read adds nothing
            # to it, and a 500 here would hide the sentence behind a stack trace.
            return None, None
        return (
            model["name"] if model else None,
            server["name"] if server else None,
        )

    def _wizard_declared() -> Dict[str, Any]:
        """This workspace's declared servers, as :func:`project_facts` wants them.

        Read from the two hubs' **loaders**, not from a hub set: the scan takes
        the declared ids as data (``editorfs`` must not import a hub — the LSP hub
        already reaches into ``editorfs.policy``), and joining them is exactly what
        a route is for. Nothing is started by reading a declaration, and a
        declaration file that does not exist is ``([], [])``, never an error.
        """
        connectors, _connector_errors = load_externals()
        servers, _server_errors = all_servers()
        return {
            "mcp": [connector["id"] for connector in connectors],
            "lsp": [
                {
                    "id": server["id"],
                    "extensions": list(server.get("extensions") or []),
                }
                for server in servers
            ],
        }

    def _wizard_facts() -> Dict[str, Any]:
        """The scan's derived facts about the folder this request named."""
        return editorfs.project_facts(_wizard_declared())

    def _wizard_declaration_path(family: str) -> Path:
        """The **absolute** path of the declaration file this family's entry
        belongs in, resolved through the family's own hub at call time.

        A :class:`pathlib.Path`, because page 3 needs both halves: the text to
        print and whether the file is there at all. Never created — a file that
        is missing is reported, not fixed.
        """
        return wizard_core.snippet.declaration_file(family)

    def _catalogue_entry(entry_id: Any) -> Dict[str, Any]:
        """One catalogue entry by id, or a 422 naming ``candidate``.

        The catalogue is the **only** source of a package name, so the entry is
        looked up again here rather than trusted from the request: a body that
        carried its own member could hand the model — and then the user — a
        command line no reviewer ever saw.
        """
        entries, notes = mcp_catalogue.load_catalogue()
        for entry in entries:
            if entry["id"] == entry_id:
                return entry
        reason = notes[0] if notes else "the catalogue holds no entry of that id"
        raise HTTPException(
            status_code=422,
            detail=f"candidate: unknown catalogue entry {entry_id!r} — {reason}",
        )

    def _catalogue_install(entry: Dict[str, Any]) -> Dict[str, str]:
        """The install lines the catalogue itself carries, per platform.

        The entry's ``requires`` group and nothing else: it is guidance, so it
        never becomes part of the member, and the app never invents a line of its
        own. ``any`` is the line where no platform differs, and a platform's own
        key beside it overrides that one.
        """
        requires = (entry.get("requirements") or {}).get("requires") or {}
        return {
            platform: item["install"]
            for platform, item in requires.items()
            if isinstance(item, dict) and isinstance(item.get("install"), str)
        }

    @router.get("/wizard/catalogue")
    def get_wizard_catalogue() -> Dict[str, Any]:
        """The committed MCP catalogue, for page 1's list — **installation-scoped**.

        No model runs and no folder is read, so a tab whose folder has been deleted
        can still open the wizard. A catalogue that cannot be read answers an empty
        list **and the sentence naming it**, never a silent empty list.
        """
        entries, notes = mcp_catalogue.load_catalogue()
        return {"entries": entries, "notes": notes}

    @router.get("/wizard/connection")
    def get_wizard_connection(agentMode: str = "") -> Dict[str, Any]:
        """What the dialog's header line and the buttons' gate are built from.

        **Installation-scoped**, like the catalogue above: a tab whose folder has
        gone must still be able to say who it would run as.

        Three **names** and one verdict travel; no ``api_key``, no URL and no
        sampler value, because the credential never leaves the server. ``canRun``
        false carries :func:`src.config.agent_connection_refusal`'s sentence
        verbatim — the chat route's and the app bar's own words, reused.
        """
        agent = _wizard_agent(agentMode)
        refusal = agent_connection_refusal(agent)
        model, server = _wizard_names(agent)
        return {
            "agentMode": agent["id"],
            "agent": agent.get("label") or agent["id"],
            "server": server,
            "model": model,
            "canRun": refusal is None,
            "refusal": refusal,
        }

    @router.get("/wizard/scan")
    def get_wizard_scan(request: Request) -> Dict[str, Any]:
        """The derived facts about **this request's** folder, and never its bytes.

        Every rule (the policy verdict per path, the allow-list, the cap, the
        one-level symlink rule) is
        :func:`src.core.editorfs.projectfacts.project_facts`'s — this route only
        fills in the declared ids, which the scan takes as data because
        ``editorfs`` must not import a hub.

        The field is asked for **first** (``require_workspace``), so a folder that
        was named and refused is the seam's 422 and never a scan of some other
        folder. Nothing is cached, so moving a tab's folder invalidates this answer
        by construction.
        """
        require_workspace(request)
        return {"facts": _wizard_facts()}

    @router.post("/wizard/propose")
    def post_wizard_propose(body: WizardProposeIn, request: Request) -> Dict[str, Any]:
        """The LSP flow's first step: the servers this folder lacks, best first.

        A **plain JSON post**, not SSE: one answer, no frames, no terminal event,
        nothing entering the stream layer. The connection is resolved once, from
        the agent the panel is showing, and held for this one call.

        A model step that failed answers **200** with its sentence — the client
        renders it and the user presses the button again — because a 5xx would read
        like the app's own fault. Only a bad request (an unknown agent, a folder
        that was refused) is a 4xx.
        """
        require_workspace(request)
        connection = _wizard_connection(_wizard_agent(body.agentMode))
        declaration_path = _wizard_declaration_path("lsp")
        answer = wizard_core.modelstep.propose(
            connection, _wizard_facts(), str(declaration_path)
        )
        return {**answer, "declarationPath": str(declaration_path)}

    @router.post("/wizard/prepare")
    def post_wizard_prepare(body: WizardPrepareIn, request: Request) -> Dict[str, Any]:
        """Both families' second step: the complete member, and page 3's verdict.

        The same resolution as the propose post — one call, one answer, a plain
        JSON body, no frames — then the three checks: the hubs' **own loader's**
        verdict, the command *resolved* (never spawned), and a duplicate id as a
        warning rather than a stop.

        Nothing is written: the declaration file is read (to warn and to name its
        path) and never touched, and no connector or language server is started.
        """
        resolved = require_workspace(request)
        family = (body.family or "").strip()
        if family not in wizard_core.prompts.FAMILIES:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"family: unknown wizard family {body.family!r} — expected "
                    f"one of {', '.join(wizard_core.prompts.FAMILIES)}"
                ),
            )
        connection = _wizard_connection(_wizard_agent(body.agentMode))
        declaration_path = _wizard_declaration_path(family)
        install: Dict[str, str] = {}
        if family == "mcp":
            # Which connector this is comes from the catalogue and nowhere else,
            # so the candidate is looked up here and the model is handed the
            # reviewed entry's own member group.
            entry = _catalogue_entry((body.candidate or {}).get("id"))
            candidate: Dict[str, Any] = dict(entry["member"])
            install = _catalogue_install(entry)
        else:
            candidate = dict(body.candidate or {})
        answer = wizard_core.modelstep.prepare(
            family, connection, candidate, _wizard_facts(), str(declaration_path)
        )
        # One **shape** whatever happened, so the dialog renders answers only:
        # a failed step answers the same keys as a prepared one, with the member
        # and the verdict empty. A second shape for the failure would put an
        # "which one is this" test in the template, which is the rule this
        # feature is built on not doing.
        page: Dict[str, Any] = {
            "family": family,
            "outcome": answer["outcome"],
            "sentence": answer["sentence"],
            "notes": answer["notes"],
            "declarationPath": str(declaration_path),
            "declarationExists": declaration_path.is_file(),
            "id": None,
            "member": None,
            "snippet": None,
            "accepted": None,
            "verdict": None,
            "verdictNotes": [],
            "readiness": None,
            "program": None,
            "searched": None,
            "install": install,
            "requiresInstall": False,
            "decisions": [],
            "duplicate": None,
            "valueForm": None,
            "valueWarning": None,
            "valueFindings": [],
            "offered": False,
        }
        prepared = answer["prepared"]
        if prepared is None:
            return page
        assessed = wizard_core.snippet.assess(
            family,
            prepared["id"],
            prepared["member"],
            declaration_path=declaration_path,
            # The catalogue's install lines win for MCP: they are reviewed data,
            # and the app inventing an install line is what must never happen.
            # LSP has no catalogue, so the model's own line stands.
            install=install or prepared["install"],
            workspace_root=resolved.root,
        )
        return {
            **page,
            "id": prepared["id"],
            "member": assessed["member"],
            "snippet": assessed["snippet"],
            "accepted": assessed["accepted"],
            "verdict": assessed["verdict"],
            "verdictNotes": assessed["notes"],
            "readiness": assessed["readiness"],
            "program": assessed["program"],
            "searched": assessed["searched"],
            "install": assessed["install"],
            "requiresInstall": prepared["requiresInstall"],
            "decisions": prepared["decisions"],
            "duplicate": assessed["duplicate"],
            "valueForm": assessed["valueForm"],
            "valueWarning": assessed["valueWarning"],
            "valueFindings": assessed["valueFindings"],
            "offered": assessed["offered"],
        }

    # -- the agents routes --------------------------------------------------------

    def _agent_payload() -> Dict[str, Any]:
        """The agent list in the shape both the dropdown and the dialog read.

        The store's rows as-is, plus the caps the dialog's form enforces so no cap
        is spelled in client code. Each row carries whether it can **run at all**
        (``modelId`` plus the resolved ``modelName``), so the composer's warning
        reads a field rather than re-deriving the rule from two tables. There is
        deliberately no ``default`` key: there is no server-side default agent, and
        a key that always answered "nothing" would be read as meaningful.

        ``deletable`` is a **flag** because ``readonly`` cannot answer it: the
        app's own rows refuse deletion, yet none of them is ``readonly``. Keeping
        it per-row is what lets the client offer the button without ever holding an
        agent id to compare against (``web/src`` names no reserved agent, and
        ``readonly`` stays the flag that disables a field).

        The read never raises: a damaged store answers 200 with the rows it could
        render plus its own findings, because the dropdown is the thing that has to
        stay usable.
        """
        resolved = appdb.resolve_agents()
        built_ins = set(appdb.built_in_agent_ids())
        agents = [
            {**agent, "deletable": agent["id"] not in built_ins}
            for agent in resolved["agents"]
        ]
        return {
            "agents": agents,
            "caps": agent_modes.caps(),
            "findings": resolved["findings"],
        }

    def _agent_write(
        agents: Optional[List[Dict[str, Any]]], what: str, agent_id: str
    ) -> Dict[str, Any]:
        """One addressed agent write's answer, mapped to its status.

        ``None`` from the store means the id named no row — the browser was working
        from a list that has since changed — which is a 404 naming it. A list is
        the new truth and is returned whole, so the dialog re-baselines on the
        server's rows rather than splicing the one it sent.
        """
        if agents is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"no agent with id {agent_id!r} — it cannot be {what}; "
                    "reload the agents."
                ),
            )
        return _agent_payload()

    def _require_usable_agent_fields(body: BaseModel, *, creating: bool) -> None:
        """422 naming the first field the core's rules refuse.

        The bounds live in :mod:`core.agent_modes`; this is the transport half, so
        the dialog gets a message it can put next to the input rather than a
        framework type error. A create must state its id and label; an update may
        omit either (an omitted field is "leave it alone").
        """
        agent_id = getattr(body, "id", "") or ""
        label = getattr(body, "label", None)
        if creating or agent_id:
            problem = agent_modes._mode_id_problem(agent_id)
            if problem is not None:
                raise HTTPException(
                    status_code=422,
                    detail=_agent_field_sentence(problem, "id"),
                )
        if label is not None:
            problem = agent_modes._label_problem(label)
            if problem is not None:
                raise HTTPException(
                    status_code=422,
                    detail=_agent_field_sentence(problem, "label"),
                )
        elif creating:
            raise HTTPException(
                status_code=422, detail=_agent_field_sentence(
                    "label must not be empty", "label"),
            )
        persona = getattr(body, "systemMessage", None)
        if persona is not None:
            problem = agent_modes._persona_problem(persona)
            if problem is not None:
                raise HTTPException(
                    status_code=422,
                    detail=_agent_field_sentence(problem, "systemMessage"),
                )
        cap = getattr(body, "maxToolIteration", None)
        if cap is not None:
            problem = agent_modes._tool_iteration_problem(cap)
            if problem is not None:
                raise HTTPException(
                    status_code=422,
                    detail=_agent_field_sentence(problem, "maxToolIteration"),
                )

    def _require_free_agent_label(label: str, agents: List[Dict[str, Any]],
                                  keep_id: Optional[str] = None) -> None:
        """422 naming ``label`` when another agent already answers to it.

        The app refuses before the database does, in words: the dialog creates an
        agent *by label* and derives the id from it, so a duplicate label is
        answered with the slug-collision message rather than a silent renumber —
        the ``UNIQUE`` constraint stays the last line for the
        two-tabs-saving-at-once case.
        """
        wanted = label.strip()
        for agent in agents:
            if agent["id"] != keep_id and agent["label"].strip() == wanted:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"label: an agent labelled {wanted!r} already exists — the "
                        "id is derived from the label, so this would collide with "
                        f"the existing agent {agent['id']!r}."
                    ),
                )

    @router.get("/agents")
    def get_agents() -> Dict[str, Any]:
        """Every agent the store holds, **read-only**, with its model and the caps.

        The composer's dropdown, the modes dialog's tabs and the hub panels'
        gray-out all read this one payload. ``readonly`` is the flag the client
        renders disabled fields from — as **data**, never by naming an id, which
        is what keeps a reserved agent's name out of ``web/src``.

        An unreadable store still answers **200** with the agents it could render
        plus the finding naming the path: a 4xx would hide the fix and leave the
        dropdown unrenderable.

        This answers *about* the store; it is not a way to read the database.
        There is no ``?path=``, no SQL and no file — and the store is itself
        invisible to ``/api/fs/*`` and to both connectors.
        """
        return _agent_payload()

    @router.post("/agents/add")
    def post_agents_add(body: AgentCreateIn) -> Dict[str, Any]:
        """Create one agent and return the whole list.

        Refused with a 422 naming the field for: an id outside the slug pattern, a
        duplicate id, a duplicate label (the slug-collision sentence), an empty
        label, a persona over the byte cap, or a tool-iteration cap below 1 — there
        is **no ceiling**.

        The new agent is always editable: ``readonly`` is not a body field, so no
        route may create one nojae owns.

        Not gated on a reply streaming, and deliberately so: a turn resolves its
        agent and connection once, at its start, so an agent saved mid-turn cannot
        change what that turn says.
        """
        _require_usable_agent_fields(body, creating=True)
        # A create refuses an absent label in words just above, so one is stated
        # by here: this is that invariant made readable, not a second refusal.
        label = body.label
        assert label is not None
        try:
            agents = _agent_payload()["agents"]
            if any(agent["id"] == body.id for agent in agents):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"id: an agent with the id {body.id!r} already exists — "
                        "the id is derived from the label, so pick another label."
                    ),
                )
            _require_free_agent_label(label, agents)
            written = appdb.add_agent(
                body.id,
                label,
                max_tool_iteration=(
                    body.maxToolIteration
                    if body.maxToolIteration is not None
                    else appdb.SEEDED_MAX_TOOL_ITERATION
                ),
                mcp_enable=body.mcpEnable if body.mcpEnable is not None else True,
                lsp_enable=bool(body.lspEnable),
                system_message=body.systemMessage or "",
                model_id=body.modelId,
            )
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return _agent_write(written, "added", body.id)

    @router.post("/agents/save")
    def post_agents_save(body: AgentUpdateIn) -> Dict[str, Any]:
        """Rewrite one agent and return the whole list.

        A **``readonly``** agent refuses every field but its model association,
        with the one sentence :func:`src.core.appdb.readonly_refusal` builds — the
        same sentence the delete route answers, so the client sees one refusal
        wherever it is reached from. That is checked by the field list the body
        actually supplied, not by a comparison against the stored values, so
        re-sending an unchanged label is still refused.

        ``modelId`` absent leaves the association alone and ``modelId: null``
        clears it — a legal save, and the reason an agent can be unrunnable.

        No copy is kept: an ``UPDATE`` replaces a field the user can retype.
        """
        _require_usable_agent_fields(body, creating=False)
        model_given = "modelId" in body.model_fields_set
        try:
            agents = _agent_payload()["agents"]
            label = body.label
            if label is not None:
                _require_free_agent_label(label, agents, keep_id=body.id)
            written = appdb.update_agent(
                body.id,
                label=label,
                max_tool_iteration=body.maxToolIteration,
                mcp_enable=body.mcpEnable,
                lsp_enable=body.lspEnable,
                system_message=body.systemMessage,
                **({"model_id": body.modelId} if model_given else {}),
            )
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return _agent_write(written, "saved", body.id)

    @router.post("/agents/delete")
    def post_agents_delete(body: AgentDeleteIn) -> Dict[str, Any]:
        """Remove one agent and return what is left.

        A **built-in** agent refuses deletion: nojae's own rows cannot be deleted,
        from the dialog or from the route, and the refusal names the agent. A
        user-created agent goes, and the whole store lands in the app's dated
        backup folder first, through the same helper and the same retention sweep
        every file replacement already uses.

        An id that names no row is a 404, and then nothing was destroyed and no
        copy was taken.
        """
        try:
            written = appdb.delete_agent(body.id)
        except appdb.AppStoreError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return _agent_write(written, "deleted", body.id)

    @router.post("/chat")
    async def post_chat(body: ChatIn, request: Request) -> StreamingResponse:
        """Stream one chat reply from the turn's agent's model as SSE.

        **The turn resolves once, at its start**: the agent's row, the connection
        built from its model and server, and the tool-loop cap are all read *here*,
        before the worker is handed anything. A settings save that lands mid-turn
        therefore cannot split the reply that is streaming, which is what makes the
        store's write routes safe without the "refused while a chat reply streams"
        gate the Editor's writes carry.

        The sync LLM client runs in a worker thread feeding an ``asyncio.Queue``
        (project convention: sync client in a thread + ``emit``); the SSE generator
        polls the queue and disconnect, closing the upstream stream via
        ``cancel_event`` when the client goes away.

        While the reply streams, its events are also *pausable*: the handle
        registered here lets the pause route arm ``pause_event``, which
        ``core.chat.stream_chat`` checks at its next message boundary.

        **The turn is workspace-scoped**: the folder the request names is the one
        whose ``AGENTS.md`` is injected and whose tools are offered, so a folder
        that was named and refused is a 422 here rather than an answer about
        somebody else's project.

        **The reply occupies its workspace's slot, not the process's**: the pause
        handle and the in-flight bookkeeping are keyed by the folder this request
        named, so a turn on A neither blocks a write on B nor is paused by B's tab.
        Two workspaces therefore stream at the same time, and nothing here queues
        them.
        """
        # Asked first: a turn must not arm the pause handle for a workspace that
        # was refused, and the project-instructions block read below is the
        # scope this request entered.
        resolved = require_workspace(request)
        # The active agent mode contributes exactly two things to the system
        # message: its persona replaces the model's own ``sys_prompt``, and its
        # generated blocks append after AGENTS.md. It is resolved **per request**,
        # so a change lands on the *next* turn of an existing conversation, the
        # same way an AGENTS.md edit does.
        mode, _mode_findings = agent_modes.resolve_mode(body.agentMode)
        if mode is None:
            # Unknown id → 422 naming it, never a silent fall back to another
            # agent: the only way to reach here is a typo — in a stale tab after
            # a rename, or in a hand-made request — and a default would answer
            # the user's question with the wrong agent and no clue. The detail
            # lists what *is* available so the fix is in the message. (A *missing*
            # id never reaches here: the request model refuses it, because there
            # is no server-side default this branch could fall back to.) Raised
            # before the pause handle is armed and before the SSE generator
            # exists — a request that never streams must not own the handle a
            # later request needs.
            available = ", ".join(
                entry.id for entry in agent_modes.resolve_modes()["modes"]
            )
            raise HTTPException(
                status_code=422,
                detail=f"Unknown agent mode {body.agentMode!r}. "
                       f"Available: {available}",
            )
        # The **agent's row** is what says which model answers this turn: the mode
        # names the persona, and the store's row of the same id carries the
        # `model_id` and the cap — one table, so one lookup answers everything the
        # turn needs.
        agent = _agent_row_for(mode)
        config = _load_config(agent)
        models = config.model_list()
        if not models:
            raise HTTPException(status_code=400, detail="No models configured (ENDPOINT)")
        # An empty persona means "use the configured prompt" — the escape hatch
        # for an agent that wants the model's own prompt back.
        persona = mode.system_message or config.sysprompt

        messages = [m.payload() for m in body.messages]
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        cancel_event = threading.Event()
        pause_event = threading.Event()
        # **The turn's tools are resolved once, at its start**, beside its agent
        # and its connection: the workspace's own set, admitted by this request
        # because a turn is the clearest possible sign that a tab is working on
        # that folder. A folder the pool cannot serve is refused here — before the
        # pause handle is armed — rather than running the turn with nobody's tools.
        hub_set, _built = await _acquire_hub_set_async(request)
        _arm_chat_handle(resolved.root, cancel_event, pause_event)
        # The same mode decides the hub gate: a mode whose flag is false
        # contributes no tool schemas to the request at all, so the persona and
        # the affordance can never disagree. Order of the three levels does not
        # matter — they intersect.
        tool_kwargs = _chat_tool_kwargs(
            hub_set, body.mcpEnabled, body.lspEnabled, mode=mode, agent=agent
        )
        # The skills catalogue is resolved **here** too — once, at the turn's
        # start — so a skill folder edited mid-turn cannot split this reply. The
        # gate is evaluated **before** the scan: a turn with no way to open a file
        # must not walk two folder trees and read every header it finds in order to
        # throw the result away, so a refusal forwards ``""`` and never touches the
        # file system. When it says yes, the scan and the render run now and are
        # never cached — the same freshness AGENTS.md has: edit a SKILL.md and the
        # next message sees it. No exception is caught around the scan: it cannot
        # raise over a damaged input, and the workspace seam cannot raise here — a
        # silent catch would turn a real bug into a turn that quietly has no
        # catalogue.
        skills_block = ""
        if turn_can_open_a_file(tool_kwargs):
            found_skills, _skill_findings = skills_core.scan()
            skills_block = skills_core.catalogue_block(found_skills)
        # The MCP names the gate read are the merge's own bookkeeping, not a
        # ``stream_chat`` keyword: out of the dict before the splat below, or
        # every tool-capable turn would arrive with an unexpected argument.
        tool_kwargs.pop(MCP_TOOL_NAMES_KWARG, None)

        def emit(event: Any) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, event)

        async def pump() -> None:
            try:
                await asyncio.to_thread(
                    stream_chat,
                    messages,
                    models[0],
                    config.serverUrl,
                    emit,
                    config.to_kwargs(),
                    cancel_event=cancel_event,
                    pause_event=pause_event,
                    api_key=config.apiKey or "none",
                    # The mode's persona, or the configured prompt when the mode
                    # declares none: the two are alternatives, never stacked.
                    sysprompt=persona,
                    # The wait's budget **accessor**, not its numbers: they are
                    # read when a refused round is about to be waited on, never at
                    # the turn's start, and ``core/`` reads no run configuration —
                    # so the route hands over the reader, which answers this
                    # process's boot flags. It is the *module* function, not this
                    # route's local ``config``.
                    retry_budget=network_fail_budget,
                    # Keywords from here on: the flag pair is optional on
                    # ``stream_chat``, so a stub may omit it (tests do).
                    # Project instructions ride on the system message: when the
                    # working location carries AGENTS.md, its text is appended
                    # there so every conversation starts already knowing the
                    # project's conventions.
                    agent_instructions=agent_instructions_block(),
                    # The skills catalogue rides beside it, as its own keyword and
                    # **unconditionally**: ``""`` is already the "nothing to inject"
                    # answer the other blocks use, so the gate above needs no
                    # conditional shape here — and none may have one, because a
                    # conditional is the shape a switch takes. The value is the
                    # server's own decision, computed above from the tool set this
                    # turn was already given, so no request body, stored row or
                    # caller can ask for a catalogue or waive one.
                    skills_instructions=skills_block,
                    # The mode's generated blocks (only the reserved Todo builder
                    # has any) join after them, and are passed only when present —
                    # same conditional shape as ``batch_instructions`` below, so a
                    # request whose mode has no blocks keeps the call shape the
                    # existing chat tests stub.
                    **({"mode_instructions": "\n\n".join(mode.instructions)}
                       if mode.instructions else {}),
                    # The lot's big picture (batch mode only) rides alongside
                    # the project instructions, never merged into ``sysprompt``:
                    # that separation is what keeps the TOOL_NOTICE word check
                    # judging only the prompt the user configured. It is passed
                    # only when set, so a plain chat request keeps exactly the
                    # call shape it always had.
                    **({"batch_instructions": body.batchContext}
                       if body.batchContext else {}),
                    **tool_kwargs,
                )
            except Exception as exc:  # noqa: BLE001 — surface any failure to the UI
                emit({"event": "error", "message": str(exc)})
            finally:
                emit(None)  # sentinel: worker finished

        task = asyncio.create_task(pump())
        # Keyed with the workspace, so the question the hub restarts ask is
        # "is a reply streaming *here*". The dict is also what keeps the task
        # alive: the event loop holds only weak references to bare tasks.
        _CHAT_TASKS[task] = resolved.root
        task.add_done_callback(lambda _done: _CHAT_TASKS.pop(task, None))

        async def event_stream() -> AsyncIterator[str]:
            seq = 0
            try:
                while True:
                    if await request.is_disconnected():
                        return
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=0.25)
                    except asyncio.TimeoutError:
                        continue
                    if item is None:
                        return
                    yield sse_format(seq, item)
                    seq += 1
                    if item.get("event") in ("done", "error", "pause_ack"):
                        return
            finally:
                # Client gone (or terminal event): stop the worker thread,
                # which closes the upstream LLM stream.
                cancel_event.set()
                _clear_chat_handle(resolved.root, cancel_event)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    @router.post("/chat/pause", status_code=200)
    async def post_chat_pause(request: Request) -> Dict[str, Any]:
        """Ask the one in-flight chat reply to stop at its next boundary.

        The worker closes the upstream stream, reports its exact usage and
        terminates the reply with ``pause_ack``, so the client keeps the partial
        turn in its history. Idempotent — a second call while the first is pending
        says so.

        The client sends this tab's workspace with it, so the handle read here is
        the one armed by a chat post naming the same folder: a reply streaming on
        another workspace is not this request's to stop.
        """
        resolved = require_workspace(request)
        handle = _chat_reply_handle(resolved.root)
        if handle is None:
            # A fact about **this** folder, named as such: another tab's reply
            # makes "no chat reply is streaming" false for the process but never
            # for the workspace this request asked about.
            raise HTTPException(
                status_code=409,
                detail=f"No chat reply is streaming on {resolved.root}",
            )
        if handle.pause_event.is_set():
            return {"paused": "pending"}
        handle.pause_event.set()
        return {"paused": "requested"}

    return router

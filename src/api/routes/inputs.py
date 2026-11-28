"""The request bodies the API accepts, and the rules they enforce."""

import base64
import binascii
import re
from typing import Any, Dict, List, Literal, Optional, Union, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from src.core import agent_modes
from src.core import batch as batch_core
from src.core import prompt_helpers
from src.core.llmkit.sanitize import sanitize_content
from src.core.models import ReasoningEffort


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


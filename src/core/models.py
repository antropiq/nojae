from typing import Any, Dict, List, Literal, Mapping, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

ReasoningEffort = Literal["off", "low", "medium", "high", "xhigh"]

DEFAULT_LLM_SYSPROMPT = "You are a helpful assistant."

SAMPLING_FIELDS = (
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "repeat_penalty",
    "presence_penalty",
    "reasoning_effort",
)


class SamplingParams(BaseModel):
    """Sampling parameters as an OpenAI-compatible server's request-body parameters.

    Config keys (``temp``, ``top-p``, ...) are accepted as aliases; values
    may be strings or numbers and are coerced by pydantic.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    temperature: Optional[float] = Field(default=None, alias="temp")
    top_p: Optional[float] = Field(default=None, alias="top-p")
    top_k: Optional[int] = Field(default=None, alias="top-k")
    min_p: Optional[float] = Field(default=None, alias="min-p")
    repeat_penalty: Optional[float] = Field(default=None, alias="repeat-penalty")
    presence_penalty: Optional[float] = Field(default=None, alias="presence-penalty")
    reasoning_effort: Optional[ReasoningEffort] = Field(default=None, alias="reasoning")

    @field_validator("reasoning_effort", mode="before")
    @classmethod
    def _normalize_reasoning(cls, value: Any) -> Any:
        if isinstance(value, str):
            value = value.strip().lower()
            if not value:
                return None
        return value

    def to_kwargs(self) -> Dict[str, Any]:
        """Return only the sampling parameters as request-body kwargs."""
        return self.model_dump(include=set(SAMPLING_FIELDS), exclude_none=True)


class EndpointsConfig(SamplingParams):
    """The model connection one agent runs on, as the store's two rows describe it."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    serverUrl: str = ""
    apiKey: str = ""
    endpoint: Optional[str] = None
    sysprompt: str = DEFAULT_LLM_SYSPROMPT
    supports_vision: bool = False

    @field_validator("endpoint", mode="before")
    @classmethod
    def _strip_endpoint(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @classmethod
    def from_store(
        cls,
        server: Optional[Mapping[str, Any]],
        model: Optional[Mapping[str, Any]],
    ) -> "EndpointsConfig":
        """Build the configuration from the store's server and model rows.

        ``server`` and ``model`` are the rows ``core.appdb`` hands out, which
        carry the **payload** names (``url``, ``apiKey``, ``sysPrompt``,
        ``topP``, …) because §4.2 puts the column-name translation in that
        module. The few names that are still not this model's fields — the
        server's ``url``, the model's ``name`` — are the store's own vocabulary
        for a thing this model calls by the request's name, and they are mapped
        here, once.

        The values reach pydantic **as the row holds them**: native
        ``True`` / ``0.2`` / ``20``, no string-parsing shim.

        The "absent means" table is unchanged, with a nullable **column**
        standing in for an absent member: a ``NULL`` sampler stays ``None`` so
        ``to_kwargs()`` **omits** it from the request body, while a ``0`` column
        keeps it. The two are different values and must not converge — which is
        why the schema gives those columns no default (§4.2). An empty
        ``sysPrompt`` is ``DEFAULT_LLM_SYSPROMPT``, an absent
        ``supportsVision`` is ``False``.

        A row that is ``None`` is neither a crash nor a guess: it is the state
        the resolution seam refuses (D7), so this builder answers a valid empty
        configuration — no server, no model — for a caller that has already
        decided to refuse. That is the reachable shape of a model naming a
        server row that is not there, which only a hand-edited database
        produces.
        """
        server = server or {}
        model = model or {}

        def member(source: Mapping[str, Any], name: str, default: Any = None) -> Any:
            value = source.get(name)
            if isinstance(value, str):
                value = value.strip()
            return default if value is None else value

        data: Dict[str, Any] = {
            "serverUrl": member(server, "url", ""),
            "apiKey": member(server, "apiKey", ""),
            "endpoint": member(model, "name"),
            "sysprompt": member(model, "sysPrompt") or DEFAULT_LLM_SYSPROMPT,
            "supports_vision": bool(member(model, "supportsVision", False)),
            "temperature": member(model, "temperature"),
            "top_p": member(model, "topP"),
            "top_k": member(model, "topK"),
            "min_p": member(model, "minP"),
            "repeat_penalty": member(model, "repeatPenalty"),
            "presence_penalty": member(model, "presencePenalty"),
            "reasoning": member(model, "reasoning"),
        }
        return cls.model_validate(data)

    def model_list(self) -> List[str]:
        """Return the tested model names."""
        return [self.endpoint] if self.endpoint else []

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
    """The model connection of one workspace, as its settings file describes it."""

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
    def from_workspace(
        cls,
        workspace: Mapping[str, Any],
    ) -> "EndpointsConfig":
        """Build the configuration from the workspace's settings file.

        ``workspace`` is the mapping ``core.workspace_settings`` read from
        ``<working location>/.nojae/nojae-settings.json``. It is passed to
        pydantic **as the file holds it** — native ``True`` / ``0.2`` / ``20``
        — because ``SamplingParams`` already coerces numbers and validates
        ``reasoning``, so this builder needs no string-parsing shim of its own
        (spec D6). Every member name of that file is already a field name of
        this model, which is why there is no member-to-field table here.

        A member *absent* means what the spec's key map says it means, not
        "off" or "zero": an absent ``temperature`` stays ``None`` so
        ``to_kwargs()`` omits it from the request body, an absent
        ``supportsVision`` is ``False``, an absent ``sysprompt`` is
        ``DEFAULT_LLM_SYSPROMPT``. An empty mapping is therefore a valid
        configuration with no server and no model — which is how a workspace
        whose file is absent or malformed reaches a caller that has already
        decided to refuse (the reader reports that state; this builder does
        not second-guess it).
        """
        def member(name: str, default: Any = None) -> Any:
            value = workspace.get(name)
            if isinstance(value, str):
                value = value.strip()
            return default if value is None else value

        data: Dict[str, Any] = {
            "serverUrl": member("serverUrl", ""),
            "apiKey": member("serverApiKey", ""),
            "endpoint": member("endpoint"),
            "sysprompt": member("sysprompt") or DEFAULT_LLM_SYSPROMPT,
            "supports_vision": bool(member("supportsVision", False)),
            "temperature": member("temperature"),
            "top_p": member("topP"),
            "top_k": member("topK"),
            "min_p": member("minP"),
            "repeat_penalty": member("repeatPenalty"),
            "presence_penalty": member("presencePenalty"),
            "reasoning": member("reasoning"),
        }
        return cls.model_validate(data)

    def model_list(self) -> List[str]:
        """Return the tested model names."""
        return [self.endpoint] if self.endpoint else []

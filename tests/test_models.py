import pytest
from pydantic import ValidationError

from src.core.models import (
    DEFAULT_LLM_SYSPROMPT,
    EndpointsConfig,
    SamplingParams,
)


class TestSamplingParams:
    def test_full_config_string_values_coerced(self):
        p = SamplingParams.model_validate({
            "temp": "1.0",
            "top-p": "0.95",
            "top-k": "20",
            "min-p": "0",
            "repeat-penalty": "1.0",
            "presence-penalty": "0",
        })
        assert p.to_kwargs() == {
            "temperature": 1.0,
            "top_p": 0.95,
            "top_k": 20,
            "min_p": 0.0,
            "repeat_penalty": 1.0,
            "presence_penalty": 0.0,
        }

    def test_numeric_values_pass_through(self):
        p = SamplingParams.model_validate({"temp": 0.7, "top-k": 40})
        assert p.to_kwargs() == {"temperature": 0.7, "top_k": 40}

    def test_missing_keys_excluded(self):
        assert SamplingParams.model_validate({}).to_kwargs() == {}
        assert SamplingParams.model_validate({"temp": "0.5"}).to_kwargs() == {
            "temperature": 0.5
        }

    def test_invalid_value_raises(self):
        with pytest.raises(ValidationError):
            SamplingParams.model_validate({"top-p": "O.95"})

    def test_top_k_rejects_non_integer(self):
        with pytest.raises(ValidationError):
            SamplingParams.model_validate({"top-k": "abc"})

    def test_reasoning_mapped_and_normalized(self):
        p = SamplingParams.model_validate({"reasoning": "Medium"})
        assert p.to_kwargs() == {"reasoning_effort": "medium"}

    def test_reasoning_off_and_xhigh_valid(self):
        assert SamplingParams.model_validate(
            {"reasoning": "off"}
        ).to_kwargs() == {"reasoning_effort": "off"}
        assert SamplingParams.model_validate(
            {"reasoning": "xhigh"}
        ).to_kwargs() == {"reasoning_effort": "xhigh"}

    def test_invalid_reasoning_raises(self):
        with pytest.raises(ValidationError):
            SamplingParams.model_validate({"reasoning": "ultra"})

    def test_empty_reasoning_treated_as_absent(self):
        assert SamplingParams.model_validate({"reasoning": "  "}).to_kwargs() == {}

    def test_canonical_names_accepted(self):
        p = SamplingParams.model_validate({"temperature": 0.3})
        assert p.to_kwargs() == {"temperature": 0.3}


class TestEndpointsConfig:
    def test_parses_real_world_shape(self):
        cfg = EndpointsConfig.model_validate({
            "serverUrl": "http://127.0.0.1:8080/v1",
            "endpoint": "qwen3.8-flash-next-iq3_xxs",
            "temp": "0.2",
            "top-p": "0.95",
            "top-k": "20",
            "min-p": "0",
            "repeat-penalty": "1.0",
            "presence-penalty": "0",
            "reasoning": "low",
        })
        assert cfg.serverUrl == "http://127.0.0.1:8080/v1"
        assert cfg.model_list() == ["qwen3.8-flash-next-iq3_xxs"]
        assert cfg.to_kwargs() == {
            "temperature": 0.2,
            "top_p": 0.95,
            "top_k": 20,
            "min_p": 0.0,
            "repeat_penalty": 1.0,
            "presence_penalty": 0.0,
            "reasoning_effort": "low",
        }

    def test_to_kwargs_excludes_config_fields(self):
        cfg = EndpointsConfig.model_validate({
            "serverUrl": "http://x",
            "endpoint": "m",
        })
        assert cfg.to_kwargs() == {}

    def test_single_endpoint_string(self):
        cfg = EndpointsConfig.model_validate({"endpoint": "my-model"})
        assert cfg.model_list() == ["my-model"]

    def test_blank_endpoint_ignored(self):
        cfg = EndpointsConfig.model_validate({"endpoint": "  "})
        assert cfg.endpoint is None
        assert cfg.model_list() == []

    def test_empty_config(self):
        cfg = EndpointsConfig.model_validate({})
        assert cfg.serverUrl == ""
        assert cfg.model_list() == []

    def test_unknown_keys_ignored(self):
        cfg = EndpointsConfig.model_validate({"serverUrl": "u", "bogus": 1})
        assert cfg.serverUrl == "u"

    def test_invalid_sampling_raises(self):
        with pytest.raises(ValidationError):
            EndpointsConfig.model_validate({"temp": "hot"})


def server_row(**overrides) -> dict:
    """A ``servers`` row as :mod:`src.core.appdb` hands it out (payload names)."""
    row = {"id": 1, "name": "Local", "url": "http://host:8080/v1", "apiKey": ""}
    row.update(overrides)
    return row


def model_row(**overrides) -> dict:
    """A ``models`` row as the store hands it out, with every column present."""
    row = {
        "id": 1,
        "serverId": 1,
        "name": "model-a",
        "sysPrompt": "Answer briefly.",
        "temperature": 0.2,
        "topP": 0.95,
        "topK": 20,
        "minP": 0,
        "repeatPenalty": 1.0,
        "presencePenalty": 0,
        "reasoning": "low",
        "supportsVision": True,
    }
    row.update(overrides)
    return row


class TestFromStore:
    """``from_store``: the whole configuration comes from the store's two rows."""

    def test_full_rows(self):
        cfg = EndpointsConfig.from_store(
            server_row(apiKey="sk-target"), model_row()
        )
        assert cfg.serverUrl == "http://host:8080/v1"
        assert cfg.apiKey == "sk-target"
        assert cfg.model_list() == ["model-a"]
        assert cfg.sysprompt == "Answer briefly."
        assert cfg.supports_vision is True
        assert cfg.to_kwargs() == {
            "temperature": 0.2,
            "top_p": 0.95,
            "top_k": 20,
            "min_p": 0.0,
            "repeat_penalty": 1.0,
            "presence_penalty": 0.0,
            "reasoning_effort": "low",
        }

    def test_native_types_pass_straight_through(self):
        """``True`` / ``0.7`` / ``40`` need no coercion, and no string parser."""
        cfg = EndpointsConfig.from_store(
            server_row(), model_row(supportsVision=True, temperature=0.7, topK=40)
        )
        assert cfg.supports_vision is True
        assert cfg.temperature == 0.7
        assert cfg.top_k == 40

    def test_a_null_sampler_column_is_omitted_from_the_request_body(self):
        """§4.2: a ``NULL`` sampler is "unset"; a ``0`` column is a value."""
        cfg = EndpointsConfig.from_store(
            server_row(),
            model_row(
                temperature=None, topP=None, topK=0, minP=None,
                repeatPenalty=None, presencePenalty=None, reasoning=None,
            ),
        )
        assert cfg.temperature is None
        assert cfg.top_p is None
        assert cfg.min_p is None
        assert cfg.repeat_penalty is None
        assert cfg.presence_penalty is None
        assert cfg.reasoning_effort is None
        assert cfg.to_kwargs() == {"top_k": 0}

    def test_an_empty_sys_prompt_means_the_built_in_default(self):
        """D8: the prompt's second level is now a property of the *model*."""
        cfg = EndpointsConfig.from_store(server_row(), model_row(sysPrompt=""))
        assert cfg.sysprompt == DEFAULT_LLM_SYSPROMPT

    def test_blank_strings_are_absent_not_values(self):
        cfg = EndpointsConfig.from_store(
            server_row(url="  http://x/v1  ", name="  "),
            model_row(name="  ", sysPrompt="   "),
        )
        assert cfg.endpoint is None
        assert cfg.sysprompt == DEFAULT_LLM_SYSPROMPT
        assert cfg.serverUrl == "http://x/v1"

    def test_a_missing_row_says_no_server_rather_than_raising(self):
        """How the seam's refusal reaches this builder: nothing to dial.

        The refusal is the seam's job (D7), so the builder neither raises nor
        invites — a model whose server row is missing is a config with no server.
        """
        cfg = EndpointsConfig.from_store(None, None)
        assert cfg.serverUrl == ""
        assert cfg.model_list() == []

    def test_a_bad_reasoning_still_raises(self):
        with pytest.raises(ValidationError):
            EndpointsConfig.from_store(server_row(), model_row(reasoning="sideways"))

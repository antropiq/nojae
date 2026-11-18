# Bugs found outside the current task

Recorded here rather than fixed, so the fix lands in the task that owns the code.

## `HubSet.stop_all()` trips over a deliberately-absent manager (pre-existing)

`tests/conftest.py`'s `set_workspace_hubs(..., mcp=NO_HUB)` sets `HubSet.mcp =
None` to mean "this hub is absent" (the documented degradation case), but
`HubSet.stop_all()` in `src/core/hubpool.py` calls `manager.stop_all()` on both
slots unconditionally. On app shutdown the pool then logs a traceback during
teardown:

```
WARNING nojae.hubpool: could not stop the tools of /tmp/.../mcp-workspace
AttributeError: 'NoneType' object has no attribute 'stop_all'
```

Seen in `tests/test_mcp.py::TestMcpEndpoints::test_restart_without_a_hub_returns_503`
and `::TestChatMcpWiring::test_nothing_enabled_keeps_call_shape`. The tests pass —
the pool catches and warns — so this is noise rather than a failure, but it is
noise in the one place that reports a hub that would *not* die, and the same
`None` would break `HubSet.start()` if a production path ever built a set that
way. A `None` guard in `stop_all` (or a double instead of `None` in the helper)
settles it.

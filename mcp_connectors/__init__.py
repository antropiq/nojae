"""Standalone MCP connector servers bundled with nojae.

Contract for a built-in connector (``*_mcp.py``): it MUST accept a ``--port``
flag (and ``--host``, default ``127.0.0.1``) and bind exactly what it is given.
The MCP hub is the single port authority — it allocates a port per connector
from the id and always launches the module with both flags — so a module's own
``DEFAULT_PORT`` / argparse default is only a fallback for running it by hand.

Modules: ``console_mcp`` (command execution), ``playwright_mcp`` (browser
automation), ``fedit_mcp`` (file edit, diff / SEARCH-REPLACE).

Pair ``console_mcp`` with ``fedit_mcp``: the console runs shell commands, while
every file read and edit (path policy, backups, revert) goes through
``fedit_mcp`` — the single file-content authority.

Run either as a standalone server, e.g.::

    python -m mcp_connectors.console_mcp --port 9999
"""

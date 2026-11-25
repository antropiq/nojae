"""The one check a terminal upgrade has to pass: Origin.

The pane is a *human* surface, but a WebSocket to a loopback port is reachable
by anything on the machine — a page in another tab, another local process. The
app has no CORS layer and no CSRF-style token, so this check is the one cheap
defence against a random web page handing itself a shell.

The rule is "the page must be local", not "the page must match the ``Host``
header", for two reasons:

* the dev proxy: the page is on Vite's origin, ``changeOrigin`` rewrites ``Host``
  to the API's but never the ``Origin``, so an origin==host comparison would
  refuse the very connection the dev workflow needs;
* DNS rebinding: under ``evil.com → 127.0.0.1`` a *host-match* check agrees,
  while a local-host check still refuses.

A page served from a routable host is refused by name. Anything that is not a
browser sends no ``Origin`` at all — a deliberately launched local client — and
is let through, which is the honest line: no Origin rule can discriminate
against another process on the same machine anyway.

Deliberately *not* here: a path from the client. The shell's ``cwd`` is the
workspace in scope when the session was born, entered from the socket's own
``workspace`` query field and resolved by the one validator in
:mod:`src.core.workspace`, so the folder comes from the client as a named
**workspace** once, never as a path in the frame stream. ``cd`` inside the shell
is the user's business; the routes that *do* take a path are gated by
``editorfs.policy`` instead.
"""

import ipaddress
from typing import Dict, Optional, Tuple
from urllib.parse import urlsplit

# Header values are ``bytes`` in the ASGI scope.
ScopeHeaders = Dict[bytes, bytes]


def _host_is_local(hostname: str) -> bool:
    """``localhost``, its subdomains (RFC 6761), or a loopback address."""
    host = hostname.strip("[]").lower().rstrip(".")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def origin_allowed(headers: ScopeHeaders) -> Tuple[bool, Optional[str]]:
    """True when the upgrade's ``Origin`` names a local page, or is absent.

    Returns ``(allowed, reason)``; the reason names the offending origin so the
    log says why a connection died.
    """
    raw = headers.get(b"origin")
    if raw is None:
        return (True, None)
    origin = raw.decode("latin-1").strip()
    if not origin:
        return (True, None)
    try:
        hostname = urlsplit(origin).hostname or ""
    except ValueError:
        hostname = ""
    if _host_is_local(hostname):
        return (True, None)
    return (False, origin)

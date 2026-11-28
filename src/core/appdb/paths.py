"""Where the store is: the install root, test mode's throw-away root, the sidecars.

Every path answer the store hands out is built here, from the façade's
``PROJECT_ROOT``, so one patch of that attribute moves the whole store.
"""

import tempfile
import threading
from pathlib import Path
from typing import Tuple

import src.core.appdb as appdb

# -- the path ------------------------------------------------------------------

_test_root_lock = threading.Lock()


def test_mode() -> bool:
    """Whether this process is the e2e suite's, and so must not touch the real store.

    One process-level switch, answered by ``config.env_flag`` — the same
    ``1/true/yes/on`` rule as ``NOJAE_DISABLE_MCP``. Read **per call**, never at
    import, so a test can flip it without reloading this module.

    It changes only *which file* is the store: with it on, :func:`database_path`
    answers a temporary root's ``nojae.db``, and the boot materialises the e2e
    suite's flat connection fixture into it as rows (:func:`materialise_test_fixture`).
    There is no fallback in either direction — with the switch on an absent or
    malformed fixture makes the suite **refuse to start** rather than reach the
    developer's configured servers and key.
    """
    return appdb.env_flag(appdb.TEST_SETTINGS_KEY)


def test_root() -> Path:
    """The throw-away install root test mode lives on, made on first use.

    One directory per process, kept for its lifetime: every path answer comes
    through :func:`database_path`, so a root that changed between two calls
    would leave one thread reading the store another thread just booted. A
    directory this process made is not removed — the temporary directory it sits
    in is the platform's to sweep.
    """
    with _test_root_lock:
        if appdb._test_root is None:
            appdb._test_root = Path(tempfile.mkdtemp(prefix=appdb.TEST_ROOT_PREFIX))
        return appdb._test_root


def _install_root() -> Path:
    """The root the store is built under: test mode's throw-away one, or the install's."""
    return test_root() if test_mode() else Path(appdb.PROJECT_ROOT)


def database_path() -> Path:
    """Where the store lives: ``<install root>/nojae.db`` (it may not exist yet).

    Built from :data:`PROJECT_ROOT` the way every other install-scoped path in
    this app is built (``editorfs.constants.BACKUP_DIR`` and the log folder are
    the others): one ``Path`` join, so it is correct on Linux and Windows with no
    platform branch, no separator spelled, no drive assumption and no ``~``
    expansion anywhere near it. It is the install's only configuration file — the
    ``.env`` beside it is gone, its keys are boot flags now.

    A **function**, not a constant, so a test can move the whole store by
    patching :data:`PROJECT_ROOT` — which is what keeps the suite off the
    developer's real file. Every path this module hands out (the connect seam,
    the sentences, the sidecars) comes through here, so one patch moves all of
    them at once.

    In **test mode** the root is :func:`test_root` instead: the install's own
    file is then not merely unlikely to be reached, it has no name here at all.
    """
    return _install_root() / appdb.DB_FILENAME


def sidecar_paths() -> Tuple[Path, ...]:
    """The WAL sidecars beside :func:`database_path`, in ``-wal``/``-shm`` order."""
    base = str(database_path())
    return tuple(Path(base + suffix) for suffix in appdb.WAL_SIDECAR_SUFFIXES)


def _describe(path: Path) -> str:
    """The path as a sentence spells it."""
    return str(path)

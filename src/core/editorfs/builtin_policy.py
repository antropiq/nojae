"""Level A: the rules nojae has about **itself**.

These are the files *this app* writes, regenerates, or keeps for its own use —
the half of :func:`editorfs.policy_modes.mode_for` that no workspace file can
configure. They are conditional on purpose: the rule that stops a pane editing
``.env`` is not "``.env`` is dangerous", it is "this installation owns the
``.env`` names at its own root". That is false for every other project, so
pointing the working location at another checkout must make its ``.env`` an
ordinary, editable file.

:func:`is_self_workspace` decides that, and it is the only condition in this
file: a rule that has to apply to a foreign workspace belongs in the seeded
workspace policy instead, where the user can read and change it. The reserved
folder is the one exception, because the app owns that relationship in every
workspace.

Patterns are matched against the **normalised workspace-relative** path — the
same form the level-B file uses, so one matcher answers both. Order is part of
the semantics (:func:`mode_for` reads the index for its last-match-wins step),
which is why this is a tuple of tuples and not a dict.
"""

from typing import List, Tuple

from . import constants
from .constants import policy_glob
from .constants import policy_shared as shared
from .policy import workspace_root
from src.core import workspace as workspace_seam


def is_self_workspace() -> bool:
    """True when the active workspace IS the nojae install directory.

    One comparison of two things the seam already resolves: the **scope** (the
    folder this request is about — :func:`editorfs.policy.workspace_root`) and
    the **installation** (:func:`src.core.workspace.installation`). The scope is
    per request, so a tab rooted at the install directory is stricter than a tab
    rooted elsewhere and both answers coexist in one process.

    The comparison is **exact**, not a prefix: the app's own parent directory, or
    a copy of the repo somewhere else, is not the app — the file that copy
    regenerates is not the one this process reads.
    """
    # Read at call time on both sides, so a test can move either one — the
    # installation through ``src.config.PROJECT_ROOT``, the workspace through the
    # seam's scope.
    return workspace_root() == workspace_seam.installation()


# ``(pattern, mode, reason)`` in evaluation order. Each reason is echoed verbatim
# by :func:`editorfs.policy_modes.refusal_message`, because "nojae hides
# this because this install owns the name" is a different conversation from
# "your policy hides it" — and the first is a rule the reader cannot edit.
BUILTIN_RULES: Tuple[Tuple[str, str, str], ...] = (
    # The ``**/`` is the point: the name has to be caught at any depth, and a
    # bare ``.env**`` would cover only the root one, because ``**`` never crosses
    # a component *backwards*. ``hidden`` rather than ``ro`` because the name is
    # this install's own (gitignored), so a pane has nothing to do with one at
    # its own root.
    (
        "**/.env**",
        shared.HIDDEN,
        "nojae's own configuration file name — this install owns it",
    ),
    # The store and its WAL sidecars sit at the install root, which is inside the
    # tree whenever the workspace *is* this checkout. The file holds the model
    # credentials and the app is its only reader and writer, so ``hidden``, like
    # the ``.env`` rule above, not ``ro``. The trailing ``*`` is what reaches the
    # sidecars, which hold committed bytes and so are part of the store. The name
    # is spelled here rather than imported: this is a rule *about* a name, not a
    # lookup of one — ``tests/test_appdb_store.py`` pins this file as a named
    # exception to "only the store module names the store".
    (
        "**/nojae.db*",
        shared.HIDDEN,
        "nojaé's own settings store, which holds the model credentials",
    ),
    # ``BACKUP_DIR`` lives under ``logs/``: outside the workspace *by path*, but
    # inside the tree whenever the workspace is the repo, so the Editor could
    # browse the app's own pre-save copies. The trash is not in here — it lives
    # in each workspace's reserved ``.nojae/trash``.
    ("logs/**", shared.HIDDEN, "the app's own backups"),
    # Build output: worth looking at, never worth hand-editing, and
    # ``npm run build`` overwrites whatever is there.
    ("web/dist/**", shared.READ_ONLY, "vite build output"),
)


def reserved_reason() -> str:
    """Why the reserved folder is hidden, spelled with the name in use.

    Built per call rather than at import: the folder name is a ``constants``
    attribute precisely so a test can move it, and a reason naming a folder the
    rules no longer reserve would be a sentence about a file that is not special.
    """
    return (
        f"the {constants.POLICY_DIRNAME} folder holds the workspace policy and "
        "is reserved by nojae"
    )


def builtin_rule_list() -> List[shared.Rule]:
    """Every level-A rule as a ``Rule``, in evaluation order — **matched or not**.

    What the resolver filters, unfiltered: :func:`builtin_rules` is this list
    narrowed by the matcher, so a panel that shows *this* list shows the exact
    rules the resolver holds — the same ``Rule`` objects, the same indices, no
    second copy of the table that could drift.

    The reserved folder is deliberately **not** in here: it is level A's one
    unconditional rule, and the policy panel treats it as its own line rather
    than as one of the workspace-conditional rules.

    Empty when the workspace is not this installation — what the panel renders
    as a caption rather than as an empty rule list that would look like a rule
    the user could have deleted.
    """
    if not is_self_workspace():
        return []
    return [
        shared.Rule(mode=mode, pattern=pattern, reason=reason, index=index,
                    level=shared.LEVEL_BUILTIN)
        for index, (pattern, mode, reason) in enumerate(BUILTIN_RULES)
    ]


def builtin_rules(rel: str, *, fold: bool = False) -> List[shared.Rule]:
    """Every level-A rule matching the normalised workspace-relative ``rel``.

    Never raises and never touches the disk: the caller resolved the path before
    asking (the three locks in :mod:`editorfs.policy`), and a rule here is a
    statement about a *name*, not about what is on disk under it.

    ``fold`` is the active workspace's case answer, handed down by
    :func:`editorfs.policy_modes.mode_for` — this module does not probe anything,
    and the default keeps the comparison exact for every other caller. It changes
    only whether a rule *matches*: patterns are still reported in the spelling
    they are written in, so the panel and a 422 quote ``logs/**`` and never
    ``LOGS/**``.

    The reserved folder is the one rule that applies in **every** workspace,
    self or foreign, whether or not a policy file exists or loaded — and no
    level-B rule can override it: a pattern naming it is rejected by the
    workspace file's validation, and even a matching one could not beat
    ``hidden``, which :func:`policy_shared.verdict_for` treats as absolute.
    """
    if policy_glob.reserved_component_hit(rel, constants.POLICY_DIRNAME,
                                          fold=fold) is not None:
        # Quoted as the reserved name itself, so the refusal names the folder the
        # user has to edit the file in — not a pattern they never wrote. It is a
        # **built-in** verdict, so the sentence says nojae reserved it and
        # not "your policy did" — and the connectors build the same Rule with the
        # same level, which is what makes their refusal match this one.
        return [
            shared.Rule(
                mode=shared.HIDDEN,
                pattern=constants.POLICY_DIRNAME,
                reason=reserved_reason(),
                # After the listed rules, so it never displaces one in a quote.
                index=len(BUILTIN_RULES),
                level=shared.LEVEL_BUILTIN,
            )
        ]

    if not is_self_workspace():
        return []

    return [
        shared.Rule(
            mode=mode,
            pattern=pattern,
            reason=reason,
            index=index,
            level=shared.LEVEL_BUILTIN,
        )
        for index, (pattern, mode, reason) in enumerate(BUILTIN_RULES)
        if policy_glob.pattern_matches(pattern, rel, fold=fold)
    ]

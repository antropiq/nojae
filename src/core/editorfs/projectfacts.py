"""What the wizard's LSP flow is grounded in: derived facts about this folder.

``project_facts`` is the read-only scan behind the connector wizard's "servers for
*this* project" proposal (§6 of ``docs/mcp-lsp-connector-wizard.md``). It answers
small, auditable facts — which extensions the folder holds, which manifests it
carries, what those manifests declare, which servers are already declared, and
where the project's "front end" looks to be — and **never file bytes**. That is
the promise the feature is built on: a proposal may say *"Python here (142 ``.py``
files, a ``pyproject.toml``), and no Python language server declared"* because the
scan counted, it never quoted.

What it promises (each rule mirrored by a test in
``tests/test_editorfs_projectfacts.py``):

* **one policy verdict per path**, the same three lines
  :func:`editorfs.quickopen.list_workspace_files` and
  :func:`editorfs.tree.list_dir` use. A ``hidden`` path is **pruned and
  uncounted** — a folder costs no ``scandir`` below it, and a file contributes
  neither an extension nor a count — so the payload cannot even confirm that a
  hidden name exists (the reserved folder is invisible from here as it is from the
  tree). An ``ro`` path is **not opened**: a read-only folder costs no
  ``scandir`` below it — quick-open's own narrowing, because a dependency or
  build tree is where a checkout's bytes pile up and walking one would spend the
  whole budget on a vendor's files — and a read-only *file* still counts toward
  its extension total, since the tree shows it, while a read-only *manifest* is
  never parsed. Nothing here keeps a private ignore list; the policy is the only
  exclusion mechanism.
* **a fixed manifest allow-list** (:data:`MANIFESTS`). A path is opened only when
  its *file name* is on that list, and nothing else is opened at all — no
  credential file is reachable from this surface, and adding one would mean
  editing the one constant a reviewer reads.
* **the existing caps.** The walk stops at ``MAX_QUICKOPEN_FILES`` — quick-open's
  own whole-workspace budget, read qualified so a test patches the name instead
  of writing thousands of files — and says so with ``truncated``; ``fileCount``
  stays the honest total. The walk's order is the tree's order (directories
  first, then files, each sorted by :func:`editorfs.tree._name_key`), so a
  truncated scan reports the same first N files every run.
* **a symlinked directory is listed at one level and never descended**, and a
  symlink is never opened — the ``tree.py`` / ``quickopen.py`` rule, so the walk
  can neither leave the workspace one hop at a time nor read through a link that
  points out of it.
* the payload is **plain values only**: counts, names, workspace-relative paths
  and the two truncation fields. No absolute path, no file content, no sentence.
  The one absolute path the wizard shows (the declaration file's) is resolved
  elsewhere, by the route that knows which family is being prepared.

The *declared* servers arrive as an **argument**, never read here:
:mod:`editorfs.policy` is reached from ``lsphub.discovery``, so importing a hub
from this package would close a cycle. This module answers about facts; filling
in the hubs' ids is task 05's route, and :func:`project_facts` only says which
extensions those ids already cover — the gap being the whole point of a proposal.
"""

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import constants, tree
from .policy_modes import mode_for
from .constants import policy_shared as shared

try:  # the stdlib TOML reader, from 3.11 on
    import tomllib
except ImportError:  # pragma: no cover - depends on the interpreter
    # This project still declares 3.10. There a ``pyproject.toml`` (or a
    # ``Cargo.toml``) is a manifest whose dependency names are not parsed rather
    # than one that fails — a module attribute so a test can prove that answer
    # instead of depending on which interpreter runs the suite.
    tomllib = None  # type: ignore[assignment]


#: The **only** file names this surface may ever open. One constant, so a
#: reviewer sees the whole reach at a glance: the manifests the spec names, plus
#: the configs that say which linter or toolchain a project already chose. A
#: credential file is not here and never becomes one — the rule is that the scan
#: is not a second file reader, and this list *is* the rule.
MANIFESTS: Tuple[str, ...] = (
    # The manifests themselves.
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "Cargo.toml",
    "composer.json",
    "Gemfile",
    "build.gradle",
    # The configs that say which linter or toolchain the project already chose.
    "tsconfig.json",
    "jsconfig.json",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    "eslint.config.js",
    "eslint.config.mjs",
    ".prettierrc",
    ".prettierrc.json",
    "prettier.config.js",
    "biome.json",
    "biome.jsonc",
    "ruff.toml",
    ".ruff.toml",
    "mypy.ini",
    ".mypy.ini",
)

#: The manifests that mark where a project's **front end** lives — the folder an
#: LSP ``workspaceRoot`` naturally defaults to. ``package.json`` is the one that
#: matters (a ``web/package.json`` is what makes ``web`` the front end); the two
#: TypeScript configs answer the same question where a bundler is not involved.
FRONT_END_MANIFESTS: Tuple[str, ...] = ("package.json", "tsconfig.json", "jsconfig.json")

_FRONT_END_NAMES = frozenset(FRONT_END_MANIFESTS)

#: ``group:artifact`` in a Gradle build file, optionally with a version — the
#: coordinate's first two components are the dependency's name. The group and the
#: artifact cannot hold a ``/``, which is what keeps a repository URL on a
#: neighbouring line from reading as a coordinate.
_GRADLE_COORDINATE = re.compile(r"""['"]([^:/'"]+):([^:/'"]+)(?::[^'"]*)?['"]""")

#: A Gradle configuration that declares a dependency, as its own word (so a
#: repository URL or a task name on the same line is not mistaken for one).
_GRADLE_DECLARATION = re.compile(
    r"\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation"
    r"|testRuntimeOnly|classpath)\b"
)

_GEM_LINE = re.compile(r"""^\s*gem\s+['"]([^'"]+)['"]""")


# -- the manifest readers: names only, one per ecosystem -----------------------


def _requirement_name(requirement: Any) -> Optional[str]:
    """The package name of one requirement string, or ``None``.

    ``fastapi[all]>=0.110 ; python_version >= '3.10'`` is ``fastapi``: the name is
    everything before the first extras bracket, version operator, marker or
    space — never the specifier beside it.
    """
    if not isinstance(requirement, str):
        return None
    text = requirement.strip()
    if not text or text.startswith(("#", "-")):
        return None
    for index, char in enumerate(text):
        if char in " \t[<>=!~;@(":
            return text[:index] or None
    return text or None


def _npm_names(text: str) -> List[str]:
    """The keys of a ``package.json`` dependency block — all four of them."""
    data = json.loads(text)
    if not isinstance(data, dict):
        return []
    names = set()
    for block in ("dependencies", "devDependencies", "peerDependencies",
                  "optionalDependencies"):
        declared = data.get(block)
        if isinstance(declared, dict):
            names.update(name for name in declared if isinstance(name, str))
    return sorted(names)


def _composer_names(text: str) -> List[str]:
    """The keys of a ``composer.json`` ``require`` / ``require-dev`` block."""
    data = json.loads(text)
    if not isinstance(data, dict):
        return []
    names = set()
    for block in ("require", "require-dev"):
        declared = data.get(block)
        if isinstance(declared, dict):
            names.update(name for name in declared if isinstance(name, str))
    return sorted(names)


def _toml(text: str) -> Any:
    """One TOML document, or ``None`` where no stdlib reader is available."""
    if tomllib is None:
        return None
    return tomllib.loads(text)


def _pyproject_names(text: str) -> List[str]:
    """The package names a ``pyproject.toml`` declares.

    Three spellings, because a Python project may use any of them: PEP 621's
    ``project.dependencies`` / ``project.optional-dependencies``, and Poetry's
    ``tool.poetry`` tables (its dependency groups included).
    """
    data = _toml(text)
    if not isinstance(data, dict):
        return []
    names = set()
    project = data.get("project")
    if isinstance(project, dict):
        required = project.get("dependencies")
        if isinstance(required, list):
            names.update(
                name for name in map(_requirement_name, required) if name
            )
        extras = project.get("optional-dependencies")
        if isinstance(extras, dict):
            for group in extras.values():
                if isinstance(group, list):
                    names.update(
                        name for name in map(_requirement_name, group) if name
                    )
    poetry = data.get("tool")
    poetry = poetry.get("poetry") if isinstance(poetry, dict) else None
    if isinstance(poetry, dict):
        for block in ("dependencies", "dev-dependencies"):
            declared = poetry.get(block)
            if isinstance(declared, dict):
                names.update(name for name in declared if isinstance(name, str))
        groups = poetry.get("group")
        if isinstance(groups, dict):
            for group in groups.values():
                declared = group.get("dependencies") if isinstance(group, dict) else None
                if isinstance(declared, dict):
                    names.update(name for name in declared if isinstance(name, str))
    return sorted(names)


def _cargo_names(text: str) -> List[str]:
    """The keys of every ``*dependencies`` table of a ``Cargo.toml``."""
    data = _toml(text)
    if not isinstance(data, dict):
        return []
    names = set()
    for key, value in data.items():
        if not isinstance(value, dict):
            continue
        tables = [value] if str(key).endswith("dependencies") else [
            nested
            for nested_key, nested in value.items()
            if isinstance(nested, dict) and str(nested_key).endswith("dependencies")
        ]
        for declared in tables:
            names.update(name for name in declared if isinstance(name, str))
    return sorted(names)


def _requirements_names(text: str) -> List[str]:
    """The package names of a ``requirements.txt``, one requirement per line."""
    names = set()
    for line in text.splitlines():
        # A trailing comment is not a requirement, and an option line
        # (``-r other.txt``, ``-e .``) names no package of its own.
        stripped = line.split("#", 1)[0].strip()
        name = _requirement_name(stripped)
        if name:
            names.add(name)
    return sorted(names)


def _go_names(text: str) -> List[str]:
    """The module paths a ``go.mod`` requires — the block form and the one-liner."""
    names = set()
    in_block = False
    for line in text.splitlines():
        stripped = line.strip()
        if in_block:
            if stripped == ")":
                in_block = False
                continue
            parts = stripped.split()
            if parts:
                names.add(parts[0])
            continue
        if stripped.startswith("require ("):
            in_block = True
        elif stripped.startswith("require "):
            parts = stripped[len("require "):].split()
            if parts:
                names.add(parts[0])
    return sorted(names)


def _gemfile_names(text: str) -> List[str]:
    """The gem names a ``Gemfile`` declares."""
    names = set()
    for line in text.splitlines():
        match = _GEM_LINE.match(line)
        if match:
            names.add(match.group(1))
    return sorted(names)


def _gradle_names(text: str) -> List[str]:
    """The ``group:artifact`` coordinates a ``build.gradle`` declares.

    Only a line naming a dependency configuration *as a word* is considered, so
    ``mavenCentral()`` or a task name is not read as a declaration — and the
    coordinate itself cannot hold a ``/``, so a repository URL on the same line
    stays a URL.
    """
    names = set()
    for line in text.splitlines():
        if not _GRADLE_DECLARATION.search(line):
            continue
        for group, artifact in _GRADLE_COORDINATE.findall(line):
            names.add(f"{group}:{artifact}")
    return sorted(names)


#: Which reader answers for which allow-listed name. A name that is not a key
#: here is on the list for its **presence** alone (the linter and toolchain
#: configs, which declare no dependency of their own).
_PARSERS: Dict[str, Any] = {
    "package.json": _npm_names,
    "pyproject.toml": _pyproject_names,
    "requirements.txt": _requirements_names,
    "go.mod": _go_names,
    "Cargo.toml": _cargo_names,
    "composer.json": _composer_names,
    "Gemfile": _gemfile_names,
    "build.gradle": _gradle_names,
}

_MANIFEST_NAMES = frozenset(MANIFESTS)


def _read_manifest(path: Path) -> str:
    """The text of one allow-listed manifest — the module's only file open.

    Bounded by ``constants.MAX_EDITOR_BYTES``, read qualified and at call time
    like every other cap here: a bigger file is answered as empty, because a
    manifest read in a fragment would report a name the file does not declare.
    Deliberately one function, so "nothing but an allow-listed manifest is ever
    opened" is a fact a test can spy on rather than a promise in prose.
    """
    cap = constants.MAX_EDITOR_BYTES
    with open(path, "rb") as handle:
        raw = handle.read(cap + 1)
    if len(raw) > cap:
        return ""
    return raw.decode("utf-8")


def _manifest_dependencies(name: str, path: Path) -> List[str]:
    """The dependency names one manifest declares, or none.

    Answers an empty list for a name on the allow-list whose parser is not there,
    for a file that vanished or cannot be read, and for one that is not valid
    JSON/TOML/UTF-8 — the manifest is still *present*, so presence is what the
    caller reports; nothing is guessed into shape.
    """
    parser = _PARSERS.get(name)
    if parser is None:
        return []
    try:
        return parser(_read_manifest(path))
    except (OSError, ValueError):
        return []


# -- the declared servers, handed in as plain data -----------------------------


def _as_entries(raw: Any) -> List[Any]:
    """The declared half of the argument, as a list (anything else is nothing)."""
    return list(raw) if isinstance(raw, (list, tuple)) else []


def _entry_id(entry: Any) -> Optional[str]:
    """The id of one declared server: a bare string, or a dict's ``id``."""
    if isinstance(entry, str):
        return entry or None
    if isinstance(entry, dict):
        entry_id = entry.get("id")
        return entry_id if isinstance(entry_id, str) and entry_id else None
    return None


def _entry_extensions(entry: Any) -> List[str]:
    """The ``extensions`` one declared server claims, lower-cased and sorted."""
    if not isinstance(entry, dict):
        return []
    extensions = entry.get("extensions")
    if not isinstance(extensions, (list, tuple)):
        return []
    return sorted({
        item.lower()
        for item in extensions
        if isinstance(item, str) and item.startswith(".")
    })


def _declared(
    declared: Optional[Dict[str, Any]]
) -> Tuple[List[str], List[Dict[str, Any]], Dict[str, List[str]]]:
    """``(mcp ids, lsp entries, extension -> lsp ids)`` — normalised, sorted.

    The echo is normalised rather than passed through so the payload is the same
    text whatever order a loader happened to hand its declarations in, and the
    coverage map is what demotes a language the project already serves.
    """
    declared = declared if isinstance(declared, dict) else {}
    mcp_ids = sorted(
        {entry_id for entry_id in map(_entry_id, _as_entries(declared.get("mcp")))
         if entry_id}
    )
    lsp_entries: List[Dict[str, Any]] = []
    coverage: Dict[str, List[str]] = {}
    for entry in _as_entries(declared.get("lsp")):
        entry_id = _entry_id(entry)
        if entry_id is None:
            continue
        extensions = _entry_extensions(entry)
        lsp_entries.append({"id": entry_id, "extensions": extensions})
        for extension in extensions:
            ids = coverage.setdefault(extension, [])
            if entry_id not in ids:
                ids.append(entry_id)
    lsp_entries.sort(key=lambda item: item["id"])
    for ids in coverage.values():
        ids.sort()
    return mcp_ids, lsp_entries, coverage


# -- the walk ------------------------------------------------------------------


def _front_end(candidates: Sequence[str]) -> Optional[str]:
    """The shallowest folder holding a front-end manifest, or ``None``.

    Shallowest, because the project's own ``web/`` beats a vendor's
    ``web/node_modules/dep/`` — and the path text breaks the tie, so the answer is
    the same one every run. An empty string is the workspace root itself, which is
    a real answer: a bundle at the top is its own front end. A project with no such
    manifest gets ``None`` — this never invents a folder.
    """
    if not candidates:
        return None
    return min(candidates, key=lambda rel: (rel.count("/") if rel else 0, rel))


def project_facts(declared: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """What this folder is made of, as derived facts and nothing else.

    ``declared`` is the already-declared servers as plain data —
    ``{"mcp": [ids or {"id": …}], "lsp": [{"id": …, "extensions": […]}]}`` — filled
    in by the caller from the hubs' own loaders (this package must not import a
    hub: ``lsphub.discovery`` already reaches into ``editorfs.policy``). It is
    used to mark which extension a declared server already covers, and to echo
    the declared ids so a proposal can name the gap.

    The answer, all workspace-relative where it names a path:

    * ``extensions`` — ``[{"extension": ".py", "count": 142, "servers": [...]}]``,
      most numerous first, ties broken by the extension itself; an empty
      ``servers`` list *is* the gap a proposal leads with.
    * ``manifests`` — ``[{"path": "pyproject.toml", "dependencies": [...]}]``, in
      the walk's order, carrying only the dependency **names** the file declares.
    * ``declared`` — ``{"mcp": [...], "lsp": [{"id": …, "extensions": […]}]}``.
    * ``frontEnd`` — the workspace-relative folder holding a front-end manifest,
      shallowest first (``""`` for the workspace root itself), or ``None`` when
      the project has none. Never invented.
    * ``fileCount`` / ``truncated`` — the honest total and whether the walk cap
      cut the facts short, the pair quick-open and search already answer.

    Raises nothing: an unreadable folder, a damaged manifest and an absent policy
    all degrade to fewer facts. Nothing is written, nothing is started, and no
    file outside :data:`MANIFESTS` is opened.
    """
    mcp_ids, lsp_servers, coverage = _declared(declared)
    root = Path(tree.workspace_root())
    counts: Dict[str, int] = {}
    manifests: List[Dict[str, Any]] = []
    front_candidates: List[str] = []
    total = 0
    kept = 0
    truncated = False

    def walk(rel: str, folder: Path) -> None:
        nonlocal total, kept, truncated
        try:
            with os.scandir(folder) as scan:
                entries = list(scan)
        except OSError:
            # Unreadable directory: end this branch rather than fail the scan —
            # the answer ``tree._has_children`` and ``quickopen`` give.
            return

        dirs: List[os.DirEntry] = []
        plain_files: List[Tuple[os.DirEntry, str]] = []
        for scan_entry in entries:
            child_rel = tree._rel_of(rel, scan_entry.name)
            verdict = mode_for(child_rel).mode
            # One verdict, and it is a *prune*: a hidden folder is neither listed
            # nor walked, so the payload never confirms a hidden name — not by a
            # path, not by an extension, not by a count.
            if verdict == shared.HIDDEN:
                continue
            if scan_entry.is_dir(follow_symlinks=False):
                # A read-only *folder* is not descended, which is
                # :func:`editorfs.quickopen.list_workspace_files`' own narrowing
                # of the tree's set rather than a second ignore list: a
                # dependency or build tree is where a checkout's bytes pile up,
                # so descending one would spend the whole walk budget on a
                # vendor's files and describe the vendor instead of this project.
                # ``hidden`` is still the only *rule*; this is the policy's own
                # verdict on that one path.
                if verdict == shared.READ_ONLY:
                    continue
                dirs.append(scan_entry)
            elif scan_entry.is_dir():
                # A symlinked directory: listed at one level in the tree, never
                # descended here, so the walk cannot leave the workspace.
                continue
            else:
                plain_files.append((scan_entry, verdict))

        # ``tree._name_key`` reads the ``name`` of an entry dict, so it is handed
        # that one field — the tree's own ordering, never re-derived.
        dirs.sort(key=lambda entry: tree._name_key({"name": entry.name}))
        plain_files.sort(
            key=lambda item: tree._name_key({"name": item[0].name})
        )

        for scan_entry in dirs:
            walk(tree._rel_of(rel, scan_entry.name), Path(scan_entry.path))
        for scan_entry, verdict in plain_files:
            total += 1
            if kept >= constants.MAX_QUICKOPEN_FILES:
                # Past the cap: still counted, its facts not taken, so a
                # truncated answer is the same first N files every run.
                truncated = True
                continue
            kept += 1
            extension = os.path.splitext(scan_entry.name)[1].lower()
            if extension:
                counts[extension] = counts.get(extension, 0) + 1
            if scan_entry.name not in _MANIFEST_NAMES:
                # Not on the allow-list: this is the whole rule. Nothing else is
                # opened, whatever its name looks like.
                continue
            # ``is_file(follow_symlinks=False)`` — a symlink or a fifo is never
            # opened; its name is still a manifest the tree shows, so it is
            # reported with no names parsed rather than dropped.
            regular = scan_entry.is_file(follow_symlinks=False)
            manifests.append({
                "path": tree._rel_of(rel, scan_entry.name),
                "dependencies": (
                    _manifest_dependencies(scan_entry.name, Path(scan_entry.path))
                    if regular and verdict != shared.READ_ONLY
                    else []
                ),
            })
            # Presence, not readability: an ``ro`` package.json still says where
            # the front end is, and the shallowest candidate is what wins.
            if regular and scan_entry.name in _FRONT_END_NAMES:
                front_candidates.append(rel)

    walk("", root)
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return {
        "extensions": [
            {
                "extension": extension,
                "count": count,
                "servers": list(coverage.get(extension, ())),
            }
            for extension, count in ordered
        ],
        "manifests": manifests,
        "declared": {"mcp": mcp_ids, "lsp": lsp_servers},
        "frontEnd": _front_end(front_candidates),
        "fileCount": total,
        "truncated": truncated,
    }

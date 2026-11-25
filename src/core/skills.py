"""Skills: the folders of packaged know-how a workspace and the user hold.

A **skill** is one direct subfolder of a **skills root** — a ``.agents/skills``
folder at either of two **scopes**: the *project*'s (the workspace's own) or the
*user*'s (the home folder's, machine-wide). The folder is the unit; its
``SKILL.md`` is the entry point and that file's ``name`` / ``description`` header
is the only thing read here. This module owns the discovery, the header read and
the catalogue the list of those becomes.

It owns no route, no model, no browser and no connector, and it reads no file
beyond a skill's header — discovery alone reads not even that, answering with
*paths*. So it **never injects a skill's body**: that reaches the conversation
only when the model opens it itself, through the connectors that already exist.
A second path to the same bytes would be a second policy to keep in agreement
with the first.

**The read discipline, and why the two reads must not converge.** This module
reads the *header* — the ``name`` / ``description`` lines between the two ``---``
lines — and nothing else; the **model** reads the *body*. That split keeps the
cost proportional to the number of skills rather than their size, and keeps a
skill's instructions out of the system prompt: a body is a document the model
chose to open, never text the app put in front of it. The two reads must never
merge into one "load a skill" function and nothing here may hand a body to a
caller — a catalogue entry carrying its body would be a prompt-injection channel
with a nicer name.

The one question asked of another surface is the workspace policy's verdict on
the **project** skills root (:func:`discover`), through the same
:func:`editorfs.policy_modes.mode_for` the tree, the search and the write
surface consult, so one path has one answer. It is the *only* policy-gated thing
here.

Three invariants outlive every change to this file:

* **it never writes.** A skills root is the user's authoring surface, so no path
  through this module creates, edits, renames or deletes anything under one.
* **it never raises over a damaged input.** An unreadable root is one finding and
  the rest of the scan still answers. The one exception is the workspace seam:
  reached outside a scope it raises, and that error is *let out*, never swallowed
  into an empty list.
* **the workspace is a value, not a process setting.** The project root comes from
  :func:`src.core.workspace.current_root` per call and is never cached at module
  level, so two tabs on two folders get two catalogues.
"""

import logging
import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

from src.core import workspace
from src.core.editorfs import policy_modes
from src.core.editorfs.constants import policy_shared as shared

# -- the constants (module attributes, patchable) --------------------------------

#: Subfolders examined per skills root. The bound exists to make a *mistake*
#: cheap — a skills root is hand-authored folders, not a build output — not to
#: support a large collection. It counts subfolders **examined**, so it bounds the
#: work and not the result.
MAX_SKILL_DIRS = 200

#: One description as displayed in the catalogue, in characters: the budget of a
#: line whose only job is to let the model decide relevance. The block is re-sent
#: on **every** turn on that workspace, which is why it is bounded at all.
MAX_CATALOGUE_DESCRIPTION_CHARS = 500

#: The whole rendered catalogue block, in UTF-8 bytes. Past it, a longer prompt is
#: not a better-informed model, only a slower and dearer one.
MAX_CATALOGUE_BYTES = 16 * 1024

#: The file that makes a folder a skill. Matched **exactly**, so a folder holding
#: ``skill.md`` is not a skill on a case-sensitive volume — every other client
#: scans for this one spelling.
SKILLS_FILENAME = "SKILL.md"

#: Where a skills root is, per scope, as **path components** rather than a string,
#: so ``os.path.join(scope_root, *SKILLS_ROOT_PARTS)`` spells it correctly on
#: either platform.
SKILLS_ROOT_PARTS = (".agents", "skills")

# -- the header read's own bounds ------------------------------------------------

#: Lines the frontmatter reader walks before calling a header unparseable. This
#: bounds **damage**, not content: a file whose closing ``---`` never arrives must
#: cost a fixed amount of reading rather than the whole file.
MAX_HEADER_LINES = 64

#: Characters one header value may hold. The bound is on what a scan keeps in
#: memory, never a reason to drop the skill — shortening for display is
#: :func:`_display_description`'s job.
MAX_HEADER_LINE_CHARS = 1024

#: The line that opens and closes a skill's frontmatter, compared **exactly**: no
#: leading blank line, no BOM, no "close enough".
FRONTMATTER_DELIMITER = "---"

#: The only header keys this reader knows. Two flat scalars are all a catalogue
#: needs, so no YAML parser is added and no YAML subset is grown.
HEADER_KEYS = ("name", "description")

# -- the two scopes, and the one place their order lives -------------------------

#: The workspace's own skills root: the know-how that travels with the checkout.
SCOPE_PROJECT = "project"

#: The home folder's skills root: the user's machine-wide set, available in every
#: workspace. Its folder is computed from :func:`user_home`, never written down.
SCOPE_USER = "user"

#: The scopes, **project first**. That order is the precedence order (a project
#: skill shadows a user skill of the same name) and the display order of the
#: catalogue's groups, so there is one rule and not two. Nothing downstream
#: re-spells it.
SCOPES: Tuple[str, ...] = (SCOPE_PROJECT, SCOPE_USER)

logger = logging.getLogger("nojae.skills")

# -- the three shapes -----------------------------------------------------------

KIND_ERROR = "error"  # this skill or root was dropped; the rest still answers
KIND_NOTE = "note"    # nothing was dropped; the scan saw something worth naming


@dataclass(frozen=True)
class SkillFinding:
    """One thing the scan noticed about a skill or a root it could not use.

    The same two kinds, and the same meaning, :class:`core.agent_modes.ModeFinding`
    gives them: a finding never fails the read, and its ``message`` names the path
    it is about — one nobody can trace to a folder is a wall rather than a message.
    There is no UI to feed, so a finding's whole job is the log.
    """

    kind: str
    message: str


@dataclass(frozen=True)
class SkillPath:
    """A skill as *discovered*: where it is, with nothing read from it yet.

    ``path`` is the **resolved absolute** path of that skill's ``SKILL.md``, so the
    catalogue can hand the model a path to open rather than a name to reconstruct —
    it does not know what ``$HOME`` expands to here, and a symlinked skill folder is
    named by where it lands. ``root`` is the canonicalised skills root found under,
    which the catalogue groups its entries by.
    """

    scope: str
    root: str
    path: str


@dataclass(frozen=True)
class Skill:
    """One skill as *offered*: what the catalogue can be told about it.

    Built only for a skill that **will** be listed, so the renderer never filters:
    a skill with nothing to say about itself is skipped here, not passed on with a
    blank line.

    ``name`` is the **folder's** name, never the header's — the folder is the
    skill's identity, which is what every other client scanning these trees keys
    on. ``path`` is :attr:`SkillPath.path` unchanged, so the model is never asked
    to reconstruct it. ``description`` is the header's, already trimmed and
    non-empty, and is the only thing relevance is judged from.
    """

    name: str
    description: str
    path: str
    scope: str


# -- the two roots ---------------------------------------------------------------

def user_home() -> str:
    """The user scope's home folder, in the app's one canonical form.

    A function resolved **per call**, not a constant, so a test can point the user
    scope at a throw-away folder instead of this machine's real ``.agents/skills``
    — the seam the hermeticity guard patches. Canonicalised by
    :func:`src.core.workspace.canonical` (``~`` expanded, then ``realpath``), so
    two spellings of one folder are one root.
    """
    return workspace.canonical(os.path.expanduser("~"))


def skills_roots() -> List[Tuple[str, str]]:
    """The roots to scan, as ``[(scope, canonical_path)]``, project first.

    Answers "which folders *would* be scanned", so neither root is stat'ed here —
    existence is :func:`discover`'s question.

    A root whose canonical path already appeared earlier is not returned again, so
    a workspace that *is* the home folder scans it **once**, with the project scope
    winning the dedupe, instead of listing every skill twice.

    The project root comes from the workspace seam and nothing else, whose
    :class:`~src.core.workspace.WorkspaceNotScoped` is let out: this module has no
    folder of its own to guess at.
    """
    roots: List[Tuple[str, str]] = []
    seen: Set[str] = set()
    for scope in SCOPES:
        base = workspace.current_root() if scope == SCOPE_PROJECT else user_home()
        root = workspace.canonical(os.path.join(base, *SKILLS_ROOT_PARTS))
        if root in seen:
            continue
        seen.add(root)
        roots.append((scope, root))
    return roots


# -- the bounded one-level walk ---------------------------------------------------

def _project_root_rel() -> str:
    """The project skills root in the spelling the workspace policy takes.

    :func:`editorfs.policy_modes.mode_for` matches on a **normalised
    workspace-relative** path, never the absolute one — rules are written against
    the workspace the user sees, and a workspace of ``$HOME`` would otherwise match
    ``web/**`` by accident. :data:`SKILLS_ROOT_PARTS` holds literal components with
    no separators, so joining with ``/`` *is* that normalised form.
    """
    return "/".join(SKILLS_ROOT_PARTS)


def _project_root_verdict() -> shared.Verdict:
    """The workspace policy's answer about the project skills root — one ask.

    The module's only policy question, and a function rather than an inline call so
    a test can count the asks: the check is **one verdict on the root**, never one
    per skill, because a ``hidden`` rule prunes the folder and everything under it.

    :func:`editorfs.policy_modes.mode_for` is the function to call and
    :func:`editorfs.policy.resolve_in_workspace` is emphatically not: the latter
    applies the ``realpath`` containment lock as well as the verdict, so a skills
    root that is a **symlink pointing outside the workspace** — a common way of
    reusing a collection — would be refused and silently dropped here, while the
    connector reads happily through that same link. Discovery and access are two
    questions; this asks the first. ``mode_for`` never raises.
    """
    return policy_modes.mode_for(_project_root_rel())


def _root_hidden_finding(rel: str, root: str) -> SkillFinding:
    """The one note for a project root the workspace policy prunes.

    ``KIND_NOTE``, not ``KIND_ERROR``: nothing is damaged and nothing is missing —
    the operator asked for this folder to be unreachable, and the scan obeyed. It
    names the **workspace-relative** spelling because that is the text the rule in
    ``.nojae/read-write-policy.json`` was written against, with the pruned root
    beside it so the sentence is traceable to a folder. It quotes no refusal
    sentence: a second paraphrase of
    :func:`editorfs.policy_modes.refusal_message` is how the two start disagreeing.
    """
    return SkillFinding(
        KIND_NOTE,
        "the project skills root is hidden by the workspace policy, so it is "
        f"not scanned: {rel} ({root})",
    )


def _root_unreadable_finding(root: str, exc: OSError) -> SkillFinding:
    """The one finding for a root this scan could not walk.

    It names the path and the OS's own sentence, because "no skills here" and "I
    could not look here" are different things to whoever reads the log, and only
    the second one is actionable.
    """
    return SkillFinding(
        KIND_ERROR,
        f"the skills root cannot be read: {root} ({exc})",
    )


def discover() -> Tuple[List[SkillPath], List[SkillFinding]]:
    """Every skill folder the two roots hold, as paths — no header is read.

    ``(found, findings)``, ``found`` in discovery order: the project root's
    entries, then the user root's. A skill is a **direct subfolder** holding a
    file named exactly :data:`SKILLS_FILENAME` — nothing else in the tree is one.

    Each root is bounded to the first :data:`MAX_SKILL_DIRS` subfolders
    **examined** (of both kinds, with and without the file), so the bound bounds
    work. Subfolders are examined in a sorted listing: "first-found wins" is only
    reproducible if the order is, and an order the filesystem chose would make a
    shadowing verdict depend on the volume.

    An absent root is silent. An unreadable one — a permission refusal, or a file
    where a folder was expected — costs that root's skills and **one** finding,
    and never an exception. Only a broken seam (no workspace in scope) escapes.

    The **project** root is consulted against the workspace policy **before** it
    is walked: a `hidden` verdict prunes the root — no listing, no header read,
    one finding — because a hidden path is unreachable to the agent's connectors,
    so cataloguing it would list paths that can only produce refusals. That one
    verdict is the *only* policy question this module asks: a skill's header is
    the operator's instruction to the model, not an agent's file access, so the
    agent-facing path rules do not run over it.
    """
    found: List[SkillPath] = []
    findings: List[SkillFinding] = []

    for scope, root in skills_roots():
        if scope == SCOPE_PROJECT and _project_root_verdict().mode == shared.HIDDEN:
            # Asked before the ``scandir`` below, so a pruned root costs no
            # listing and no header read.
            #
            # ``ro`` and ``rw`` both proceed, and that is deliberate: reading is
            # the whole point of marking a folder read-only, which is exactly why
            # a skills folder is worth marking that way. Do not "fix" this into a
            # skip for `ro`.
            #
            # The **user** root is never consulted: it sits outside the workspace,
            # so no workspace policy can speak for it, and asking would put a
            # second authority over a folder the workspace does not own.
            finding = _root_hidden_finding(_project_root_rel(), root)
            findings.append(finding)
            _log_finding(finding)
            continue

        try:
            # ``dir_scan``, not ``scan``: the module's public :func:`scan` is the
            # caller's entry point and this is a directory iterator.
            with os.scandir(root) as dir_scan:
                # Sorted, not the order the directory gives back: see above.
                entries = sorted(dir_scan, key=lambda item: item.name)
        except FileNotFoundError:
            # Most workspaces have no skills root at all: not an error, and no
            # finding to explain a folder nobody meant to create.
            continue
        except OSError as exc:
            finding = _root_unreadable_finding(root, exc)
            findings.append(finding)
            _log_finding(finding)
            continue

        examined = 0
        for entry in entries:
            if examined >= MAX_SKILL_DIRS:
                break
            try:
                # Follows a symlinked skill folder: the link is the user's way of
                # reusing a collection installed elsewhere, and the connectors
                # judge the target when the model actually opens it.
                is_folder = entry.is_dir()
            except OSError:
                # A damaged entry, not a damaged root: a dangling link answers
                # False without raising, so what gets here is a link whose
                # target cannot be settled at all (a loop). It is still a
                # subfolder that was examined, so it spends the bound.
                examined += 1
                continue
            if not is_folder:
                continue
            examined += 1
            marker = os.path.join(entry.path, SKILLS_FILENAME)
            # ``stat``, never ``open``: the walk answers with paths, and "the body
            # is never read at scan time" starts here. A marker that is a directory,
            # a dangling link or a name this process may not see is simply not a
            # skill, and costs no finding — only a root that cannot be walked is
            # worth a sentence about.
            if not os.path.isfile(marker):
                continue
            found.append(
                SkillPath(
                    scope=scope,
                    root=root,
                    path=workspace.canonical(marker),
                )
            )

    return found, findings


# -- the header read --------------------------------------------------------------

def _log_finding(finding: SkillFinding) -> None:
    """Write one finding to the log, once, at the moment it is made.

    The log line *is* the diagnosis for a skill that did not appear: an error
    dropped something and is a warning, a note dropped nothing and is info. Every
    finding comes through here, so the list :func:`scan` returns and the console
    say the same thing in the same number of lines — a caller that also logged it
    would print every missing skill twice.
    """
    if finding.kind == KIND_ERROR:
        logger.warning("%s", finding.message)
    else:
        logger.info("%s", finding.message)


def _unquoted(value: str) -> str:
    """A header value, trimmed, with one pair of matching quotes removed.

    Only a *matching* pair counts, so ``"don't"`` keeps its apostrophe and a
    value that merely starts with a quote is left alone — this strips the quotes
    a YAML scalar was written with, it does not parse escapes.
    """
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        return text[1:-1].strip()
    return text


def read_header(path: str) -> Tuple[Dict[str, str], Optional[SkillFinding]]:
    """One ``SKILL.md``'s frontmatter, as ``({key: value}, finding)``.

    Answers, never raises: every way a file can be undecodable, unreadable or
    the wrong shape is a finding, and the finding names the path it is about.
    The mapping holds only :data:`HEADER_KEYS`; a key the file does not state is
    simply absent from it, which is how a caller tells "missing" from "empty".

    **Only the header is read, and only as far as it closes.** The loop stops at
    the closing ``---``, so the body is never *reached* and a ``SKILL.md`` of any
    size costs the same; a header that never closes is bounded by
    :data:`MAX_HEADER_LINES` lines so the damaged case is not open-ended either.
    (The bound is on lines and on a value's length, not on bytes: one enormous
    line is the one shape that costs more, and nobody authored it.)

    The rules, in the order they are applied:

    * the header sits between a first line that is exactly
      :data:`FRONTMATTER_DELIMITER` and the next such line. Anything else — a
      blank first line, a BOM, a file that is only prose — is no parseable
      frontmatter, and so is a header that opens and never closes.
    * each line is ``key: value``. The value is trimmed and one pair of matching
      quotes is removed.
    * **the colon fallback**: the split is on the **first** colon, so an unquoted
      value that contains one — "Use when X: read the schema", the most common
      cross-client breakage — survives whole rather than being truncated at the
      second.
    * a line that is not a flat scalar this reader knows is **ignored**, not an
      error: a comment, a blank line, a nested mapping or a list value says
      nothing about the two keys, and failing the file over one would grow a YAML
      subset by the back door.
    """
    header: Dict[str, str] = {}

    def dropped(message: str) -> Tuple[Dict[str, str], SkillFinding]:
        """The answer for a file this read could not use: nothing, and why."""
        finding = SkillFinding(KIND_ERROR, message)
        _log_finding(finding)
        return {}, finding

    try:
        # Text mode with an explicit encoding: an undecodable file fails at the
        # first read rather than after it, and the body is never decoded because
        # the loop never reaches it.
        with open(path, "r", encoding="utf-8") as handle:
            if handle.readline().rstrip("\r\n") != FRONTMATTER_DELIMITER:
                return dropped(
                    f"no frontmatter to read: {path} does not open with a "
                    f"'{FRONTMATTER_DELIMITER}' line"
                )
            lines_read = 1
            closed = False
            for line in handle:
                lines_read += 1
                if lines_read > MAX_HEADER_LINES:
                    break
                raw = line.rstrip("\r\n")
                if raw == FRONTMATTER_DELIMITER:
                    closed = True
                    break
                # The delimiter is compared exactly (only its line ending is
                # dropped) on both ends of the header; a value is compared after
                # trimming.
                text = raw.strip()
                if not text or text.startswith("#") or ":" not in text:
                    # Not a flat scalar this reader can use: ignored, per above.
                    continue
                key, _, value = text.partition(":")
                key = key.strip().lower()
                if key not in HEADER_KEYS:
                    continue
                # Unquote first, then keep only what a scan is willing to hold:
                # truncating a still-quoted value would cut off its closing quote.
                # This bound refuses to buffer an absurd value; it must never cost
                # the skill, which is strict only about a *missing* description.
                header[key] = _unquoted(value)[:MAX_HEADER_LINE_CHARS]
            if not closed:
                return dropped(
                    f"unparseable frontmatter: {path} has no closing "
                    f"'{FRONTMATTER_DELIMITER}' line"
                )
    except (OSError, UnicodeDecodeError) as exc:
        # ``OSError`` covers the unreadable file and the directory named
        # ``SKILL.md`` alike (``IsADirectoryError`` is one); a decode error is a
        # damaged file, not a damaged process.
        return dropped(
            f"the skill file cannot be read: {path} ({exc})"
        )

    return header, None


# -- the scan: paths in, offered skills out ---------------------------------------

def _skill_from(
    found: SkillPath, header: Dict[str, str]
) -> Tuple[Optional[Skill], List[SkillFinding]]:
    """One discovered path and its header, as the :class:`Skill` to offer (or nothing).

    Lenient on cosmetics, strict on the field the offer is made of. Each finding
    is logged as it is made, here, and returned so the scan hands the same list to
    a caller.
    """
    findings: List[SkillFinding] = []
    folder = os.path.basename(os.path.dirname(found.path))

    def noticed(kind: str, message: str) -> None:
        finding = SkillFinding(kind, message)
        findings.append(finding)
        _log_finding(finding)

    # Strict first, because it decides whether there is anything to say about the
    # skill at all: the description is the only thing relevance is judged from, so
    # a skill without one cannot be offered — and it leaves a trace instead of
    # vanishing quietly.
    description = header.get("description", "")
    if not description:
        noticed(
            KIND_ERROR,
            f"skill skipped, it has no description to offer: {found.path}",
        )
        return None, findings

    # Then the lenient half, and only for a skill that *is* listed: a header
    # `name` that disagrees with the folder is the author's slip, not a reason to
    # hide a working skill — the folder name is the identity either way, and with
    # no UI a dropped skill would be a silent disappearance while a listed one
    # simply works.
    header_name = header.get("name", "")
    if header_name and header_name != folder:
        noticed(
            KIND_NOTE,
            f"skill name mismatch: {found.path} is in a folder named '{folder}' "
            f"and is listed under that name; its header says '{header_name}'",
        )
    # An absent `name` is **not** a finding, on purpose: the folder is the
    # identity, so a third-party skill that never states one is following the
    # convention rather than breaking it, and a log line per skill would be noise
    # about the ordinary case. Do not "fix" this into a finding.

    skill = Skill(
        name=folder,
        description=description,
        path=found.path,
        scope=found.scope,
    )
    return skill, findings


def scan() -> Tuple[List[Skill], List[SkillFinding]]:
    """Every skill the two roots hold, as ``(skills, findings)``.

    The module's public answer, and the one a turn calls: :func:`discover`'s paths,
    each read through :func:`read_header`, each turned into a :class:`Skill` or
    skipped. ``skills`` keeps discovery order — project root first, each root's in
    its sorted listing — because that is the order the catalogue groups by and
    precedence keys on, so nothing here re-sorts it.

    A `Skill` is only ever built for a skill that will be listed, so a caller
    renders what it gets and filters nothing. Findings are returned **and** logged
    as they are made (:func:`_log_finding`), once each.

    Like the walk it builds on, this never raises over a damaged input: a broken
    file costs that skill and one finding. Only the workspace seam's
    :class:`~src.core.workspace.WorkspaceNotScoped` escapes, and it is meant to.
    """
    found, findings = discover()
    skills: List[Skill] = []

    for entry in found:
        header, finding = read_header(entry.path)
        if finding is not None:
            # The file itself was the problem: the skill is skipped, and the
            # finding is already in the list and already logged — the read made
            # it, so the scan only carries it on.
            findings.append(finding)
            continue
        skill, made = _skill_from(entry, header)
        findings.extend(made)
        if skill is not None:
            skills.append(skill)

    return skills, findings


# -- the catalogue: precedence, the caps, and the rendered block -------------------

#: The section the block opens with, in the shape the ``AGENTS.md`` block already
#: is: plain text appended to the system message, not a tool description and not a
#: separate message.
CATALOGUE_HEADING = "## Skills"

#: The prose every catalogue carries, ahead of its entries. Each load-bearing
#: sentence is asserted by a test of its own, and the negative instruction appears
#: twice on purpose ("when the subject matches" and "do not read speculatively"):
#: a model that opens every skill every turn is this feature's biggest cost risk
#: and one hedged sentence does not prevent it. The read-only boundary is written
#: down **here and nowhere else**: no route, tool or policy enforces it, so this
#: text *is* the enforcement and rewriting it loosely removes the rule.
CATALOGUE_PROSE = (
    "A skill is a folder holding a SKILL.md file: packaged know-how for one "
    "specific domain — a procedure, a file format, a house style. The list below "
    "is the catalogue of the skills available here: name, what it is for, and the "
    "path of its SKILL.md.\n\n"
    "When the subject of the conversation matches a skill's description, or when "
    "the user names a skill, read that SKILL.md with your file tools before "
    "answering, and follow what it says. When a skill refers to a relative path "
    "(a script, a reference file), resolve it against the folder holding its "
    "SKILL.md and use the resulting absolute path.\n\n"
    "Do not read a skill speculatively. Each one covers a narrow domain: open it "
    "when the current subject actually matches, and ignore the list when nothing "
    "does.\n\n"
    "Skills are the user's own files. Never create, edit, rename or delete a "
    "skill or anything inside its folder; if a task seems to need that, say so "
    "and give the user the path instead."
)


def _shadowed_finding(kept: Skill, dropped: Skill) -> SkillFinding:
    """The one note for a name two skills claimed.

    It names **both** paths, because the shadowed skill is not broken — it is
    simply not offered — and the only way its author can discover that is a message
    that says which file won and which lost. ``KIND_NOTE`` for the same reason:
    nothing was damaged, so nothing is a warning.
    """
    return SkillFinding(
        KIND_NOTE,
        f"skill shadowed by an earlier one of the same name: '{kept.name}' is "
        f"listed from {kept.path}; {dropped.path} is not listed",
    )


def ranked(items: List[Skill]) -> Tuple[List[Skill], List[SkillFinding]]:
    """The scan's skills, with precedence and shadowing applied.

    ``(kept, findings)``. The **first** skill to claim a name keeps it and the list
    keeps the scan's order, so one rule does both jobs: "project-level wins" and
    "within one root, first-found wins" are the same statement once :func:`scan`
    answers project entries first and each root's in its sorted listing. Nothing
    here re-sorts, and nothing here compares scopes — a second rule would be a
    second thing to keep in agreement.

    Each dropped twin costs one :func:`_shadowed_finding`, logged as it is made
    like every other finding here. The function is **idempotent**: a list that has
    already been ranked has no duplicate names left, so ranking it again drops
    nothing and logs nothing. That is what lets :func:`catalogue_block` apply the
    rule itself without a caller that ranked first paying for it twice.
    """
    kept: List[Skill] = []
    findings: List[SkillFinding] = []
    by_name: Dict[str, Skill] = {}

    for skill in items:
        winner = by_name.get(skill.name)
        if winner is None:
            by_name[skill.name] = skill
            kept.append(skill)
            continue
        finding = _shadowed_finding(winner, skill)
        findings.append(finding)
        _log_finding(finding)

    return kept, findings


def _display_description(description: str) -> str:
    """One description as the catalogue shows it: one line, and bounded.

    Line breaks collapse to single spaces **first**, so an entry is one logical
    line whatever the author wrote — a value folded across lines is their
    formatting, and flat entries are easier for the model to scan.

    The cut to :data:`MAX_CATALOGUE_DESCRIPTION_CHARS` is then **silent, and that
    is a decision, not an omission**: the cap is a display bound rather than a
    fault in the skill, so a finding per long description would bury the findings
    that explain a missing skill.
    """
    return " ".join(description.split())[:MAX_CATALOGUE_DESCRIPTION_CHARS]


def _skills_root_of(skill: Skill) -> str:
    """The skills root one entry's ``SKILL.md`` sits in, derived from its path.

    The renderer groups by this and names each group's heading after it, and it is
    **derived** rather than carried: :class:`Skill` holds no root, because the
    renderer takes a list and fetches nothing — a renderer that consulted
    :func:`skills_roots` itself would read the workspace seam it is not given. Two
    ``os.path.dirname`` calls off the resolved absolute ``SKILL.md`` path answer it.

    A skill folder that is a **symlink** lands under its target's tree here, not
    under the root it was scanned from — the honest thing to name in a heading whose
    job is to tell the model where a file lives, and it matches the path the entry
    itself carries.
    """
    skill_folder = os.path.dirname(skill.path)
    return os.path.dirname(skill_folder)


def _entry_text(skill: Skill) -> str:
    """One catalogue entry: name, description, and an explicit ``path:``.

    The path is the skill's own, absolute and resolved, spelled out rather than
    left to a rule the model would have to apply: it does not know what ``$HOME``
    expands to here, and a naming rule it must get right before it can even attempt
    the read is a failure mode that is cheap to remove. There is deliberately **no**
    ``---`` fence around an entry: inside a system prompt those read as frontmatter
    delimiters, and a flat line carries the same three fields.
    """
    return (
        f"- {skill.name} — {_display_description(skill.description)}\n"
        f"  path: {skill.path}"
    )


def _cap_finding(dropped: int) -> SkillFinding:
    """The one note for the entries the byte cap left out.

    One finding for the whole render, saying how many and why: the skills themselves
    are fine, the block is bounded, and a line per dropped skill would be the same
    sentence repeated.
    """
    return SkillFinding(
        KIND_NOTE,
        f"catalogue reached its size cap of {MAX_CATALOGUE_BYTES} bytes: "
        f"{dropped} skill(s) are not listed",
    )


def catalogue_block(items: List[Skill]) -> str:
    """The rendered catalogue, or ``""`` when there is nothing to inject.

    Two rules a later reader will otherwise break:

    * **it reads no file.** Everything it says comes from the list it is handed —
      the caller (:func:`scan`) did the reading, once, at the turn's start. A
      render that opened a ``SKILL.md`` would be a second read of the same bytes
      and a second policy over them.
    * **``""`` is the "nothing to inject" answer**, exactly as the other
      system-prompt blocks use it: no skills, a list that ranks down to nothing,
      and a block the byte cap leaves with no entry in it all answer ``""`` rather
      than a heading, a placeholder sentence or prose alone. The caller forwards
      that answer as an absent block, which is what makes the block unforgeable
      from a request: a caller can only pass on what this decided.

    The list is ranked here — :func:`ranked` is idempotent, so a caller that ranked
    first costs nothing — so precedence cannot be forgotten by the one caller that
    matters. Entries are then grouped by the root they came from, project first,
    each group under a heading naming **that root's path** so the model can tell a
    project's own know-how from the user's machine-wide set. A scope with no entry
    in it emits no heading at all, and a heading is never written before the first
    entry that will sit under it fits.

    The whole block is bounded to :data:`MAX_CATALOGUE_BYTES` UTF-8 bytes, because
    this text is re-sent on every turn on that workspace. Whole entries are dropped
    from the end when the cap is reached — never a truncated one, because a
    half-path is worse than an absent one — while the prose and the headings of the
    groups that kept an entry are always kept. Anything dropped is reported by one
    logged :func:`_cap_finding`.
    """
    kept, _ = ranked(items)

    # Grouped by the root its entries came from, in the order the roots first
    # appear — which is the scan's order, so project before user without this
    # function consulting :data:`SCOPES` or the workspace seam. The root is
    # derived from each entry's own path (see :func:`_skills_root_of`) because the
    # renderer takes a list and fetches nothing.
    groups: List[Tuple[str, str, List[Skill]]] = []
    index: Dict[str, int] = {}
    for skill in kept:
        root = _skills_root_of(skill)
        where = index.get(root)
        if where is None:
            index[root] = len(groups)
            groups.append((skill.scope, root, []))
            where = index[root]
        groups[where][2].append(skill)

    blocks: List[str] = [f"{CATALOGUE_HEADING}\n\n{CATALOGUE_PROSE}"]
    listed = 0
    dropped = 0
    capped = False

    for scope, root, entries in groups:
        # The heading names the scope *and* the root: the point is that the model
        # can tell a project's know-how from the user's machine-wide set, and a
        # path only says that to a reader who already knows which path is which
        # workspace's. The scope word is what makes the two scopes **named**, which
        # matters because a project skill and a user skill can disagree.
        heading = f"From the {scope} skills root ({root}):"
        lines: List[str] = []
        for skill in entries:
            if capped:
                dropped += 1
                continue
            # Measured as the whole block would be, so the cap bounds the text the
            # model is actually sent rather than each piece on its own.
            candidate = "\n\n".join(
                blocks + ["\n".join([heading] + lines + [_entry_text(skill)])]
            )
            if len(candidate.encode("utf-8")) > MAX_CATALOGUE_BYTES:
                # The cap is reached: this entry and every one after it go, whole.
                # The prose and every heading with an entry under it stay.
                capped = True
                dropped += 1
                continue
            lines.append(_entry_text(skill))
            listed += 1
        # A group whose entries did not fit contributes nothing, heading included:
        # a heading with nothing under it is the answer this must never give.
        if lines:
            blocks.append("\n".join([heading] + lines))

    if dropped:
        # Logged even when nothing fitted at all: a cap that admits no entry is
        # precisely the case a silent "" would leave unexplained.
        _log_finding(_cap_finding(dropped))
    if not listed:
        # Prose and headings alone are not a catalogue: nothing usable is nothing
        # to inject, and the caller must be able to tell that from a string.
        return ""

    return "\n\n".join(blocks)

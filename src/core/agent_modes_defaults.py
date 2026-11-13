"""The words behind the agents: the built-in personas and the app-owned one.

This module holds the four definitions nojae ships — three personas a user may
edit and the one agent it never lets them edit — plus the batch-conventions block
that agent carries. Nothing here reads a file, opens a route or calls a model: it
is vocabulary and rendering.

Why a Python literal rather than rows in the store: the **seeder** reads this
module and the **fallback** reads it too, so a store seeded at boot and a read
over a damaged row answer the same words from one definition. A copy in the schema
would let the two agree by luck.

The personas are **instructions to the model, in the second person**, never
descriptions of a role, and an editable one stays inside ~15 lines: this text is
paid for on every turn of the thread, and an agent's job is to remove options, not
to decorate. The byte cap is :mod:`core.agent_modes`'s to enforce — every entry
here sits an order of magnitude under it, which the module's own self-check holds.

Two rules the tests hold, because prose rots quietly:

* a persona names the other agents only through the label constants below, so a
  rename cannot leave a stale phrase in someone's prompt;
* a persona never claims to have read ``AGENTS.md`` — it says "the project
  instructions above", which is what :func:`config.agent_instructions_block`
  actually puts there, and every agent receives it.
"""

from typing import List, Tuple

from src.core import agent_modes, batch
from src.core.agent_modes import AgentMode

#: The three agent ids nojae seeds, and their dropdown labels. Both are constants
#: because the personas quote the labels in their own first line (see the module
#: docstring): one name per agent, in the code and in the prose.
CHAT_MODE_ID = "chat"
CODE_MODE_ID = "code"
ARCHITECT_MODE_ID = "architect"

CHAT_LABEL = "Chat"
CODE_LABEL = "Code"
ARCHITECT_LABEL = "Architect"

#: The app-owned agent (D4): not among the editable ones, not deletable, and the
#: only one that carries generated blocks.
TODO_BUILDER_MODE_ID = "todoBuilder"
TODO_BUILDER_LABEL = "Todo builder"

# -- the three editable personas ------------------------------------------------
#
# Second-person instructions, not role descriptions. ``code`` is what the app
# already does, plus the "you implement" framing that was missing; the others
# work by taking options away. Each first line names its own agent through the
# label constant, so a rename cannot leave a stale word in someone's prompt.

CHAT_PERSONA: Tuple[str, ...] = (
    "You are a helpful assistant. You can answer questions of every kind, even some not related to the current project or unrelated to software engineering.",
    "If you have tools, you can use them to read files, fetch information from Internet, edit files, etc but **you must not edit, create new files in the current projects directory**.",
)

CODE_PERSONA: Tuple[str, ...] = (
    "You are an experienced senior software engineering working on an active project workspace.",
    "You can use all available tools to accomplish the task that is given to you.",
    "* Always follow the given user instructions or the spec file provided.",
    "* Do not make design choice of your own. When a spec is provided, trust it and implement defined features. When there is a missing piece in user's provided instruction, ask for clarification but do not make up a design choice by your own.",
    "* Do not make up features on your own. You must only add code to handle the provided spec features or the set of instructions given by the user.",
    "* When using tools, report feedback to the user as soon as you can.",
    "* Do not **overthing** and to not **overengineering** solutions to be implemented. Follow the *KISS* principle.",
    "* If a file is bigger than 2000 lines, try to figure out how to split it by refactoring the existing code without breaking the logic.",
    "* Always write unit test cases for the code you have provided.",
    "* During the session, if you find a BUG not related to your task, report it at the end but do not try to fix it.",
    "* Definition of Done is: 1) The feature is implemented, 2) all tests are green.",
)

ARCHITECT_PERSONA: Tuple[str, ...] = (
    "You are an experienced senior software architect working on an active project workspace.",
    "You can use all available tools to accomplish the task that is given to you but:",
    "- Do not modify any source code. You only modify files related to documentation and specification witch are located in **docs** folder.",
    "> If the docs folder does not exist create it.",
    "* The user will provide a draft spec description about a new feature.",
    "* You will focus on it and:",
    "    * Provide guidance to refine the feature.",
    "    * Ask questions to clarify.",
    "    * Provide advise using best practices and common software engineering design patterns.",
    "* You will produce a clean and detailed documentation in markdown format.",
    "* You must not go too much into technical details. Keep focus on the functionnal need. It needs to be crystal clear.",
    "* Keep in mind that this specification file will later be declined into task items.",
)

#: The reserved mode's persona. The lot conventions are **not** in this text:
#: they are the generated block of :func:`lot_conventions_block`, because a
#: prompt that restates a rule the code enforces is a rule that can go stale.
TODO_BUILDER_PERSONA: Tuple[str, ...] = (
    f"You are working in {TODO_BUILDER_LABEL} mode: you turn a feature into a",
    "task lot that the batch runner will later execute one task at a time. You",
    "never implement any of it.",
    "- You must trust the given spec. It contains every thing you need.",
    "- All questions have been resolved in the spec. Do not ask any question.",
    "- Write the lot with the file tools, as markdown, following the lot",
    "  conventions below exactly: one big-picture file, then one per task,",
    "  numbered in execution order.",
    "- Task size is one session with 131K context.",
    "- Every task file says: what to deliver, which files it touches, the rules",
    "  it must not break (quote them from the project instructions), which task",
    "  numbers it depends on, and how to tell it is done. A task must be",
    "  executable by a reader who never saw this conversation.",
    "- Never write a task that is \"implement the feature\", and put no code in",
    "  the lot: a task says *what*, not *how* — except where the how is an",
    "  invariant of this project.",
    "- If the feature is too big for one lot, say so and ask for the big picture",
    "  before writing anything.",
    "- After writing, report the task numbers and titles, and say the lot is",
    "  ready to launch. Do not launch it yourself.",
)


#: The three editable built-ins, in the order the seeder writes them — which is
#: also the dropdown's order. ``todoBuilder`` is deliberately absent (D4): the
#: app-owned agent is rendered from :func:`todo_builder_mode` and sorted last,
#: whatever a table says.
BUILT_IN_MODES: Tuple[Tuple[str, str, bool, bool, Tuple[str, ...]], ...] = (
    (CHAT_MODE_ID, CHAT_LABEL, False, False, CHAT_PERSONA),
    (CODE_MODE_ID, CODE_LABEL, True, True, CODE_PERSONA),
    (ARCHITECT_MODE_ID, ARCHITECT_LABEL, True, False, ARCHITECT_PERSONA),
)


def default_modes() -> List[AgentMode]:
    """The three editable built-in agents — the seeder's and the fallback's one list.

    The store's seeder inserts these rows and :func:`core.agent_modes.resolve_modes`
    answers them when a row is missing, so both read this function rather than a
    copy. The values are validated by the module's own ``_self_check`` below, which
    is where a mistake in a persona or a label is caught — at import, not in a
    workspace.
    """
    return [
        AgentMode(
            id=mode_id,
            label=label,
            system_message="\n".join(persona),
            mcptools=mcptools,
            lsptools=lsptools,
        )
        for mode_id, label, mcptools, lsptools, persona in BUILT_IN_MODES
    ]


# -- the reserved mode ----------------------------------------------------------

def lot_conventions_block() -> str:
    """The conventions a written lot must follow, rendered from ``core/batch.py``.

    These are the runner's rules, and the runner enforces them in code — so the
    prompt quotes the **live constants** instead of restating them in a string
    that can go stale. Every number and folder name below comes from a named
    attribute of :mod:`core.batch` at call time, which is what lets a test patch
    one constant and see this text change (the drift guard).
    """
    separators = " or ".join(f"`{char}`" for char in batch.NUMBER_SEPARATORS)
    return (
        "The lot conventions below are enforced by nojae, not suggestions:\n"
        "a file that does not match them is not a task.\n"
        f"- Lot folder: `{batch.DEFAULT_LOT_DIR}/`, relative to the working location.\n"
        "- File names: `<prefix><NN><sep><slug>.md`, where `<prefix>` matches\n"
        f"  {batch.PREFIX_PATTERN} and `<sep>` is {separators}. The number is a token\n"
        "  of its own: `<prefix>-1x` is a file name, not task 1.\n"
        f"- One file per task. At most {batch.MAX_BATCH_TASKS} tasks.\n"
        "- The NN == 0 file is the lot's big picture; its body is sent as extra\n"
        f"  context on every task turn, capped at {batch.MAX_BATCH_LOT_BYTES} bytes,\n"
        "  so it is the map, not a preamble.\n"
        f"- A task is done when its file has moved into `{batch.DONE_SUBFOLDER}/`. The\n"
        "  runner re-lists the folder and never reads task bodies: the agent opens\n"
        "  its own file. Write each task so a reader who only has that file and the\n"
        "  big picture can finish it."
    )


def todo_builder_persona() -> str:
    """The reserved mode's persona text, joined from its lines."""
    return "\n".join(TODO_BUILDER_PERSONA)


def todo_builder_mode() -> AgentMode:
    """The app-owned agent (D4): persona and instructions rendered from code.

    ``instructions`` carries the generated lot conventions; the chat route renders
    them after AGENTS.md and before the lot's own big picture, so the text stays in
    the same order for a re-read. The store's boot re-asserts this row from here
    for every column but ``model_id``, which is what makes re-seeding safe rather
    than destructive.
    """
    return AgentMode(
        id=TODO_BUILDER_MODE_ID,
        label=TODO_BUILDER_LABEL,
        system_message=todo_builder_persona(),
        mcptools=True,
        lsptools=False,
        readonly=True,
        instructions=(lot_conventions_block(),),
    )


# -- self-check ----------------------------------------------------------------

def _self_check() -> None:
    """Fail at import on the content rules this module states about itself.

    A persona typed over the cap, a label that no longer matches the id the rest
    of the feature keys on, or an id outside the pattern are all mistakes a later
    edit can make silently — and every one of them costs someone their persona text
    on every turn.
    """
    personas = (
        (CHAT_MODE_ID, CHAT_PERSONA),
        (CODE_MODE_ID, CODE_PERSONA),
        (ARCHITECT_MODE_ID, ARCHITECT_PERSONA),
        (TODO_BUILDER_MODE_ID, TODO_BUILDER_PERSONA),
    )
    for mode_id, persona in personas:
        if not persona:
            raise ValueError(f"the {mode_id} persona is empty")
        size = len("\n".join(persona).encode("utf-8"))
        if size > agent_modes.MAX_MODE_SYSTEM_MESSAGE_BYTES // 2:
            raise ValueError(
                f"the {mode_id} persona is {size} bytes, over half the "
                f"{agent_modes.MAX_MODE_SYSTEM_MESSAGE_BYTES} cap"
            )
    declared = [mode_id for mode_id, *_rest in BUILT_IN_MODES]
    if declared != [CHAT_MODE_ID, CODE_MODE_ID, ARCHITECT_MODE_ID]:
        raise ValueError(
            f"the built-in agents are {declared}, expected "
            f"{[CHAT_MODE_ID, CODE_MODE_ID, ARCHITECT_MODE_ID]}"
        )
    for reserved in agent_modes.RESERVED_MODE_IDS:
        if reserved in declared:
            raise ValueError(
                f"the reserved agent {reserved!r} must not be among the editable ones"
            )
    if TODO_BUILDER_MODE_ID not in agent_modes.RESERVED_MODE_IDS:
        raise ValueError(
            f"{TODO_BUILDER_MODE_ID!r} is not in agent_modes.RESERVED_MODE_IDS"
        )
    for mode in [*default_modes(), todo_builder_mode()]:
        if agent_modes._mode_id_problem(mode.id) is not None:
            raise ValueError(f"the built-in id {mode.id!r} is not a usable agent id")
        if agent_modes._label_problem(mode.label) is not None:
            raise ValueError(f"the built-in label {mode.label!r} is not usable")
        if agent_modes._persona_problem(mode.system_message) is not None:
            raise ValueError(f"the {mode.id} persona does not fit its cap")
    if not todo_builder_mode().readonly:
        raise ValueError(f"{TODO_BUILDER_MODE_ID} must be readonly (D4)")


_self_check()


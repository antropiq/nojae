"""The connector wizard's reasoning half: its two questions and their one call.

The wizard ("Set me up!") prepares a declaration entry for the user to paste. This
package is the part that thinks; the dialog renders, and the APIs in
``src/api/routes.py`` carry. It is deliberately small and deliberately narrow,
because what it may *not* do is the whole design
(``docs/mcp-lsp-connector-wizard.md`` §4):

* **it never writes a declaration file.** Nothing here opens a file for writing,
  creates one, or keeps a draft. A declaration entry is created only when absent
  and changed only outside the app; the wizard's product is text.
* **it never starts a process** — no connector, no language server, no trial run
  of a candidate — and **never installs** or downloads anything. Resolving a
  program's path is not starting it, and that one act is task 04's, not this
  package's.
* **it is not a second agent loop.** One call per step, non-streaming and
  tool-less, so nothing is offered to the model to execute and no turn's tool
  loop is re-created behind a dialog.
* **it reads no conversation and joins no session.** Its tokens enter neither the
  session clock nor the cost badges, and no number is ever shown: what the wizard
  displays is whose reasoning it spent, in words.

Layout — one concern per module, and the split is the design:

* :mod:`wizard.prompts` — the two prompts (propose, prepare), the settled
  spellings a snippet is built from, and the strict parse of each answer shape
* :mod:`wizard.modelstep` — the call: one attempt through
  :mod:`core.llmkit`, its three distinguishable outcomes, and no accounting
* :mod:`wizard.snippet` — the three checks that make the prepared member
  trustworthy: the hubs' own loader's verdict, the command *resolved* (never
  spawned), and a duplicate id as a warning — plus the §8 values, in one place

Consumed by the routes (task 05) and, through them, by the wizard's rules and the
dialog. Imported by nothing under the hubs: a hub reads declarations, while
everything here is about a declaration that does not exist yet. The one edge that
does run hub-ward is :mod:`wizard.snippet`'s, and it is deliberate: it calls the
loaders' own per-entry functions so the page and the panel cannot disagree.
"""

from . import modelstep, prompts, snippet

__all__ = ["modelstep", "prompts", "snippet"]

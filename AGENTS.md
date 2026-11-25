# Nojae APP

Nojae is a self-hosted AI workstation made with Python, Vue JavaScript, and the Pico micro framework.

## Technical stack

* A Python backend using FastAPI to communicate with the frontend, with Python sources located in the **src** folder.
* A Vue3 + JavaScript frontend including the Pico small framework for UI & UX design, with sources located in the **web** folder.
* a pyproject-driven backend
* an npm-driven frontend

> The app architecture is scoped to be used by a single user running it locally on a private network.

## Global layout & short description.

The AppBar is always visible and holds the navigation between pages, indicators, and several other UI elements for the entire App surface.

### The workbench page

This page is where interaction between the user and the agent happens, with:

A) on the left column

* A reasoning output panel
* A tools panel with actionable switches

B) on the right column (taking most of the place)

* A conversation rendering panel (also contains images, tool responses, etc.)
* A set of interaction UI elements (buttons, memory bullets) to drive the agentic tasks
* A text area where the user sends messages

Between columns A and B, there is a small caret column with action buttons to toggle the visibility of the reasoning panel.

### The Editor page

This page contains a traditional editor UI with a tree navigator on the left, a Monaco editor on the right, and a terminal panel at the bottom.

### Modal dialogs

1) A Settings dialog to:

* set up servers, models, and inference properties of the models
* toggle MCP connectors on/off
* toggle LSP connectors on/off

2) An Agents settings dialog to:

* Edit an existing agent (select the targeted model, set the persona)
* Create a new agent

## Rules

> This **AGENTS.md** file is owned by the user: You must not edit it yourself unless the user asks you to do so.

### Coding rules

* Always stick to the KISS principle.
* Use intuitive names for files and folders.

#### comments & docstrings

* Comments and docstrings must be **short and provided only to clarify things**
* Comments and docstrings are not the documentation.
* Comments and docstrings must not reference any plan (chapters, line numbers, dated features, etc.).

#### File size

* File size must not exceed 1000 lines.
* If a file has more than 1000 lines, consider refactoring it by domain.

#### Test cases

* Must be written to test features, not to test wording or comment availability.
* Must run fast.
* Never run all test suites unless the user asks you to do so.
* When you are validating a task, run only the test cases that are in the perimeter of that task.

> There is a set of 3 test suites: the Python suite, the frontend unit test suite, and the e2e test suite.

> Do not over-test.

## bugs

If, while you are doing a coding task, you believe a bug is present, report it in a **bugs.md** file.
Do not try to fix it.

> You must focus first on the user-expressed requirements.
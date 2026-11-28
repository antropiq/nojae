"""The store's one failure type: the sentence that names an unusable store."""

# -- the failure ---------------------------------------------------------------


class AppStoreError(Exception):
    """The settings store cannot be opened, read or used at this level.

    Carries the one sentence that names the path — the sentence the boot turns
    into the app bar's "the settings store is unusable" notice and the chat
    refusal.

    Raised rather than collected as a finding because every state it reports
    leaves the store with **no answer to give**: an unreadable file, a file that
    is not a database, a schema this app does not understand. A caller that
    caught nothing would run on an empty store, which is the silent default this
    app refuses everywhere else.
    """

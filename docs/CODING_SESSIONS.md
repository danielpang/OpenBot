# Coding conversations

## iOS

Open **Code** from the tab bar or tablet sidebar, or a bot's coding sessions from its chat. Session cards show the title and repository. A session shows the agent's transcript, expandable tool actions, approvals, activity and a shared bot-chat composer.

- Send follow-up messages after a turn ends. Drafts are kept while the agent works.
- The edit-mode control appears only while the input is focused. It opens a small in-app glass menu, not a system action sheet.
- The keyboard moves the composer above it.
- Completed sessions show no “Done” heading.

## Web and Mac

- The bot header has Computer and Code icons side by side. The coding drawer can be filtered to that bot. The session header has no “Open in chat” action.
- **+** beside the coding composer attaches screenshots/images or files, or sets an edit-approval mode. Images/files can also be pasted or dropped into the input.
- Send is enabled once uploads finish. Failures preserve the draft, and failed attachments can be removed and uploaded again.
- Attachment-only messages use a short default prompt.
- Each turn accepts up to 10 files, at most 20 MiB per file and 50 MiB total, subject to the account's upload limit.

The server verifies attachment ownership and purpose, then stages copies in a fresh directory under `/home/bot/repos/.openbots-attachments-*`, outside git worktrees. The agent gets local reference paths (and can inspect screenshots with its image-reading tool). Files are not automatically committed and stay on the computer for later turns. Failed staging and rejected session transitions clean up their staging directory.

## Choosing the agent and model

Settings > Coding agents has a **Defaults** card: a default agent (Claude Code, Codex or pi) and a default model per agent, typed as that agent's CLI names it (suggestions are offered). A Bot's own settings, under Tools and permissions, override them.

If neither the Bot nor your defaults name both an agent and a model when a coding task starts, the Bot shows a **Choose a coding agent** card in the chat. Pick the agent, pick or type the model, and leave "Use as my default" ticked so later tasks do not ask. Cancel tells the Bot not to start. A continued session keeps its original agent and model.

## Edit approvals

“Ask before edits” is the default. “Accept edits” updates the ordinary bot file-write/edit rules and the coding-edit rule; other configured policies are preserved. Bot settings and approval cards expose the same setting.

“Accept edits” is not a bypass-permissions mode:

- Pushes, pull requests, installs, destructive commands and writes outside the worktree keep their own policies.
- Explicit coder-action denials and trigger policy floors still apply.
- Plan mode stays read-only.

The runner refreshes policy for later permission prompts. Vendor sandbox changes apply on the next turn.

Codex's known empty PR-confirmation elicitation form is bridged to OpenBots Approve/Decline cards; other elicitation forms are not answered automatically. A previously rejected PR request must be retried: Accept edits does not approve it retroactively.

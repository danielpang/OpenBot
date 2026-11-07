# Coding conversations

## iOS

Open **Code** from the tab bar or tablet sidebar, or open a bot's coding sessions from its chat. Session cards show the title and repository. A session displays the agent's transcript, expandable tool actions, approvals, activity, and a shared bot-chat composer. Follow-up messages can be sent after a turn ends; drafts remain available while it works.

The edit-mode control appears only while the input is focused. Tap it for a small in-app glass menu, not a system action sheet. The keyboard moves the composer above it. A completed session does not show a redundant “Done” heading.

## Web and Mac

The bot header has Computer and Code icons side by side. The coding drawer can be filtered to that bot. There is no “Open in chat” action in the session header.

Click **+** beside the coding composer to attach screenshots/images or files, or choose an edit-approval mode. Images/files can also be pasted or dropped into the input. Uploads must finish before Send is enabled; failures preserve the draft. Failed attachments can be removed and uploaded again. Attachment-only messages use a short default prompt.

Each turn accepts up to 10 files, at most 20 MiB per file and 50 MiB total, subject to the account's upload limit. The server verifies attachment ownership and purpose, then stages copies in a fresh directory under `/home/bot/repos/.openbots-attachments-*`, outside git worktrees. The agent receives local reference paths (and can inspect screenshots with its image-reading tool); these are not automatically committed. Files are retained on the computer for subsequent turns. Failed staging and rejected session transitions clean up their staging directory.

## Edit approvals

“Ask before edits” is the default. “Accept edits” updates ordinary bot file-write/edit rules and the coding-edit rule; other configured policies are preserved. Bot settings and approval cards expose the same setting.

This is not a bypass-permissions mode. Pushes, pull requests, installs, destructive commands and writes outside the worktree still use their own policies. Explicit coder-action denials and trigger policy floors remain in effect. The runner refreshes policy for subsequent permission prompts; changes to the vendor sandbox take effect on the next turn. Plan mode stays read-only.

Codex's known empty PR-confirmation elicitation form is bridged to OpenBots Approve/Decline cards. Other elicitation forms are not answered automatically. A previously rejected PR request must be retried; enabling Accept edits does not retroactively approve it.

# UI removal pass (principle 10)

Part of the 1.0 gate ([TECHNICAL_PLAN.md](TECHNICAL_PLAN.md) 18.9). Every control in the web app is listed here with one question: **did this help someone delegate, or did it give them one more thing to manage?** Reviewed on 2026-10-24 against `apps/web/src` and the widget renderers in `packages/widgets/src/renderers`, and brought up to date on 2026-10-29 for the controls merged since: the setup wizard, the main Bot toggle, Thinking, usage, the sign-in request widget, the form and table widgets, attachments, Memory's Add, template visibility, users and invites, and the audit log.

**Verdicts:**

- **Keep**: it helps someone delegate, or a "Must" in [PRD.md](PRD.md) requires it.
- **Removed**: removed in this pass.
- **Filed**: it fails the bar, but the fix is bigger than a removal. Each one is listed under [Filed](#filed) with what to do.

The lens comes from the PRD principles. Runs, queues, models, sandboxes and MCP sessions stay beneath the interface (principle 2). Detail is tiered, and the activity log is the on-demand tier (principle 4). Coordination belongs to the Bots, not to dashboards (principle 8).

## Removed in this pass

| Control                                                                                       | Where                                                              | Why                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Enabled" checkbox in the Routine form                                                        | `apps/web/src/features/routines/routines-tab.tsx`                  | It duplicated the row's Pause/Resume and the `routine_run` widget's "Pause Routine". It was one more field on every edit. New Routines start enabled; pausing is one click on the row. |
| Model ID and token counts in the activity log footer                                          | `apps/web/src/features/transcript/activity-log.tsx`, `activity.ts` | Agent metadata, which is what Grok Bot removed. The footer keeps what reassures: the status when the run did not complete, the error, how long it took, and the cost estimate (L4).    |
| Raw built-in tool names (`web_search`, `http_request`, …) beside their labels in Bot Settings | `apps/web/src/features/tools/bot-tools.tsx`                        | The label already says it ("Web search"). The legend now reads "Hosts HTTP request may call".                                                                                          |

Also in this pass, a fix rather than a removal: the approval widget's stored state now keeps who decided and when (`apps/server/src/services/approvals.ts` `decision`, `services/runs.ts`). Before, a reload showed a request the run's cancellation had closed as "Denied by you", without a time.

## Every control

### App shell and sidebar

| Control                                                              | Verdict | Answer                                                                                                                                                         |
| -------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New (⌘N / Ctrl+N)                                                    | Keep    | B2. One entry point for a Bot or a group.                                                                                                                      |
| Tools, Skills, Computer, Settings links                              | Keep    | The account-level objects (principle 7).                                                                                                                       |
| Bot row (avatar, name, label; hover tooltip with the current action) | Keep    | B1, I2, I3.                                                                                                                                                    |
| Right-click menu: Pin/Unpin, Hide/Show, Duplicate, Delete            | Keep    | B1, B5, B7. Duplicate and Delete are also in Bot Settings. The menu has no visible trigger, so Settings is the discoverable path and the menu is the fast one. |
| "Show hidden (N)" toggle                                             | Keep    | B1: hidden Bots must stay reachable without deletion.                                                                                                          |
| Group rows                                                           | Keep    | C4.                                                                                                                                                            |

### New dialog

| Control                                                            | Verdict | Answer                                                                                |
| ------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------- |
| Icon (preview, Moon/Box/Egg shape, Shuffle), name field and Create | Keep    | B2: a name and an icon are all a Bot needs; it then asks in its chat what to work on. |
| New chat: Bot checkboxes, group name, Back, Start chat             | Keep    | C4.                                                                                   |
| Dialog Close (X)                                                   | Keep    |                                                                                       |

### Setup wizard (first run)

| Control                                                                                    | Verdict | Answer                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Admin account: Name, Email, Password                                                       | Keep    | U1: the first user becomes the admin.                                                                                            |
| Provider keys: a key field per built-in provider (tested on save), Continue once one works | Keep    | L1: "the first-run wizard asks for at least one". Custom model providers wait for Settings, so the step stays one field per row. |
| First Bot: Name, Model, Create Bot                                                         | Keep    | D1, B2. The sandbox image pulls in the background with a status line, not a control.                                             |

### Sign-in and sign-up

| Control                                                             | Verdict | Answer                          |
| ------------------------------------------------------------------- | ------- | ------------------------------- |
| Email, password, name fields; Sign in / Sign up; links between them | Keep    | U1.                             |
| Continue with GitHub / Google                                       | Keep    | U1. Shown only when configured. |

### Bot view

| Control                                                   | Verdict | Answer                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs: Chat, Routines, Artifacts, Memory, Settings         | Keep    | B4, R3, A4, M2, B3.                                                                                                                                                                                                          |
| Computer status icon                                      | Keep    | I5, K3 "Status".                                                                                                                                                                                                             |
| Preview toggle; Open full screen; Take control; Hand back | Keep    | K3. These are the three levels, and nothing more. Hand back also syncs the screen's cookies to every Bot's browser (K1), with nothing to press. A sign-in request's Take over opens this same view on the sign-in page (K8). |

### Transcript and composer

| Control                                                                                   | Verdict | Answer                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message box (Enter sends, Shift+Enter adds a line, paste or drop to attach), Attach, Send | Keep    | C1.                                                                                                                                                                                                  |
| `/` Skill picker and the Skill chip's Remove                                              | Keep    | S2.                                                                                                                                                                                                  |
| `@` mention picker, `@everyone`, "Adds to the group"                                      | Keep    | C4, C5.                                                                                                                                                                                              |
| Remove attachment                                                                         | Keep    |                                                                                                                                                                                                      |
| Stop                                                                                      | Keep    | The one way to take back a job. It does not appear in groups: filed as UI-7.                                                                                                                         |
| Load earlier messages                                                                     | Keep    | Scrolling to the top does the same thing, but the button is the keyboard and screen-reader path.                                                                                                     |
| "N replies", Reply in thread (hover)                                                      | Keep    | C7. The hover action starts a thread, and the count opens an existing one.                                                                                                                           |
| Activity (hover)                                                                          | Keep    | I4, the on-demand tier.                                                                                                                                                                              |
| React; reaction chips; emoji picker                                                       | Keep    | C8.                                                                                                                                                                                                  |
| "Thinking…/Thought" disclosure                                                            | Keep    | On demand and closed by default (principle 4).                                                                                                                                                       |
| Tool activity line "label · N steps"                                                      | Keep    | C2: one folded line instead of a row per call.                                                                                                                                                       |
| Image link, file card, artifact card, event row links                                     | Keep    | C2, W1, W3. Event rows carry system events (computer started, connector needs login, Bot loop stopped, no Bot could decide in a group); a Routine's result is its run widget, not an event row (W3). |
| "With other Bots (N)" and the pair transcripts                                            | Keep    | C6: Bot-to-Bot exchanges stay visible to the owner.                                                                                                                                                  |

### Right panel

| Control                                                                                              | Verdict       | Answer                                         |
| ---------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------- |
| Close (Activity, Thread, Preview, Artifact)                                                          | Keep          |                                                |
| Activity log: steps with durations; footer                                                           | Keep, trimmed | I4. Model ID and token counts removed (above). |
| Thread: Load earlier replies, thread composer                                                        | Keep          | C7.                                            |
| Artifact viewer: Edit, Save, Cancel, Compare with its two version selects, Download, version history | Keep          | A2.                                            |

### Routines tab

| Control                                                                                                                                                | Verdict | Answer                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| New Routine; Run now; Pause/Resume; Edit; Delete; Runs disclosure; a run's Activity log                                                                | Keep    | R1, R3, R4.                                                                                                                |
| Form: name, prompt, Skill, Starts (schedule or event), schedule fields, event fields, Cancel, Create/Save                                              | Keep    | R1, R2.                                                                                                                    |
| Form: Enabled checkbox                                                                                                                                 | Removed | Duplicated Pause/Resume.                                                                                                   |
| Form: Timezone (free text)                                                                                                                             | Filed   | UI-5: a free-text IANA name is one more thing to get right.                                                                |
| Schedule: Repeats, Day, Date, Time, Interval; Cron (only under "Custom")                                                                               | Keep    | R1 names every preset and custom cron. Cron appears only when chosen.                                                      |
| Event: Source, Event, Repository, Label, Channel ID, Emoji, Channel name, Text contains; webhook conditions (field path, operator, value, Add, Remove) | Keep    | R2: "each trigger has a narrow matching rule". "Channel ID" is Slack's own identifier, which the person copies from Slack. |

### Webhooks (the inbox in Bot Settings, each Routine's endpoint with its Routine)

The people using these controls are writing a script or wiring a service. The HTTP details are their contract, so the raw headers, JSON, 202 and HMAC wording stay.

| Control                                                                                                                                                                                                                                                                        | Verdict | Answer                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate token (the inbox and a Routine's endpoint start without one) / Add endpoint; Rotate token; Settings; Delete; the shown-once Token and Signing secret with Done                                                                                                        | Keep    | H1, H2, H3, P3. Every Bot has its inbox, every event Routine is made with its endpoint, and a duplicated event Routine shows Add endpoint rather than the source Bot's. |
| Endpoint settings: Verification, Signature header, Signing secret, Response (async or sync), Wait up to, Rate limit, Allowed IPs, Template, tool overrides (Tools that change something, Built-in tools, Connector tools: Ask first or Never), Accept deliveries, Cancel, Save | Keep    | H3, H4, H2, plan 4.7. The overrides offer only stricter choices because the policy engine ignores a looser one.                                                         |
| Deliveries: Activity log, Replay, Headers and body, Whole body; test payload, test headers, Send test event                                                                                                                                                                    | Keep    | H5. A refused delivery has no Replay.                                                                                                                                   |

### Artifacts and Memory tabs

| Control                                                            | Verdict | Answer                                                                                                                                               |
| ------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact rows                                                      | Keep    | A4.                                                                                                                                                  |
| Memory: Edit, Save, Cancel, Delete                                 | Keep    | M2. Delete has no confirmation: filed as UI-6.                                                                                                       |
| Memory: Add memory (kind, text, Add); the kind select when editing | Keep    | M2: "view, edit, and delete", and the owner can tell a Bot something to keep without a conversation. A new kind is a select of three, not free text. |

### Bot Settings

| Control                                                                                                                                                                                | Verdict     | Answer                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, Label, Description, avatar editor (Shuffle, Upload image, Use a generated avatar, part pickers), Save                                                                            | Keep        | B3, I1.                                                                                                                                                                                                                |
| Model picker                                                                                                                                                                           | Keep, filed | L4. Each option reads "name · 200k context · $3/$15 per 1M", and a missing model shows its raw ID: filed as UI-1.                                                                                                      |
| Add a provider link                                                                                                                                                                    | Keep        |                                                                                                                                                                                                                        |
| Duplicate; Delete… with "Hide instead"                                                                                                                                                 | Keep        | B5, B7 ("recommends hiding instead").                                                                                                                                                                                  |
| Tools and permissions: per-group and per-tool decision selects, host allowlist radios and list, connector checkboxes with their approval select, per-tool checkboxes and selects, Save | Keep        | T1, T5. Built-in raw names removed (above). Connector tools still show the MCP tool name, the only name a server gives: filed as UI-4.                                                                                 |
| Skills: per-Skill checkbox, Save Skills                                                                                                                                                | Keep, filed | S2. Bot Settings has three separate Save buttons (profile, tools, Skills): filed as UI-2.                                                                                                                              |
| Main Bot checkbox                                                                                                                                                                      | Keep        | K8 puts it in Bot Settings. One checkbox, saved as it is clicked, with a line naming the current main Bot when it is another one, so turning it on never surprises.                                                    |
| Thinking select (Off, On, On with low, medium or high effort)                                                                                                                          | Keep        | Shown only when the chosen model reasons, beside the model it tunes. Off is the default, so a person who never opens it loses nothing.                                                                                 |
| Usage: period select (7, 30 or 90 days), totals and the by-model table                                                                                                                 | Keep        | Plan 5.8. Cost is what an owner watches when they delegate, and it lives here rather than in the transcript (principle 10). Token counts sit beside the estimate because a model without pricing has no other measure. |

### Account settings

| Control                                                                                                                                                                               | Verdict     | Answer                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs: Account, Models, Events, Admin                                                                                                                                                  | Keep        |                                                                                                                                                                                     |
| Sign out; browser notifications "Turn on"                                                                                                                                             | Keep        | N1.                                                                                                                                                                                 |
| API keys: name, Create, the shown-once key, Revoke                                                                                                                                    | Keep        | U4. Revoke has no confirmation: filed as UI-6.                                                                                                                                      |
| Models: key fields, Add custom model provider, Replace/Save key/Cancel, Test, Delete, Models disclosure, small-model select                                                           | Keep        | L1 to L5. These are admin surfaces; a person who adds a custom model provider is the audience for base URLs and protocols.                                                          |
| Model editor: enable, capability flags, context, max output, prices, Remove, Model id + Add model, Discover models, Save models, Discard                                              | Keep        | L3, L4: "users can edit them for custom model providers".                                                                                                                           |
| Add custom model provider: Preset, Name, Base URL, Protocol, API key, Extra headers, Models, Add provider, Add and discover                                                           | Keep        | L2.                                                                                                                                                                                 |
| Events: Add subscription, Pause/Resume, Edit, Rotate secret, Delete, Deliveries; form with URL and event checkboxes                                                                   | Keep        | H6. The event names are the payload's `type`, which the receiving script switches on.                                                                                               |
| Admin: Signup mode, the limits, Save                                                                                                                                                  | Keep, filed | U3. The limits read in bytes: filed as UI-3. They now include Skills per account and the three webhook rates.                                                                       |
| Admin, users and invites: invite Email (optional), Role, Create invite link; the shown-once link with Copy; pending invites with Revoke; each member's Role select and Disable/Enable | Keep, filed | U1, U3. Invites are how `invite` and `first_user_admin` admit anyone. Disable is undone by Enable, so it needs no confirmation; Revoke on an invite has none either: added to UI-6. |
| Admin, audit log: Action, Actor id, From, To, Filter, Load more                                                                                                                       | Keep, filed | Plan 17 (S-11): the admin's record of who did what. Actor id takes a raw user id: filed as UI-8.                                                                                    |

### Connectors page

| Control                                                                                                         | Verdict | Answer                                                 |
| --------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------ |
| Catalog Add and its form (params, OAuth client fields, Add, Cancel)                                             | Keep    | T2.                                                    |
| Add custom MCP server (name, stdio or HTTP, command, environment, URL, sign-in, token, Add server); Import JSON | Keep    | T2 names the custom form and pasted `mcpServers` JSON. |
| Connector card: Test, Log in, Tools, Settings, Delete with inline confirm; settings form                        | Keep    | T2.                                                    |
| Admin block list: catalog checkboxes, URL and command patterns, Save                                            | Keep    | T3.                                                    |

### Skills page

| Control                                                                                      | Verdict | Answer  |
| -------------------------------------------------------------------------------------------- | ------- | ------- |
| New Skill; Skill rows; editor (Back, Name, Content, Create/Save, Delete with a second click) | Keep    | S1, S3. |

### Computer page

| Control                                                                 | Verdict | Answer                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start, Stop, terminal with Reconnect                                    | Keep    | K1, K7. The page lives under the account, not in the chat (principle 5). It says what carries over between Bots: files, and logins through the browsers' cookies, while site data kept only in local storage stays with one Bot (K1). |
| Files: breadcrumbs, folders, downloads, Upload                          | Keep    | K7.                                                                                                                                                                                                                                   |
| Attachments: file name (downloads it), the chat it came from, Load more | Keep    | C1, plan 12.1. The files the owner attached in chats, findable again without scrolling a transcript. Read only, so it adds nothing to manage.                                                                                         |

### Widgets in the transcript

| Control                                                                   | Verdict     | Answer                                                                                                                                           |
| ------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approval: Details, Note, Approve, Deny, Reply in thread                   | Keep, filed | P1, T5. Details is closed by default and is where a person checks what they approve. The header reads "Run `tool_name`?": filed as UI-4.         |
| Question: options, Answer, Send                                           | Keep        | W1, W2.                                                                                                                                          |
| Email draft: From, To, Cc, Subject, Body, Send                            | Keep        | W1, W2.                                                                                                                                          |
| Artifact card: Open, Download; File card: name, Download                  | Keep        | A2, W1.                                                                                                                                          |
| Event row link (Open Tools, Open)                                         | Keep        | W3: the one action that fixes the event.                                                                                                         |
| Routine created: Open Routines; Routine proposal: Create Routine, Not now | Keep        | R5.                                                                                                                                              |
| Routine run: Activity log, Run again, Pause Routine                       | Keep        | R3: "handle an exception there", without leaving the transcript. W3 makes this widget, not an event row, the Routine's result for these actions. |
| Skill draft: name, content, Save                                          | Keep        | S3.                                                                                                                                              |
| Form: the Bot's fields and its submit button                              | Keep        | W1, W2. After submitting it shows the values, disabled.                                                                                          |
| Table and chart: a column header sorts                                    | Keep        | W1. Read only; sorting is the one control, and the chart's data table uses the same one.                                                         |
| Sign-in request: Take over, Done, Can't sign in                           | Keep        | K8. Take over opens the Bot's screen on the sign-in page; Done and Can't sign in answer every Bot waiting on the site at once.                   |
| Unknown widget fallback                                                   | Keep        | Shown for a kind without a renderer or with invalid props. Every W1 kind has a renderer now.                                                     |

## Filed

| ID   | Control                                                              | What to do                                                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI-1 | Model picker option text and the "(unavailable)" fallback            | Show the model's name only. The capability filter already hides models that don't fit. Move context and price to a hint for the chosen model, and name a missing model by its display name with "no longer available". |
| UI-2 | Three Save buttons in Bot Settings                                   | One Save for the profile, tools and Skills, or save each change as it is made.                                                                                                                                         |
| UI-3 | Admin limits in bytes                                                | Show megabytes for the upload and webhook payload limits.                                                                                                                                                              |
| UI-4 | Raw tool names in the approval header and connector tool lists       | Use the policy summary ("Running rm -rf build") or the MCP tool's `annotations.title` when the server sends one. Keep the raw name in Details.                                                                         |
| UI-5 | Routine Timezone as free text                                        | A select of IANA zones, defaulting to the browser's.                                                                                                                                                                   |
| UI-6 | Memory Delete, API key Revoke and invite Revoke without confirmation | A two-click confirm, as Skills and connectors have.                                                                                                                                                                    |
| UI-7 | No Stop in group chats                                               | Show Stop for each Bot working in the group, as a Bot's transcript does.                                                                                                                                               |
| UI-8 | Audit log "Actor id" filter                                          | A select of members (and "Bots" and "System"), so an admin never types an id.                                                                                                                                          |

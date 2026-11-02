// One-line activity labels (plan 6.2, I3, I4), made from the tool call alone:
// no model call, so they are instant and cheap. Without a result the label
// says what is happening ("Editing math.ts", the hover text while a tool
// runs); with one it says what happened ("Edited math.ts +14 −10", the
// activity log entry).

/** Connector name and tool title for MCP tools, from `connector_tools`. */
export interface LabelContext {
  connectorName?: string;
  toolTitle?: string;
}

/** Below this an LLM step reads "Thought briefly". */
export const BRIEF_THOUGHT_MS = 5_000;

const MAX_DETAIL = 60;

type Args = Record<string, unknown>;

export function labelFor(
  toolName: string,
  args: unknown,
  result?: unknown,
  context: LabelContext = {},
): string {
  const a = asRecord(args);
  const r = result === undefined ? undefined : asRecord(result);
  const done = result !== undefined;

  // A screen tool while the owner has taken the screen over (plan 9.4).
  if (r?.status === 'owner_has_screen') return 'Waiting: the owner has the screen';

  switch (toolName) {
    case 'computer_start': {
      const ms = num(r?.durationMs);
      if (!done) return 'Starting environment';
      return ms === undefined ? 'Environment ready' : `Environment ready ${Math.round(ms)}ms`;
    }
    case 'edit_file': {
      const file = baseName(a.path);
      if (!done) return `Editing ${file}`;
      const added = num(r?.added);
      const removed = num(r?.removed);
      const diff =
        added === undefined && removed === undefined ? '' : ` +${added ?? 0} −${removed ?? 0}`;
      return `Edited ${file}${diff}`;
    }
    case 'read_file':
      return `${done ? 'Read' : 'Reading'} ${baseName(a.path)}`;
    case 'write_file':
      return `${done ? 'Wrote' : 'Writing'} ${baseName(a.path)}`;
    case 'list_dir':
      return `${done ? 'Listed' : 'Listing'} ${a.path ? baseName(a.path) : 'home'}`;
    case 'browser_snapshot':
      return done && str(r?.url)
        ? `Read page ${host(r?.url)}`
        : done
          ? 'Read page'
          : 'Reading page';
    case 'browser_click': {
      const what = clip(str(a.element) ?? str(a.ref) ?? 'element');
      return `${done ? 'Clicked' : 'Clicking'} ${what}`;
    }
    case 'browser_type':
      return `${done ? 'Typed' : 'Typing'} '${clip(str(a.text) ?? '')}'`;
    case 'browser_press':
      return `${done ? 'Pressed' : 'Pressing'} ${clip(str(a.key) ?? 'key')}`;
    case 'browser_screenshot':
      return done ? 'Took screenshot' : 'Taking screenshot';
    case 'computer':
      return computerLabel(a, done);
    case 'bash': {
      const command = clip(firstLine(str(a.command) ?? ''));
      if (!done) return `Running ${command}`;
      const exitCode = num(r?.exitCode);
      if (exitCode !== undefined && exitCode !== 0) return `Ran ${command}: exit ${exitCode}`;
      const passed = passedCount(r);
      return passed === undefined ? `Ran ${command}` : `Ran ${command}: ${passed} passed`;
    }
    case 'browser_navigate':
      return `${done ? 'Opened' : 'Opening'} ${host(a.url)}`;
    case 'web_search':
      return `${done ? 'Searched' : 'Searching'} web '${clip(str(a.query) ?? '')}'`;
    case 'web_fetch':
      return `${done ? 'Read' : 'Reading'} ${host(a.url)}`;
    case 'http_request': {
      const method = (str(a.method) ?? 'GET').toUpperCase();
      const status = num(r?.status);
      if (!done) return `Calling ${method} ${host(a.url)}`;
      return `Called ${method} ${host(a.url)}${status === undefined ? '' : `: ${status}`}`;
    }
    case 'read_inbox': {
      const count = Array.isArray(r?.messages) ? r.messages.length : undefined;
      if (!done) return 'Reading inbox';
      return count === undefined ? 'Read inbox' : `Read inbox: ${count} messages`;
    }
    case 'attach_file':
      return done && str(r?.name) ? `Attached ${clip(str(r?.name)!)}` : 'Attaching file';
    case 'create_artifact':
      return `${done ? 'Created' : 'Creating'} "${clip(str(a.title) ?? 'artifact')}"`;
    case 'update_artifact': {
      const title = str(r?.title);
      if (!done || !title) return done ? 'Updated artifact' : 'Updating artifact';
      const added = num(r?.added);
      const removed = num(r?.removed);
      const diff =
        added === undefined && removed === undefined ? '' : ` +${added ?? 0} −${removed ?? 0}`;
      return `Updated "${clip(title)}"${diff}`;
    }
    case 'read_artifact': {
      const title = str(r?.title);
      if (!done || !title) return done ? 'Read artifact' : 'Reading artifact';
      return `Read "${clip(title)}"`;
    }
    case 'publish_artifact':
      return `${done ? 'Published' : 'Publishing'} ${baseName(a.path)}`;
    case 'artifact_to_computer':
      return `${done ? 'Copied artifact to' : 'Copying artifact to'} ${baseName(a.path)}`;
    case 'read_attachment': {
      const name = str(r?.name);
      if (!done || !name) return done ? 'Read attachment' : 'Reading attachment';
      return `Read ${clip(name)}`;
    }
    case 'attachment_to_computer':
      return `${done ? 'Copied attachment to' : 'Copying attachment to'} ${baseName(a.path)}`;
    case 'show_widget':
      return `${done ? 'Showed' : 'Showing'} ${sentenceCase(str(a.kind) ?? 'widget').toLowerCase()}`;
    case 'ask_user':
      return `${done ? 'Asked' : 'Asking'} '${clip(str(a.question) ?? '')}'`;
    case 'remember':
      return `${done ? 'Remembered' : 'Remembering'} '${clip(str(a.content) ?? '')}'`;
    case 'search_memory':
      return `${done ? 'Searched' : 'Searching'} memory '${clip(str(a.query) ?? '')}'`;
    case 'react':
      return `${done ? 'Reacted' : 'Reacting'} ${str(a.emoji) ?? ''}`.trim();
    case 'request_login':
      return `${done ? 'Asked' : 'Asking'} for a sign-in to ${clip(str(a.site) ?? 'a site')}`;
    case 'message_bot':
      return `${done ? 'Messaged' : 'Messaging'} @${str(a.handle)?.replace(/^@/, '') ?? 'a Bot'}`;
  }

  if (isMcpTool(toolName)) return mcpLabel(toolName, context);
  // The GitHub built-in reads like a connector: "GitHub: Create issue".
  if (toolName.startsWith('github_')) return `GitHub: ${sentenceCase(toolName.slice(7))}`;
  return sentenceCase(toolName);
}

/** Pixel-mode actions, under the plan's names or Anthropic's native ones. */
function computerLabel(a: Args, done: boolean) {
  const action = str(a.action) ?? '';
  const at = Array.isArray(a.coordinate) ? ` at ${a.coordinate.join(', ')}` : '';
  switch (action) {
    case 'screenshot':
    case 'zoom':
      return done ? 'Took screenshot' : 'Taking screenshot';
    case 'click':
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'triple_click':
    case 'double_click':
      return `${done ? 'Clicked' : 'Clicking'}${at}`;
    case 'type':
      return `${done ? 'Typed' : 'Typing'} '${clip(str(a.text) ?? '')}'`;
    case 'key':
    case 'hold_key':
      return `${done ? 'Pressed' : 'Pressing'} ${clip(str(a.text) ?? 'key')}`;
    case 'scroll': {
      const direction = str(a.direction) ?? str(a.scroll_direction) ?? 'down';
      return `${done ? 'Scrolled' : 'Scrolling'} ${direction}`;
    }
    case 'move':
    case 'mouse_move':
      return `${done ? 'Moved' : 'Moving'} the mouse${at}`;
    case 'drag':
    case 'left_click_drag':
      return done ? 'Dragged' : 'Dragging';
    case 'wait':
      return done ? 'Waited' : 'Waiting';
    default:
      return done ? 'Used the screen' : 'Using the screen';
  }
}

/** An LLM step with no tool call: "Thought briefly", "Thought for 12s". */
export function thoughtLabel(durationMs: number): string {
  if (durationMs < BRIEF_THOUGHT_MS) return 'Thought briefly';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `Thought for ${seconds}s`;
  const rest = seconds % 60;
  return `Thought for ${Math.floor(seconds / 60)}m${rest ? ` ${rest}s` : ''}`;
}

/** A run waiting on the owner: "Waiting for approval: send email". */
export function approvalWaitLabel(toolName: string, context: LabelContext = {}): string {
  const action = isMcpTool(toolName)
    ? mcpLabel(toolName, context)
    : sentenceCase(toolName).toLowerCase();
  return `Waiting for approval: ${action}`;
}

/** Connector tools are named `${connectorSlug}__${toolName}` (plan 5.4). */
function isMcpTool(toolName: string) {
  const at = toolName.indexOf('__');
  return at > 0 && at < toolName.length - 2;
}

/** "GitHub: Create issue": connector name plus tool title. */
function mcpLabel(toolName: string, { connectorName, toolTitle }: LabelContext) {
  const at = toolName.indexOf('__');
  const connector = connectorName ?? titleCase(toolName.slice(0, at));
  const title = toolTitle ?? sentenceCase(toolName.slice(at + 2));
  return `${connector}: ${title}`;
}

/** `create_issue` and `createIssue` become "Create issue". */
function sentenceCase(name: string) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const text = words.join(' ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : name;
}

function titleCase(slug: string) {
  return slug
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** "212 passed" from a test runner's output, when the tool did not count. */
function passedCount(result: Args | undefined): number | undefined {
  const counted = num(result?.passed);
  if (counted !== undefined) return counted;
  const output = [str(result?.stdout), str(result?.output)].filter(Boolean).join('\n');
  const matches = [...output.matchAll(/\b(\d+)\s+(?:tests?\s+)?passed\b/gi)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : undefined;
}

function host(url: unknown) {
  const text = str(url) ?? '';
  try {
    return new URL(text).hostname.replace(/^www\./, '');
  } catch {
    return clip(text);
  }
}

function baseName(path: unknown) {
  const text = (str(path) ?? '').replace(/[/\\]+$/, '');
  return text.split(/[/\\]/).at(-1) || 'file';
}

function firstLine(text: string) {
  return text.trim().split('\n')[0]!.trim();
}

function clip(text: string) {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

function asRecord(value: unknown): Args {
  return value && typeof value === 'object' ? (value as Args) : {};
}

function str(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

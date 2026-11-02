// The human-readable line an approval request shows for a tool call's
// arguments (P1): what will happen, short enough to read at a glance. The full
// arguments stay in the widget's props for the details view.

const MAX_VALUE = 120;
const MAX_FIELDS = 4;

export function summarizeArgs(toolName: string, args: unknown): string {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  switch (toolName) {
    case 'bash':
      if (typeof a.command === 'string') return `$ ${clip(a.command)}`;
      break;
    case 'http_request':
      if (typeof a.url === 'string') {
        const method = typeof a.method === 'string' ? a.method.toUpperCase() : 'GET';
        return `${method} ${clip(a.url)}`;
      }
      break;
    case 'send_email': {
      const to = Array.isArray(a.to) ? a.to.join(', ') : a.to;
      if (typeof to === 'string') {
        const subject = typeof a.subject === 'string' ? `: “${clip(a.subject)}”` : '';
        return `Email to ${clip(to)}${subject}`;
      }
      break;
    }
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      if (typeof a.path === 'string') return clip(a.path);
      break;
  }
  if (!args || typeof args !== 'object') return args === undefined ? '' : clip(text(args));
  const fields = Object.entries(a).filter(([, v]) => v !== undefined && v !== null);
  const shown = fields.slice(0, MAX_FIELDS).map(([k, v]) => `${k}: ${clip(text(v))}`);
  if (fields.length > MAX_FIELDS) shown.push(`+${fields.length - MAX_FIELDS} more`);
  return shown.join(', ');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function clip(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > MAX_VALUE ? `${line.slice(0, MAX_VALUE - 1)}…` : line;
}

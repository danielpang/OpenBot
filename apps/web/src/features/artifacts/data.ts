// The table view of a `data` Artifact (plan 18.4): CSV, or JSON that is an
// array of objects, an array of arrays, or one object. Anything else is shown
// as text.

export interface Table {
  columns: string[];
  rows: string[][];
}

const MAX_ROWS = 1_000;

export function parseTable(text: string, mime: string): Table | null {
  if (mime === 'application/json') return jsonTable(text);
  if (mime === 'text/csv') return csvTable(text, ',');
  if (mime === 'text/tab-separated-values') return csvTable(text, '\t');
  return null;
}

function jsonTable(text: string): Table | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ROWS);
    if (items.every(isRecord)) {
      const columns = [...new Set(items.flatMap((item) => Object.keys(item)))];
      return { columns, rows: items.map((item) => columns.map((c) => cell(item[c]))) };
    }
    if (items.every(Array.isArray)) {
      const width = Math.max(0, ...items.map((row) => row.length));
      const columns = Array.from({ length: width }, (_, i) => String(i + 1));
      return { columns, rows: items.map((row) => columns.map((_, i) => cell(row[i]))) };
    }
    return { columns: ['value'], rows: items.map((item) => [cell(item)]) };
  }
  if (isRecord(value)) {
    return {
      columns: ['key', 'value'],
      rows: Object.entries(value).map(([key, item]) => [key, cell(item)]),
    };
  }
  return null;
}

/** RFC 4180: quoted fields may hold the separator, newlines and doubled quotes. */
export function parseCsv(text: string, separator = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === separator) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvTable(text: string, separator: string): Table | null {
  const [header, ...rows] = parseCsv(text, separator);
  if (!header) return null;
  return {
    columns: header,
    rows: rows.slice(0, MAX_ROWS).map((row) => header.map((_, i) => row[i] ?? '')),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

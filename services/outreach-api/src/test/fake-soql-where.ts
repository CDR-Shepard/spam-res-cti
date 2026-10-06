/**
 * A tiny SOQL WHERE evaluator for fakes that should answer like Salesforce does: a query's rows are the table's rows its
 * WHERE clause keeps. It understands AND, OR, parentheses and `Field op literal` with op one of = != < <= > >=, and literals
 * that are 'quoted strings', true/false, numbers or dateTime values (2026-10-06T00:00:00Z). A condition on a field the row
 * does not carry is true (tests give rows only the fields that matter). Anything else throws, so a test never passes on a
 * query this fake did not understand.
 */
type Row = Record<string, unknown>;
type Literal = string | number | boolean | Date;

const TOKEN = /\s*(\(|\)|!=|<=|>=|=|<|>|'(?:\\.|[^'\\])*'|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_.]*)/y;

function tokenize(where: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < where.trimEnd().length) {
    const m = TOKEN.exec(where);
    if (!m) throw new Error(`fake SOQL: cannot read "${where.slice(TOKEN.lastIndex)}"`);
    out.push(m[1]!);
  }
  return out;
}

function literal(tok: string): Literal {
  if (tok.startsWith("'")) return tok.slice(1, -1).replace(/\\(.)/g, '$1');
  if (/^\d{4}-\d{2}-\d{2}T/.test(tok)) return new Date(tok);
  if (tok === 'true' || tok === 'false') return tok === 'true';
  if (/^-?\d/.test(tok)) return Number(tok);
  throw new Error(`fake SOQL: not a literal: ${tok}`);
}

function compare(value: unknown, op: string, lit: Literal): boolean {
  const left = lit instanceof Date ? Date.parse(String(value)) : value;
  const right = lit instanceof Date ? lit.getTime() : lit;
  if (lit instanceof Date && Number.isNaN(left)) return false;
  switch (op) {
    case '=':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return (left as number) < (right as number);
    case '<=':
      return (left as number) <= (right as number);
    case '>':
      return (left as number) > (right as number);
    case '>=':
      return (left as number) >= (right as number);
    default:
      throw new Error(`fake SOQL: unknown operator ${op}`);
  }
}

/** Recursive descent over the tokens: or := and (OR and)*; and := atom (AND atom)*; atom := ( or ) | Field op literal. */
function evaluate(tokens: string[], row: Row): boolean {
  let i = 0;
  const atom = (): boolean => {
    if (tokens[i] === '(') {
      i += 1;
      const v = or();
      if (tokens[i] !== ')') throw new Error('fake SOQL: missing )');
      i += 1;
      return v;
    }
    const [field, op, lit] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (!field || !op || lit === undefined) throw new Error('fake SOQL: incomplete condition');
    i += 3;
    return field in row ? compare(row[field], op, literal(lit)) : true;
  };
  const and = (): boolean => {
    let v = atom();
    while (tokens[i] === 'AND') {
      i += 1;
      v = atom() && v;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (tokens[i] === 'OR') {
      i += 1;
      v = and() || v;
    }
    return v;
  };
  const result = or();
  if (i !== tokens.length) throw new Error(`fake SOQL: unread tokens from ${tokens[i]}`);
  return result;
}

/** The rows of `table` the query's WHERE clause keeps (ORDER BY and LIMIT are ignored). */
export function rowsWhere(soql: string, table: readonly Row[]): Row[] {
  const m = / WHERE (.*?)(?: ORDER BY | LIMIT |$)/.exec(soql);
  if (!m) return [...table];
  const tokens = tokenize(m[1]!);
  return table.filter((row) => evaluate(tokens, row));
}

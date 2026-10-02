export function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

import initSqlJs from 'sql.js/dist/sql-asm.js';
import type { AnalysisResult, AnalysisSection, Evidence, Finding, InspectionFile } from './types.ts';
import { digestHex, formatNumber, shortFingerprint } from './utils.ts';
import { evidence, finding, ensureNotAborted, limitArray, readBytes } from './analysis-utils.ts';

let sqlPromise: Promise<any> | null = null;

async function getSql() {
  sqlPromise ??= initSqlJs();
  return sqlPromise;
}

function identity(file: InspectionFile, fingerprint: string) {
  return {
    name: file.name,
    type: 'SQLite database',
    format: 'SQLite',
    mimeType: file.mimeType || 'application/vnd.sqlite3',
    size: file.size,
    location: file.path,
    created: new Date(file.lastModified).toLocaleString(),
    modified: new Date(file.lastModified).toLocaleString(),
    fingerprint: shortFingerprint(fingerprint)
  };
}

function build(file: InspectionFile, fingerprint: string, sections: AnalysisSection[], evidenceList: Evidence[], unusual: Finding[], recommendations: Finding[], sourceSummary: string): AnalysisResult {
  return {
    objectKind: 'file',
    analyzerId: 'sqlite',
    analyzerName: 'SQLite analyzer',
    capabilities: ['schema', 'tables', 'indexes', 'foreign-keys', 'row-counts', 'null-distribution'],
    limitations: ['Read-only in-memory inspection', 'Large tables are sampled for expensive statistics'],
    targetName: file.name,
    identity: identity(file, fingerprint),
    sections,
    important: [],
    unusual,
    recommendations,
    evidence: evidenceList,
    progressLabel: 'SQLite analysis complete',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary
  };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

type SqlRow = any[];

export async function analyzeSqliteFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult | null> {
  ensureNotAborted(options.signal);
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (!['sqlite', 'sqlite3', 'db', 'db3', 's3db'].includes(ext) && !/sqlite/i.test(file.mimeType)) {
    return null;
  }
  const bytes = await readBytes(file, 50 * 1024 * 1024);
  if (bytes.length < 16 || new TextDecoder().decode(bytes.slice(0, 16)) !== 'SQLite format 3\0') {
    const fingerprint = await digestHex(bytes);
    const summary = 'Invalid SQLite header';
    return build(
      file,
      fingerprint,
      [{ id: 'sqlite-error', title: 'Facts', items: [evidence('sqlite-header', 'Header', summary)] }],
      [evidence('sqlite-header', 'Header', summary)],
      [finding('sqlite-invalid', 'Invalid SQLite database', summary, 'high', ['sqlite-header'])],
      [],
      summary
    );
  }
  const SQL = await getSql();
  const db = new SQL.Database(bytes);
  try {
    const fingerprint = await digestHex(bytes);
    const tablesRes = db.exec(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`);
    const indexesRes = db.exec(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name;`);
    const tableRows: SqlRow[] = tablesRes[0]?.values ?? [];
    const indexRows: SqlRow[] = indexesRes[0]?.values ?? [];
    const tables = tableRows.map((row) => String(row[0]));
    const evidenceList: Evidence[] = [
      evidence('sqlite-tables', 'Tables', formatNumber(tables.length)),
      evidence('sqlite-indexes', 'Indexes', formatNumber(indexRows.length))
    ];
    const tableSections: AnalysisSection[] = [];
    const unusual: Finding[] = [];
    const recommendations: Finding[] = [];
    for (const table of tables.slice(0, 10)) {
      ensureNotAborted(options.signal);
      const colsRes = db.exec(`PRAGMA table_info(${quoteIdent(table)});`);
      const cols: SqlRow[] = colsRes[0]?.values ?? [];
      const columnNames = cols.map((col) => String(col[1]));
      const primaryKeyColumns = new Set(cols.filter((col) => Number(col[5]) > 0).map((col) => String(col[1])));
      const rowCountRes = db.exec(`SELECT COUNT(*) FROM ${quoteIdent(table)};`);
      const rowCount = Number(rowCountRes[0]?.values?.[0]?.[0] ?? 0);
      const nullEvidence: Evidence[] = [];
      for (const col of cols.slice(0, 6)) {
        const name = String(col[1]);
        const nulls = db.exec(`SELECT COUNT(*) FROM ${quoteIdent(table)} WHERE ${quoteIdent(name)} IS NULL;`);
        nullEvidence.push(evidence(`sqlite-null-${table}-${name}`, name, `${Number(nulls[0]?.values?.[0]?.[0] ?? 0)} nulls`));
      }
      tableSections.push({
        id: `sqlite-table-${table}`,
        title: table,
        items: [
          evidence(`sqlite-rows-${table}`, 'Rows', formatNumber(rowCount)),
          evidence(`sqlite-cols-${table}`, 'Columns', formatNumber(columnNames.length)),
          ...limitArray(nullEvidence, 6)
        ]
      });
      if (rowCount === 0) {
        unusual.push(finding(`sqlite-empty-${table}`, `Empty table ${table}`, 'The table contains no rows.', 'low', [`sqlite-rows-${table}`]));
      }
      const keyCols = columnNames.filter((name) => !primaryKeyColumns.has(name)).slice(0, 4);
      if (keyCols.length >= 2) {
        const concat = keyCols.map((name) => `coalesce(cast(${quoteIdent(name)} as text),'')`).join(` || '|' || `);
        const dupes = db.exec(`SELECT COUNT(*) FROM (SELECT ${concat} AS k, COUNT(*) AS c FROM ${quoteIdent(table)} GROUP BY k HAVING c > 1);`);
        const duplicateGroups = Number(dupes[0]?.values?.[0]?.[0] ?? 0);
        if (duplicateGroups > 0) {
          evidenceList.push(evidence(`sqlite-dup-cols-${table}`, 'Duplicate columns checked', keyCols.join(', ')));
          unusual.push(finding(`sqlite-dup-${table}`, `Duplicate rows in ${table}`, `Rows repeat across the sampled columns: ${keyCols.join(', ')}.`, 'medium', [`sqlite-rows-${table}`, `sqlite-dup-cols-${table}`]));
        }
      }
      if (columnNames.length > 0 && rowCount > 0) {
        recommendations.push(finding(`sqlite-review-${table}`, `Review ${table}`, 'Table structure and row counts are available for deeper inspection.', 'low', [`sqlite-rows-${table}`]));
      }
    }
    const foreignKeyRes = tables.flatMap((table) => db.exec(`PRAGMA foreign_key_list(${quoteIdent(table)});`)[0]?.values ?? []);
    const namedIndexes = indexRows.map((row) => `${row[0]} on ${row[1]}`);
    const sections: AnalysisSection[] = [
      { id: 'sqlite-facts', title: 'Facts', items: evidenceList.concat([
        evidence('sqlite-foreign-keys', 'Foreign keys', formatNumber(foreignKeyRes.length))
      ]) },
      { id: 'sqlite-structure', title: 'Structure', items: limitArray(namedIndexes, 10).map((value, index) => evidence(`sqlite-index-${index}`, `Index ${index + 1}`, value)) },
      ...tableSections
    ];
    return build(file, fingerprint, sections, evidenceList.concat([evidence('sqlite-foreign-keys', 'Foreign keys', formatNumber(foreignKeyRes.length))]), unusual, recommendations, `${formatNumber(tables.length)} tables`);
  } catch (error) {
    const fingerprint = await digestHex(bytes);
    const summary = error instanceof Error ? error.message : 'SQLite parse failure';
    return build(
      file,
      fingerprint,
      [{ id: 'sqlite-error', title: 'Facts', items: [evidence('sqlite-error', 'Parse error', summary)] }],
      [evidence('sqlite-error', 'Parse error', summary)],
      [finding('sqlite-parse-error', 'SQLite parse failed', summary, 'high', ['sqlite-error'])],
      [],
      summary
    );
  } finally {
    db.close();
  }
}

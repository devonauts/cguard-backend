require('dotenv').config();

import models from '../models';

function tableNameOf(model: any): string {
  const raw = model.getTableName();
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.tableName === 'string') return raw.tableName;
  return String(raw);
}

function shouldSkipModel(name: string, model: any): boolean {
  if (!model || typeof model !== 'function') return true;
  if (!model.rawAttributes || typeof model.getTableName !== 'function') return true;
  if (name === 'postSite') return true; // alias of businessInfo
  return false;
}

function isVirtualAttribute(attr: any): boolean {
  return !!(attr && attr.type && String(attr.type.key).toUpperCase() === 'VIRTUAL');
}

export async function verifySchemaConsistency(): Promise<void> {
  const db = models() as any;
  const qi = db.sequelize.getQueryInterface();

  const missingTables: string[] = [];
  const missingColumns: Array<{ table: string; columns: string[] }> = [];

  for (const [name, model] of Object.entries(db)) {
    if (shouldSkipModel(name, model)) continue;

    const table = tableNameOf(model);

    let desc: Record<string, any>;
    try {
      desc = await qi.describeTable(table);
    } catch (err) {
      missingTables.push(table);
      continue;
    }

    const existingLower = new Set(Object.keys(desc).map((c) => c.toLowerCase()));
    const expectedColumns = Object.entries((model as any).rawAttributes)
      .filter(([, attr]: any) => !isVirtualAttribute(attr))
      .map(([attrName, attr]: any) => attr.field || attr.fieldName || attrName);

    const missingForTable = expectedColumns.filter((col) => !existingLower.has(String(col).toLowerCase()));

    if (missingForTable.length > 0) {
      missingColumns.push({ table, columns: missingForTable.sort() });
    }
  }

  try {
    await db.sequelize.close();
  } catch (e) {
    // ignore close errors in script mode
  }

  if (missingTables.length || missingColumns.length) {
    console.error('SCHEMA VERIFICATION FAILED');

    if (missingTables.length) {
      console.error('\nMissing tables:');
      missingTables.sort().forEach((t) => console.error(`- ${t}`));
    }

    if (missingColumns.length) {
      console.error('\nMissing columns:');
      missingColumns.forEach((item) => {
        console.error(`- ${item.table}: ${item.columns.join(', ')}`);
      });
    }

    throw new Error('Database schema is out of sync with Sequelize models');
  }

  console.log('Schema verification OK: database matches Sequelize models');
}

if (require.main === module) {
  verifySchemaConsistency()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

require('dotenv').config();

import models from '../models';
import { DataTypes } from 'sequelize';

/**
 * The AI dispatcher now VOICES the pase de novedades (OpenAI TTS): a spoken
 * prompt per station and a spoken closing summary. Persist their playable URLs.
 *  - radioCheckEntries.promptAudioUrl   — the spoken "call" for that station
 *  - radioCheckSessions.summaryAudioUrl — the spoken closing report
 * Idempotent: skips a column that already exists.
 */
async function migrate() {
  const { sequelize } = models();
  const qi = sequelize.getQueryInterface();

  const addCol = async (table: string, col: string) => {
    try {
      const desc: any = await qi.describeTable(table);
      if (desc[col]) { console.log(`${table}.${col} already exists. Skipping.`); return; }
      await qi.addColumn(table, col, { type: DataTypes.TEXT, allowNull: true });
      console.log(`✅ added ${table}.${col}`);
    } catch (e: any) {
      // Table may not exist on a fresh DB before its create migration ran.
      console.log(`Skipping ${table}.${col}: ${e?.message || e}`);
    }
  };

  try {
    await addCol('radioCheckEntries', 'promptAudioUrl');
    await addCol('radioCheckSessions', 'summaryAudioUrl');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

export { migrate };

migrate();

import models from '../models';
import { Op } from 'sequelize';

async function main() {
  const db = models();
  const Request = db.request;

  console.log('Searching requests with comments...');
  const rows = await Request.findAll({
    where: {
      comments: {
        [Op.not]: null,
      },
    },
    include: [
      { model: db.user, as: 'updatedBy' },
      { model: db.user, as: 'createdBy' },
    ],
    limit: 10000,
  });

  let updated = 0;

  for (const r of rows) {
    try {
      const comments = r.comments || [];
      let changed = false;
      for (const c of comments) {
        if (!c || !c.author) continue;
        const isSystem = (c.author.id === 'system') || (c.author.name === 'Usuario');
        if (!isSystem) continue;

        // Prefer updatedBy, then createdBy
        const by = (r as any).updatedBy || (r as any).createdBy;
        if (by && (by.fullName || by.name)) {
          c.author.name = by.fullName || by.name;
          if (by.id) c.author.id = by.id;
          changed = true;
        }
      }

      if (changed) {
        await r.update({ comments }, { fields: ['comments'] });
        updated++;
        console.log('Updated request', r.id);
      }
    } catch (e: any) {
      console.error('Failed to update request', r.id, e && e.message ? e.message : String(e));
    }
  }

  console.log(`Done. Requests updated: ${updated}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });

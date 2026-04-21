import PermissionChecker from '../../services/user/permissionChecker';
import Permissions from '../../security/permissions';
import Error400 from '../../errors/Error400';

/** @openapi {
  "summary": "Confirm inventories for a patrol and attempt auto-complete",
  "description": "Supervisor confirms that inventory snapshots for the patrol are ready. This endpoint evaluates applicable inventories and, if all are verified (`isComplete === true`), marks the patrol completed.",
  "parameters": [
    { "name": "tenantId", "in": "path", "required": true, "schema": { "type": "string" } },
    { "name": "patrolId", "in": "path", "required": true, "schema": { "type": "string" } }
  ],
  "responses": {
    "200": { "description": "Patrol auto-complete evaluated; returns status message." },
    "400": { "description": "Not all inventories verified or validation error." }
  }
} */

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.patrolEdit,
    );

    const tenant = req.currentTenant;
    const patrolId = req.params.patrolId;
    if (!patrolId) {
      throw new Error400(req.language, 'entities.patrol.errors.patrolRequired');
    }

    const patrol = await req.database.patrol.findOne({ where: { id: patrolId, tenantId: tenant.id } });
    if (!patrol) {
      const err: any = new Error('Patrol not found'); err.code = 404; throw err;
    }

    if (patrol.completed === true) {
      return res.status(200).json({ message: 'Patrol already completed' });
    }

    // Determine station/postSite scope
    const stationId = (patrol as any).stationId || null;
    let postSiteId = (patrol as any).postSiteId || (patrol as any).postsiteId || null;

    if (!stationId && postSiteId) {
      // ok: we'll look for inventories that belong to the postSite
    }

    const Op = req.database.Sequelize ? req.database.Sequelize.Op : require('sequelize').Op;

    // gather inventories scoped to station or postSite
    const whereOr: any[] = [];
    if (stationId) whereOr.push({ belongsToId: stationId });
    if (postSiteId) whereOr.push({ belongsToId: postSiteId });

    if (whereOr.length === 0) {
      return res.status(400).json({ message: 'Patrol has no station or postSite to evaluate inventories' });
    }

    const applicableInventories = await req.database.inventory.findAll({
      where: {
        tenantId: tenant.id,
        [Op.or]: whereOr,
      },
      attributes: ['id'],
    });

    const invIds = (applicableInventories || []).map((i) => i.id);
    if (!invIds || invIds.length === 0) {
      return res.status(400).json({ message: 'No applicable inventories found for this patrol' });
    }

    const checkedCount = await req.database.inventoryHistory.count({
      where: {
        tenantId: tenant.id,
        patrolId: patrolId,
        inventoryOriginId: { [Op.in]: invIds },
        isComplete: true,
      },
    });

    if (checkedCount >= invIds.length) {
      await req.database.patrol.update({ completed: true, completionTime: new Date(), status: 'Completed' }, { where: { id: patrolId, tenantId: tenant.id } });
      return res.status(200).json({ message: 'Patrol marked as completed' });
    }

    return res.status(400).json({ message: 'Not all applicable inventories are verified', totalInventories: invIds.length, verified: checkedCount });
  } catch (error) {
    next(error);
  }
};

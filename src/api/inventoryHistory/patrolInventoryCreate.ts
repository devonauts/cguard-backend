import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import InventoryHistoryService from '../../services/inventoryHistoryService';
import Error400 from '../../errors/Error400';
import Sequelize from 'sequelize';

/** Handler: create inventory history snapshots for a patrol (single or batch)
 * POST /tenant/:tenantId/patrols/:patrolId/inventory-history
 */
export default async (req, res, next) => {
	try {
		new PermissionChecker(req).validateHas(Permissions.values.inventoryHistoryCreate);

		const tenant = req.currentTenant;
		const patrolId = req.params.patrolId;
		if (!patrolId) {
			throw new Error400(req.language, 'entities.patrol.errors.patrolRequired');
		}

		const patrol = await req.database.patrol.findOne({ where: { id: patrolId, tenantId: tenant.id } });
		if (!patrol) {
			const err: any = new Error('Patrol not found'); err.code = 404; throw err;
		}

		const data = (req.body && req.body.data) ? req.body.data : req.body || {};
		const inventoriesArray = Array.isArray(data.inventories) ? data.inventories : null;

		const validateInventoryForPatrol = async (inventoryIdCandidate) => {
			if (!inventoryIdCandidate) return null;
			const inventory = await req.database.inventory.findOne({ where: { id: inventoryIdCandidate, tenantId: tenant.id } });
			if (!inventory) {
				const err: any = new Error('Inventory not found'); err.code = 404; throw err;
			}

			const invStationId = (inventory as any).belongsToId || (inventory as any).belongsToStation || null;
			const patrolStationId = (patrol as any).stationId || null;

			if (invStationId && patrolStationId && String(invStationId) !== String(patrolStationId)) {
				const err = new Error400(req.language, 'entities.inventory.errors.stationMismatch');
				(err as any).errors = { inventoryId: 'Inventory does not belong to the same station as the patrol' };
				throw err;
			}

			const invBelongsToId = (inventory as any).belongsToId || null;
			const patrolPostSiteId = (patrol as any).postSiteId || (patrol as any).postsiteId || null;
			if (!invStationId && invBelongsToId && patrolPostSiteId && String(invBelongsToId) !== String(patrolPostSiteId)) {
				const err = new Error400(req.language, 'entities.inventory.errors.postSiteMismatch');
				(err as any).errors = { inventoryId: 'Inventory does not belong to the same postSite as the patrol' };
				throw err;
			}

			return inventory;
		};

		const tryAutoCompletePatrol = async () => {
			try {
				const Op = Sequelize.Op;
				const stationId = (patrol as any).stationId || null;
				const station = stationId ? await req.database.station.findOne({ where: { id: stationId, tenantId: tenant.id } }) : null;
				const postSiteId = station ? station.postSiteId || station.postsiteId || null : (patrol as any).postSiteId || (patrol as any).postsiteId || null;

				const whereOr: any[] = [];
				if (stationId) whereOr.push({ belongsToId: stationId });
				if (postSiteId) whereOr.push({ belongsToId: postSiteId });
				if (whereOr.length === 0) return;

				const applicableInventories = await req.database.inventory.findAll({
					where: {
						tenantId: tenant.id,
						[Op.or]: whereOr,
					},
					attributes: ['id'],
				});

				const invIds = (applicableInventories || []).map((i) => i.id);
				if (!invIds || invIds.length === 0) return;

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
				}
			} catch (e) {
				try { console.error('Auto-complete patrol error', e); } catch (__) {}
			}
		};

		// Batch flow
		if (inventoriesArray) {
				const results: any[] = [];
			for (const item of inventoriesArray) {
				const singleData: any = { ...(data || {}) };
				singleData.inventoryOrigin = item.inventoryId || item.inventoryOrigin || (item.inventory && item.inventory.id) || singleData.inventoryOrigin;
				singleData.snapshot = item.snapshot || singleData.snapshot;
				singleData.isComplete = typeof item.isComplete === 'boolean' ? item.isComplete : singleData.isComplete;
				singleData.observation = item.observation || singleData.observation;
				singleData.photos = item.photos || singleData.photos;
				singleData.inventoryCheckedDate = item.inventoryCheckedDate || singleData.inventoryCheckedDate;

				singleData.patrol = patrolId;
				if (!singleData.stationId && (patrol as any).stationId) singleData.stationId = (patrol as any).stationId;

				const invIdForValidation = singleData.inventoryOrigin;
				if (invIdForValidation) await validateInventoryForPatrol(invIdForValidation);

				const created = await new InventoryHistoryService(req).create(singleData);
				results.push(created);
			}

			await tryAutoCompletePatrol();
			await ApiResponseHandler.success(req, res, results);
			return;
		}

		// Single item flow
		const inventoryId = data.inventoryOrigin || data.inventoryId || (data.inventory && data.inventory.id) || null;
		if (inventoryId) {
			await validateInventoryForPatrol(inventoryId);
		}

		data.patrol = patrolId;
		if (!data.stationId && (patrol as any).stationId) data.stationId = (patrol as any).stationId;

		const payload = await new InventoryHistoryService(req).create(data);
		await tryAutoCompletePatrol();

		await ApiResponseHandler.success(req, res, payload);
	} catch (error) {
		await ApiResponseHandler.error(req, res, error);
	}
};



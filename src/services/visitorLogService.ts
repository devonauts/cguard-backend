import Error400 from '../errors/Error400';
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import { IServiceOptions } from './IServiceOptions';
import VisitorLogRepository from '../database/repositories/visitorLogRepository';
import StationRepository from '../database/repositories/stationRepository';
import { dispatch } from '../lib/notificationDispatcher';
import { sendVisitorAlert } from './communication/communicationService';
import { resolveSupervisorUserIds } from './communication/operationalRecipients';

export default class VisitorLogService {
  options: IServiceOptions;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      // validate stationId if provided
      if (Object.prototype.hasOwnProperty.call(data, 'stationId') || Object.prototype.hasOwnProperty.call(data, 'station')) {
        data.stationId = await StationRepository.filterIdInTenant(data.station || data.stationId, { ...this.options, transaction });
      }
      const record = await VisitorLogRepository.create(data, { ...this.options, transaction });

      await SequelizeRepository.commitTransaction(transaction);

      // Notify supervisors of visitor arrival (in-app + email + legacy SMS path).
      dispatch('visitor.arrival', {
        visitorName: record.visitorName || record.name || null,
        stationName: record.station?.name || record.stationName || null,
        purpose: record.purpose || record.reason || null,
      }, {
        database: this.options.database,
        tenantId: this.options.currentTenant?.id,
        sourceEntityType: 'visitorLog',
        sourceEntityId: record.id,
      }).catch(() => {});

      // Push-first fan-out to supervisors/admins via the unified communications
      // layer (WhatsApp optional per setting; SMS only if the tenant enables the
      // critical fallback). In ADDITION to the dispatch above. Best-effort.
      (async () => {
        try {
          const db = this.options.database;
          const tenantId = this.options.currentTenant?.id;
          if (!tenantId) return;
          const visitorName = record.visitorName || record.name || 'Un visitante';
          const stationName = record.station?.name || record.stationName || null;
          const title = 'Visitante en sitio';
          const body =
            `${visitorName} registró su ingreso` +
            (stationName ? ` en ${stationName}` : '') +
            '.';
          const userIds = await resolveSupervisorUserIds(db, tenantId, {
            assignedPostSiteId: record.postSiteId || null,
          });
          await Promise.all(
            userIds.map((userId) =>
              sendVisitorAlert(db, {
                tenantId,
                userId,
                title,
                body,
                visitorId: String(record.id),
                data: {
                  type: 'visitor.arrival',
                  visitorLogId: String(record.id || ''),
                  stationId: String(record.stationId || ''),
                  postSiteId: String(record.postSiteId || ''),
                },
              }).catch(() => undefined),
            ),
          );
        } catch (e: any) {
          console.warn('[visitor] communicationService alert failed:', e?.message || e);
        }
      })();

      // Notify the owning CLIENT (Mi Seguridad app) that a visitor was registered at
      // their site — so the client sees arrivals in real time. Resolves the client
      // from the visitor's clientId / postSiteId / stationId. Best-effort.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { notifyClient } = require('./clientNotifyService');
        const db = this.options.database;
        const tenantId = this.options.currentTenant?.id;
        if (tenantId) {
          const visitorName =
            [record.firstName, record.lastName].filter(Boolean).join(' ').trim() || 'Un visitante';
          const stationName = record.stationName || record.station?.stationName || 'el sitio';
          const visited = record.personVisited ? ` · visita a ${record.personVisited}` : '';
          // The visitor's face photo is stored as a `facePhoto` file relation; findById
          // returns it with a fetchable downloadUrl. Shown as the notification image.
          const faceFiles = Array.isArray(record.facePhoto) ? record.facePhoto : [];
          const visitorPhotoUrl =
            (faceFiles[0] && (faceFiles[0].downloadUrl || faceFiles[0].publicUrl)) || '';
          await notifyClient(
            db,
            tenantId,
            { clientAccountId: record.clientId, postSiteId: record.postSiteId, stationId: record.stationId },
            {
              eventType: 'visitor.registered',
              title: 'Nuevo visitante',
              body: `${visitorName} se registró en ${stationName}${visited}.`,
              image: visitorPhotoUrl || undefined,
              data: {
                visitorLogId: String(record.id || ''),
                visitorName,
                stationName: String(stationName),
                personVisited: String(record.personVisited || ''),
                company: String(record.company || ''),
                vehiclePlate: String(record.vehiclePlate || ''),
                photoUrl: String(visitorPhotoUrl || ''),
                stationId: String(record.stationId || ''),
                postSiteId: String(record.postSiteId || ''),
              },
              sourceEntityType: 'visitorLog',
              sourceEntityId: String(record.id),
            },
          );
        }
      } catch (e: any) {
        console.warn('[visitor] client notify failed:', e?.message || e);
      }

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);

      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'visitorLog');

      throw error;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      // validate stationId if provided
      if (Object.prototype.hasOwnProperty.call(data, 'stationId') || Object.prototype.hasOwnProperty.call(data, 'station')) {
        data.stationId = await StationRepository.filterIdInTenant(data.station || data.stationId, { ...this.options, transaction });
      }
      const record = await VisitorLogRepository.update(id, data, { ...this.options, transaction });

      await SequelizeRepository.commitTransaction(transaction);

      // Notify the owning CLIENT (Mi Seguridad app) that a visitor CHECKED OUT of
      // their site — but ONLY on the actual exit transition (this update is setting
      // a truthy exitTime), not on every edit. Mirrors the entry push in create().
      // Best-effort / fire-and-forget — never blocks or breaks the update.
      if (Object.prototype.hasOwnProperty.call(data, 'exitTime') && data.exitTime) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { notifyClient } = require('./clientNotifyService');
          const db = this.options.database;
          const tenantId = this.options.currentTenant?.id;
          if (tenantId) {
            const visitorName =
              [record.firstName, record.lastName].filter(Boolean).join(' ').trim() || 'Un visitante';
            const stationName = record.stationName || record.station?.stationName || 'el sitio';
            await notifyClient(
              db,
              tenantId,
              { clientAccountId: record.clientId, postSiteId: record.postSiteId, stationId: record.stationId },
              {
                eventType: 'visitor.exited',
                title: 'Visita finalizada',
                body: `${visitorName} finalizó su visita en ${stationName}.`,
                data: {
                  visitorLogId: String(record.id || ''),
                  visitorName,
                  stationName: String(stationName),
                  stationId: String(record.stationId || ''),
                  postSiteId: String(record.postSiteId || ''),
                },
                sourceEntityType: 'visitorLog',
                sourceEntityId: String(record.id),
              },
            );
          }
        } catch (e: any) {
          console.warn('[visitor] client exit notify failed:', e?.message || e);
        }
      }

      return record;
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);

      SequelizeRepository.handleUniqueFieldError(error, this.options.language, 'visitorLog');

      throw error;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);

    try {
      for (const id of ids) {
        await VisitorLogRepository.destroy(id, { ...this.options, transaction });
      }

      await SequelizeRepository.commitTransaction(transaction);
    } catch (error) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw error;
    }
  }

  async findById(id) {
    return VisitorLogRepository.findById(id, this.options);
  }

  async findAllAutocomplete(search, limit) {
    return VisitorLogRepository.findAllAutocomplete(search, limit, this.options);
  }

  async findAndCountAll(args) {
    return VisitorLogRepository.findAndCountAll(args, this.options);
  }

  async import(data, importHash) {
    if (!importHash) {
      throw new Error400(this.options.language, 'importer.errors.importHashRequired');
    }

    if (await this._isImportHashExistent(importHash)) {
      throw new Error400(this.options.language, 'importer.errors.importHashExistent');
    }

    const dataToCreate = { ...data, importHash };

    return this.create(dataToCreate);
  }

  async _isImportHashExistent(importHash) {
    const count = await VisitorLogRepository.count({ importHash }, this.options);

    return count > 0;
  }
}

import Error403 from '../../errors/Error403';
import Error404 from '../../errors/Error404';

/**
 * Sub-resource ownership guard. The routes /client-account/:id/<thing>/:subId
 * IMPLY that <thing> belongs to the client in the path — but several write/read
 * handlers only loaded the sub-resource by its own id and checked tenantId,
 * never that it belongs to :id. That let a caller with access to client A edit
 * or read client B's note/contact/incident by putting B's sub-id under A's path
 * (a cross-client IDOR within one tenant).
 *
 * This loads the row, confirms it is in the caller's tenant, and confirms its
 * client foreign key matches the clientAccountId from the path. Use it AFTER
 * assertClientAccess(req, req.params.id) (which authorizes the path client)
 * and BEFORE any read/mutation of the sub-resource.
 *
 * `clientKey` is the column on the sub-resource that stores its owning client
 * (e.g. 'clientId' on incident, 'clientAccountId' on clientContact, 'notableId'
 * on note). Returns the loaded record so callers don't re-query.
 */
export default async function assertClientOwnsSubResource(
  req: any,
  opts: {
    model: any;                 // e.g. req.database.incident
    subId: string;              // req.params.incidentId
    clientAccountId: string;    // req.params.id
    clientKey: string;          // FK column that points at the client
    attributes?: string[];      // extra columns to load
  },
): Promise<any> {
  const tenantId = req.currentTenant && req.currentTenant.id;
  const { model, subId, clientAccountId, clientKey } = opts;

  if (!subId || !clientAccountId) {
    throw new Error404(req.language);
  }

  const wanted = Array.from(new Set(['id', 'tenantId', clientKey, ...(opts.attributes || [])]));
  const row: any = await model.findByPk(subId, { attributes: wanted }).catch(() => null);

  // Unknown id, wrong tenant → 404 (don't disclose existence across tenants).
  if (!row || String(row.tenantId) !== String(tenantId)) {
    throw new Error404(req.language);
  }
  // Right tenant but a DIFFERENT client's resource → 403 (it exists, not yours).
  if (String(row[clientKey]) !== String(clientAccountId)) {
    throw new Error403(req.language);
  }
  return row;
}

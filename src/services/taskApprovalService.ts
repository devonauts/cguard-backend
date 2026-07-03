/**
 * CRM approval for client-created tasks. Mirrors attendanceAdminService's
 * decideClockInRequest: update status + decision metadata, then fan out
 * notifications (worker push + client push + email) via taskNotify.
 */
import SequelizeRepository from '../database/repositories/sequelizeRepository';
import FileRepository from '../database/repositories/fileRepository';
import Error404 from '../errors/Error404';
import { notifyTaskApproved, notifyTaskRejected } from './taskNotify';

export default class TaskApprovalService {
  options: any;
  db: any;
  tenantId: string;

  constructor(options: any) {
    this.options = options;
    this.db = options.database;
    this.tenantId = options.currentTenant?.id;
  }

  /** List tasks by status (default: pending_approval) for the CRM approvals queue. */
  async listByStatus(query: any = {}) {
    const db = this.db;
    const tenantId = this.tenantId;
    const status = query.status || 'pending_approval';
    const where: any = { tenantId, deletedAt: null };
    if (status && status !== 'all') where.status = String(status).split(',');
    const rows = await db.task.findAll({
      where,
      include: [
        { model: db.station, as: 'taskBelongsToStation', attributes: ['id', 'stationName'] },
        // The guard's completion photo + the client's optional reference image.
        { model: db.file, as: 'taskCompletedImage', required: false },
        { model: db.file, as: 'imageOptional', required: false },
      ],
      order: [['createdAt', 'DESC']],
      limit: Math.min(Number(query.limit) || 100, 200),
    });
    const plain = rows.map((r: any) => r.get({ plain: true }));
    // Sign the file relations so the CRM detail can render the images.
    for (const p of plain) {
      p.taskCompletedImage = await FileRepository.fillDownloadUrl(p.taskCompletedImage || []);
      p.imageOptional = await FileRepository.fillDownloadUrl(p.imageOptional || []);
    }
    return { rows: plain, count: plain.length };
  }

  /** Approve or reject a task; notify client (+ guards on approval) + email. */
  async decide(id: string, data: { status: 'approved' | 'rejected'; notes?: string }) {
    const db = this.db;
    const tenantId = this.tenantId;
    const currentUser = SequelizeRepository.getCurrentUser(this.options);
    const decision = data?.status === 'approved' ? 'approved' : 'rejected';

    const task = await db.task.findOne({ where: { id, tenantId, deletedAt: null } });
    if (!task) throw new Error404();

    await task.update({
      status: decision,
      approvedById: currentUser.id,
      approvedAt: new Date(),
      approvalNotes: data?.notes ?? task.approvalNotes,
      updatedById: currentUser.id,
    });

    const plain = task.get({ plain: true });
    if (decision === 'approved') {
      notifyTaskApproved(db, tenantId, plain).catch(() => undefined);
    } else {
      notifyTaskRejected(db, tenantId, plain, data?.notes).catch(() => undefined);
    }
    return plain;
  }
}

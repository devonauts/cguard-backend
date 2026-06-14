import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import Error401 from '../../errors/Error401';
import Error403 from '../../errors/Error403';
import TrainingEnrollmentService from '../../services/trainingEnrollmentService';

/**
 * Guard-facing "Entrenamiento" API (worker app). Mounted under
 * /tenant/:tenantId/guard/me/training, alongside the other /guard/me endpoints.
 *
 * Tenant scoping comes from :tenantId; the acting guard is resolved from
 * req.currentUser -> securityGuard, so a guard can only ever touch their own
 * enrollments and certificates.
 */
async function ctx(req: any) {
  const currentUser = req.currentUser;
  if (!currentUser) throw new Error401();
  const db = req.database;
  const tenantId = req.params.tenantId || (req.currentTenant && req.currentTenant.id);
  const guard = await TrainingEnrollmentService.resolveGuard(db, tenantId, currentUser.id);
  if (!guard) throw new Error403(req.language);
  return { db, tenantId, userId: currentUser.id, guardId: guard.id };
}

export default (app: any) => {
  // List my assigned courses.
  app.get('/tenant/:tenantId/guard/me/training/my-courses', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingEnrollmentRead);
      const { db, tenantId, guardId } = await ctx(req);
      const payload = await TrainingEnrollmentService.myEnrollments(db, tenantId, guardId, req.query);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // Enrollment detail + lessons to view.
  app.get('/tenant/:tenantId/guard/me/training/enrollments/:enrollmentId/detail', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingEnrollmentRead);
      const { db, tenantId, guardId } = await ctx(req);
      const payload = await TrainingEnrollmentService.enrollmentDetail(db, tenantId, guardId, req.params.enrollmentId);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // Mark a lesson complete.
  app.post('/tenant/:tenantId/guard/me/training/lessons/:lessonId/complete', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingLessonComplete);
      const { db, tenantId, guardId } = await ctx(req);
      const data = req.body.data || req.body || {};
      const payload = await TrainingEnrollmentService.completeLesson(
        db, tenantId, guardId, req.params.lessonId, data.enrollmentId, data.timeSpentSeconds,
      );
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // Submit the course quiz (graded server-side; triggers certificate on pass).
  app.post('/tenant/:tenantId/guard/me/training/enrollments/:enrollmentId/submit-quiz', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingQuizAttempt);
      const { db, tenantId, userId, guardId } = await ctx(req);
      const data = req.body.data || req.body || {};
      const payload = await TrainingEnrollmentService.submitQuiz(db, {
        tenantId,
        securityGuardId: guardId,
        subjectUserId: userId,
        enrollmentId: req.params.enrollmentId,
        bankId: data.bankId,
        answers: data.answers,
        startedAt: data.startedAt ? new Date(data.startedAt) : null,
      });
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // List my earned certificates (Mis logros).
  app.get('/tenant/:tenantId/guard/me/training/certificates', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingCertificateRead);
      const { db, tenantId, guardId } = await ctx(req);
      const payload = await TrainingEnrollmentService.certificatesList(db, tenantId, guardId, req.query);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // View/download a single certificate (includes htmlContent for render/print).
  app.get('/tenant/:tenantId/guard/me/training/certificates/:certificateId', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingCertificateRead);
      const { db, tenantId, guardId } = await ctx(req);
      const payload = await TrainingEnrollmentService.certificateDetail(db, tenantId, guardId, req.params.certificateId);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};

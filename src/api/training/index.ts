import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import TrainingCourseService from '../../services/trainingCourseService';

/**
 * Tenant-side "Entrenamiento" API: course CRUD, lessons, course quiz,
 * guard enrollment + admin progress. All routes are tenant-scoped via the
 * :tenantId param (tenantMiddleware) and permission-gated.
 */
const svc = (req: any) => new TrainingCourseService(req);

export default (app: any) => {
  // ---- Courses ----------------------------------------------------------
  app.post('/tenant/:tenantId/training/courses', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingCourseCreate);
      const payload = await svc(req).create(req.body.data || req.body);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.get('/tenant/:tenantId/training/courses', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingCourseRead);
      const payload = await svc(req).findAndCountAll(req.query);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.get('/tenant/:tenantId/training/courses/:id', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingCourseRead);
      const payload = await svc(req).findById(req.params.id);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.put('/tenant/:tenantId/training/courses/:id', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingCourseEdit);
      const payload = await svc(req).update(req.params.id, req.body.data || req.body);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.delete('/tenant/:tenantId/training/courses/:id', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingCourseDestroy);
      const payload = await svc(req).destroy(req.params.id);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // ---- Lessons ----------------------------------------------------------
  app.post('/tenant/:tenantId/training/courses/:courseId/lessons', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingLessonCreate);
      const payload = await svc(req).createLesson(req.params.courseId, req.body.data || req.body);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.get('/tenant/:tenantId/training/courses/:courseId/lessons', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingLessonRead);
      const payload = await svc(req).listLessons(req.params.courseId);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.put('/tenant/:tenantId/training/lessons/:lessonId', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingLessonEdit);
      const payload = await svc(req).updateLesson(req.params.lessonId, req.body.data || req.body);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.delete('/tenant/:tenantId/training/lessons/:lessonId', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingLessonDestroy);
      const payload = await svc(req).destroyLesson(req.params.lessonId);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // ---- Course quiz ------------------------------------------------------
  app.post('/tenant/:tenantId/training/courses/:courseId/quiz', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingCourseEdit);
      const payload = await svc(req).upsertQuiz(req.params.courseId, req.body.data || req.body);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  // ---- Enrollment (admin assignment + progress views) -------------------
  app.post('/tenant/:tenantId/training/courses/:courseId/enroll', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingEnrollmentCreate);
      const payload = await svc(req).enroll(req.params.courseId, req.body.data || req.body);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.get('/tenant/:tenantId/training/courses/:courseId/enrollments', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingEnrollmentRead);
      const payload = await svc(req).listEnrollments(req.params.courseId, req.query);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });

  app.get('/tenant/:tenantId/training/enrollments/:enrollmentId', async (req: any, res: any) => {
    try {
      new PermissionChecker(req).validateHas(Permissions.values.trainingEnrollmentRead);
      const payload = await svc(req).enrollmentDetail(req.params.enrollmentId);
      await ApiResponseHandler.success(req, res, payload);
    } catch (error) {
      await ApiResponseHandler.error(req, res, error);
    }
  });
};

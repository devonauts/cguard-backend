import Error400 from '../errors/Error400';
import Error404 from '../errors/Error404';
import { Op } from 'sequelize';
import QuizService from './quizService';
import TrainingCertificateService from './trainingCertificateService';

/**
 * Guard-facing training: list assigned courses, view course detail, mark
 * lessons complete, submit the course quiz, and fetch earned certificates.
 *
 * Works directly off the Sequelize models bag (`db`) — guard endpoints don't go
 * through the tenant-scoped repository layer. Every query is tenant-scoped and
 * keyed to the guard's own securityGuard record.
 *
 * COMPLETION + POINTS: a course is "completed" when all lessons are done AND
 * (if the course has a quiz) the quiz is passed. On completion we issue a
 * certificate and the enrollment row is flipped to status='completed' with
 * quizPassed=true; guardPerformanceService.trainingScore() reads these
 * completed/passed enrollments to feed the "training" performance factor (the
 * course's pointsValue is the achievement points surfaced in "Mis logros").
 */
export default class TrainingEnrollmentService {
  /** Resolve the guard's own securityGuard record for this tenant. */
  static async resolveGuard(db: any, tenantId: string, userId: string) {
    return db.securityGuard.findOne({
      where: { guardId: userId, tenantId, deletedAt: null },
    });
  }

  /**
   * Ensure the guard has a concrete enrollment row for a course. If only an
   * `all_guards` template exists, materialize a per-guard row. Returns the row
   * or null when the guard isn't assigned (and no all_guards template applies).
   */
  static async ensureEnrollment(
    db: any,
    tenantId: string,
    securityGuardId: string,
    courseId: string,
  ) {
    let row = await db.trainingEnrollment.findOne({
      where: { tenantId, courseId, securityGuardId, deletedAt: null },
    });
    if (row) return row;

    const template = await db.trainingEnrollment.findOne({
      where: {
        tenantId,
        courseId,
        securityGuardId: null,
        assignmentType: 'all_guards',
        deletedAt: null,
      },
    });
    if (!template) return null;

    row = await db.trainingEnrollment.create({
      courseId,
      securityGuardId,
      assignmentType: 'all_guards',
      assignedAt: template.assignedAt || new Date(),
      dueDate: template.dueDate || null,
      status: 'assigned',
      tenantId,
      createdById: template.createdById || null,
    });
    return row;
  }

  /** Guard's assigned courses (materialized rows + all_guards templates). */
  static async myEnrollments(
    db: any,
    tenantId: string,
    securityGuardId: string,
    args: any = {},
  ) {
    // Materialize any pending all_guards templates so they appear in the list.
    const templates = await db.trainingEnrollment.findAll({
      where: {
        tenantId,
        securityGuardId: null,
        assignmentType: 'all_guards',
        deletedAt: null,
      },
      attributes: ['courseId'],
    });
    for (const t of templates) {
      await this.ensureEnrollment(db, tenantId, securityGuardId, t.courseId);
    }

    const where: any = { tenantId, securityGuardId, deletedAt: null };
    if (args.status) where.status = args.status;

    const result = await db.trainingEnrollment.findAndCountAll({
      where,
      limit: args.limit != null ? Number(args.limit) : undefined,
      offset: args.offset != null ? Number(args.offset) : undefined,
      order: [['assignedAt', 'DESC']],
      include: [{ model: db.trainingCourse, as: 'course', required: false }],
    });

    const rows = result.rows.map((e: any) => ({
      id: e.id,
      courseId: e.courseId,
      courseTitle: e.course ? e.course.title : null,
      status: e.status,
      progressPercentage: e.progressPercentage,
      dueDate: e.dueDate,
      completedAt: e.completedAt,
    }));
    return { rows, count: result.count };
  }

  /** Full enrollment detail + lessons with per-lesson completion flag. */
  static async enrollmentDetail(
    db: any,
    tenantId: string,
    securityGuardId: string,
    enrollmentId: string,
  ) {
    const e = await db.trainingEnrollment.findOne({
      where: { id: enrollmentId, tenantId, securityGuardId, deletedAt: null },
      include: [{ model: db.trainingCourse, as: 'course', required: false }],
    });
    if (!e) throw new Error404();

    // Mark started on first open.
    if (!e.startedAt) {
      await e.update({ startedAt: new Date(), status: e.status === 'assigned' ? 'in_progress' : e.status });
    }

    const lessons = await db.trainingLesson.findAll({
      where: { courseId: e.courseId, deletedAt: null },
      order: [['order', 'ASC']],
    });
    const completions = await db.trainingLessonCompletion.findAll({
      where: { enrollmentId, tenantId, deletedAt: null },
    });
    const done = new Set(
      completions.filter((c: any) => c.completedAt).map((c: any) => String(c.lessonId)),
    );

    const quiz = await db.quizBank.findOne({
      where: { courseId: e.courseId, deletedAt: null },
    });

    return {
      id: e.id,
      courseId: e.courseId,
      courseTitle: e.course ? e.course.title : null,
      status: e.status,
      progressPercentage: e.progressPercentage,
      quizPassed: e.quizPassed,
      hasQuiz: !!quiz,
      quizBankId: quiz ? quiz.id : null,
      passPct: quiz ? Number(quiz.passPct) || 70 : null,
      lessons: lessons.map((l: any) => ({
        id: l.id,
        order: l.order,
        title: l.title,
        description: l.description,
        videoUrl: l.videoUrl,
        richContent: l.richContent,
        resources: l.resources,
        durationMinutes: l.durationMinutes,
        completed: done.has(String(l.id)),
      })),
    };
  }

  /** Recompute progressPercentage from lesson completions (lessons only). */
  static async recomputeProgress(db: any, tenantId: string, enrollment: any) {
    const totalLessons = await db.trainingLesson.count({
      where: { courseId: enrollment.courseId, deletedAt: null },
    });
    const doneLessons = await db.trainingLessonCompletion.count({
      where: {
        enrollmentId: enrollment.id,
        tenantId,
        completedAt: { [Op.ne]: null },
        deletedAt: null,
      },
    });
    const pct = totalLessons > 0 ? Math.round((doneLessons / totalLessons) * 100) : 0;
    return { totalLessons, doneLessons, pct };
  }

  /** Guard marks a lesson complete. Returns updated progress. */
  static async completeLesson(
    db: any,
    tenantId: string,
    securityGuardId: string,
    lessonId: string,
    enrollmentId: string,
    timeSpentSeconds?: number | null,
  ) {
    const lesson = await db.trainingLesson.findOne({
      where: { id: lessonId, tenantId, deletedAt: null },
    });
    if (!lesson) throw new Error404();

    const enrollment = await db.trainingEnrollment.findOne({
      where: { id: enrollmentId, tenantId, securityGuardId, courseId: lesson.courseId, deletedAt: null },
    });
    if (!enrollment) throw new Error404();

    let completion = await db.trainingLessonCompletion.findOne({
      where: { enrollmentId, lessonId, tenantId, deletedAt: null },
    });
    if (completion) {
      if (!completion.completedAt) {
        await completion.update({
          completedAt: new Date(),
          timeSpentSeconds: timeSpentSeconds != null ? Number(timeSpentSeconds) : completion.timeSpentSeconds,
        });
      }
    } else {
      completion = await db.trainingLessonCompletion.create({
        enrollmentId,
        lessonId,
        tenantId,
        viewedAt: new Date(),
        completedAt: new Date(),
        timeSpentSeconds: timeSpentSeconds != null ? Number(timeSpentSeconds) : null,
      });
    }

    const { pct } = await this.recomputeProgress(db, tenantId, enrollment);
    const patch: any = { progressPercentage: pct };
    if (enrollment.status === 'assigned') patch.status = 'in_progress';
    await enrollment.update(patch);

    // Lessons-only auto-complete when there's no quiz.
    await this.maybeComplete(db, tenantId, enrollment);

    return { id: completion.id, completedAt: completion.completedAt, progressPercentage: pct };
  }

  /**
   * Grade + persist a course-quiz attempt, then maybe complete the course.
   * Reuses QuizService.gradeAndSave so it shares the station-quiz pipeline.
   */
  static async submitQuiz(
    db: any,
    {
      tenantId,
      securityGuardId,
      subjectUserId,
      enrollmentId,
      bankId,
      answers,
      startedAt,
    }: {
      tenantId: string;
      securityGuardId: string;
      subjectUserId: string;
      enrollmentId: string;
      bankId: string;
      answers: Array<{ questionId: string; chosenIndex: number }>;
      startedAt?: Date | null;
    },
  ) {
    if (!bankId) throw new Error400(undefined, 'quiz.bankRequired');
    if (!Array.isArray(answers) || !answers.length) {
      throw new Error400(undefined, 'quiz.answersRequired');
    }

    const enrollment = await db.trainingEnrollment.findOne({
      where: { id: enrollmentId, tenantId, securityGuardId, deletedAt: null },
    });
    if (!enrollment) throw new Error404();

    const bank = await db.quizBank.findOne({
      where: { id: bankId, tenantId, courseId: enrollment.courseId, deletedAt: null },
    });
    if (!bank) throw new Error404();

    const result = await QuizService.gradeAndSave(db, {
      tenantId,
      bankId,
      stationId: null,
      subjectUserId,
      securityGuardId,
      subjectType: 'guard',
      answers,
      startedAt: startedAt || null,
    });

    const patch: any = { quizScore: result.scorePct };
    if (result.passed) patch.quizPassed = true;
    if (enrollment.status === 'assigned') patch.status = 'in_progress';
    await enrollment.update(patch);

    const completion = await this.maybeComplete(db, tenantId, enrollment);

    return {
      id: result.id,
      total: result.total,
      correctCount: result.correctCount,
      scorePct: result.scorePct,
      passed: result.passed,
      passPct: result.passPct,
      certificateId: completion && completion.certificate ? completion.certificate.id : null,
    };
  }

  /**
   * Determine whether the enrollment now satisfies completion (all lessons done
   * AND, if a quiz exists, it's passed). If so, mark completed and issue a
   * certificate. Returns { completed, certificate } (certificate may be null).
   *
   * The course's pointsValue is the achievement points credited on completion;
   * guardPerformanceService.trainingScore() factors completed/passed enrollments
   * into the "training" performance component.
   */
  static async maybeComplete(db: any, tenantId: string, enrollment: any) {
    if (enrollment.status === 'completed') {
      const cert = await db.trainingCertificate.findOne({
        where: { tenantId, courseId: enrollment.courseId, securityGuardId: enrollment.securityGuardId, deletedAt: null },
      });
      return { completed: true, certificate: cert };
    }

    const { totalLessons, doneLessons } = await this.recomputeProgress(db, tenantId, enrollment);
    const lessonsDone = totalLessons === 0 || doneLessons >= totalLessons;

    const quiz = await db.quizBank.findOne({
      where: { courseId: enrollment.courseId, deletedAt: null },
    });
    const quizOk = !quiz || enrollment.quizPassed === true;

    if (!lessonsDone || !quizOk) {
      return { completed: false, certificate: null };
    }

    await enrollment.update({
      status: 'completed',
      completedAt: new Date(),
      progressPercentage: 100,
      quizPassed: quiz ? true : enrollment.quizPassed,
    });

    // Issue certificate (idempotent).
    let certificate = null;
    try {
      const course = await db.trainingCourse.findByPk(enrollment.courseId);
      const guard = await db.securityGuard.findByPk(enrollment.securityGuardId);
      const tenant = await db.tenant.findByPk(tenantId).catch(() => null);
      certificate = await TrainingCertificateService.issue(db, {
        tenantId,
        courseId: enrollment.courseId,
        securityGuardId: enrollment.securityGuardId,
        guardName: (guard && guard.fullName) || 'Guardia',
        courseTitle: (course && course.title) || 'Curso',
        score: enrollment.quizScore != null ? enrollment.quizScore : null,
        certificateTemplate: course && course.certificateTemplate,
        tenantName: tenant && tenant.name,
      });
    } catch (err: any) {
      console.error('training certificate issuance failed:', err?.message || err);
    }

    return { completed: true, certificate };
  }

  /** Guard's earned certificates (for "Mis logros"). */
  static async certificatesList(
    db: any,
    tenantId: string,
    securityGuardId: string,
    args: any = {},
  ) {
    const result = await db.trainingCertificate.findAndCountAll({
      where: { tenantId, securityGuardId, deletedAt: null },
      limit: args.limit != null ? Number(args.limit) : undefined,
      offset: args.offset != null ? Number(args.offset) : undefined,
      order: [['issuedAt', 'DESC']],
      include: [{ model: db.trainingCourse, as: 'course', required: false }],
    });
    const rows = result.rows.map((c: any) => ({
      id: c.id,
      courseTitle: c.courseTitle,
      serialNumber: c.serialNumber,
      score: c.score,
      issuedAt: c.issuedAt,
      publicUrl: c.publicUrl,
      pointsValue: c.course ? c.course.pointsValue : null,
    }));
    return { rows, count: result.count };
  }

  static async certificateDetail(
    db: any,
    tenantId: string,
    securityGuardId: string,
    certificateId: string,
  ) {
    const c = await db.trainingCertificate.findOne({
      where: { id: certificateId, tenantId, securityGuardId, deletedAt: null },
    });
    if (!c) throw new Error404();
    return {
      id: c.id,
      serialNumber: c.serialNumber,
      guardName: c.guardName,
      courseTitle: c.courseTitle,
      score: c.score,
      issuedAt: c.issuedAt,
      htmlContent: c.htmlContent,
      downloadToken: c.downloadToken,
      publicUrl: c.publicUrl,
    };
  }
}

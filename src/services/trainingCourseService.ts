import Error400 from '../errors/Error400';
import Error404 from '../errors/Error404';
import { Op } from 'sequelize';
import { IServiceOptions } from './IServiceOptions';
import SequelizeRepository from '../database/repositories/sequelizeRepository';

/**
 * Tenant-side training course management: course CRUD, lessons, course quiz,
 * guard enrollment + admin progress views. All operations are tenant-scoped.
 *
 * Course completion + points award (feeding guardPerformanceService's
 * "training" factor) and certificate issuance live in TrainingEnrollmentService
 * (guard-facing) and are reused here.
 */
export default class TrainingCourseService {
  options: IServiceOptions;
  db: any;
  tenantId: string;
  userId: string | null;

  constructor(options: IServiceOptions) {
    this.options = options;
    this.db = options.database;
    const tenant = SequelizeRepository.getCurrentTenant(options);
    this.tenantId = tenant && tenant.id;
    const user = SequelizeRepository.getCurrentUser(options);
    this.userId = (user && user.id) || null;
  }

  // ---- Courses -----------------------------------------------------------

  async create(data: any) {
    if (!data || !data.title) {
      throw new Error400(this.options.language, 'training.errors.titleRequired');
    }
    const course = await this.db.trainingCourse.create({
      title: data.title,
      description: data.description ?? null,
      coverUrl: data.coverUrl ?? null,
      category: data.category ?? null,
      level: data.level ?? null,
      pointsValue: Number.isFinite(Number(data.pointsValue)) ? Number(data.pointsValue) : 0,
      passingScore: Number.isFinite(Number(data.passingScore)) ? Number(data.passingScore) : 70,
      certificateTemplate: data.certificateTemplate ?? null,
      published: data.published === true,
      isAddon: false,
      tenantId: this.tenantId,
      createdById: this.userId,
      updatedById: this.userId,
    });
    return course;
  }

  /** Course accessible to the tenant: an own course OR a granted addon course. */
  private async findOwnedCourse(id: string) {
    const course = await this.db.trainingCourse.findOne({
      where: { id, deletedAt: null },
    });
    if (!course) throw new Error404(this.options.language);

    // Tenant-owned course.
    if (course.tenantId === this.tenantId) return course;

    // Granted addon course?
    if (course.isAddon) {
      const grant = await this.db.addonCourseGrant.findOne({
        where: {
          addonCourseId: id,
          tenantId: this.tenantId,
          status: 'active',
          deletedAt: null,
        },
      });
      if (grant) return course;
    }

    throw new Error404(this.options.language);
  }

  async findById(id: string) {
    const course = await this.findOwnedCourse(id);
    const lessons = await this.db.trainingLesson.findAll({
      where: { courseId: id, deletedAt: null },
      order: [['order', 'ASC']],
    });
    const quiz = await this.db.quizBank.findOne({
      where: { courseId: id, deletedAt: null },
    });
    return {
      ...course.get({ plain: true }),
      lessons: lessons.map((l: any) => l.get({ plain: true })),
      quiz: quiz
        ? { id: quiz.id, bankId: quiz.id, passPct: Number(quiz.passPct) || 70 }
        : null,
    };
  }

  async findAndCountAll(args: any = {}) {
    const limit = args.limit != null ? Number(args.limit) : undefined;
    const offset = args.offset != null ? Number(args.offset) : undefined;

    const where: any = { deletedAt: null };
    // Own courses + granted addon courses.
    const grants = await this.db.addonCourseGrant.findAll({
      where: { tenantId: this.tenantId, status: 'active', deletedAt: null },
      attributes: ['addonCourseId'],
    });
    const grantedIds = grants.map((g: any) => g.addonCourseId);

    const scope: any[] = [{ tenantId: this.tenantId }];
    if (grantedIds.length) scope.push({ id: { [Op.in]: grantedIds } });
    where[Op.or] = scope;

    if (args.category) where.category = args.category;
    if (args.published != null) {
      where.published = args.published === true || args.published === 'true';
    }

    const result = await this.db.trainingCourse.findAndCountAll({
      where,
      limit,
      offset,
      order: [['createdAt', 'DESC']],
    });
    return { rows: result.rows, count: result.count };
  }

  async update(id: string, data: any) {
    const course = await this.db.trainingCourse.findOne({
      where: { id, tenantId: this.tenantId, deletedAt: null },
    });
    if (!course) throw new Error404(this.options.language);

    const patch: any = { updatedById: this.userId };
    for (const k of [
      'title', 'description', 'coverUrl', 'category', 'level',
      'certificateTemplate', 'published',
    ]) {
      if (data[k] !== undefined) patch[k] = data[k];
    }
    if (data.pointsValue !== undefined) patch.pointsValue = Number(data.pointsValue);
    if (data.passingScore !== undefined) patch.passingScore = Number(data.passingScore);

    await course.update(patch);
    return course;
  }

  async destroy(id: string) {
    const course = await this.db.trainingCourse.findOne({
      where: { id, tenantId: this.tenantId, deletedAt: null },
    });
    if (!course) throw new Error404(this.options.language);
    await course.destroy();
    return { success: true };
  }

  // ---- Lessons -----------------------------------------------------------

  async createLesson(courseId: string, data: any) {
    await this.findOwnedCourse(courseId);
    if (!data || !data.title) {
      throw new Error400(this.options.language, 'training.errors.lessonTitleRequired');
    }
    let order = data.order;
    if (order == null) {
      const max = await this.db.trainingLesson.max('order', {
        where: { courseId, deletedAt: null },
      });
      order = (Number(max) || 0) + 1;
    }
    const lesson = await this.db.trainingLesson.create({
      courseId,
      order: Number(order),
      title: data.title,
      description: data.description ?? null,
      videoUrl: data.videoUrl ?? null,
      richContent: data.richContent ?? null,
      resources: data.resources ?? null,
      durationMinutes: data.durationMinutes != null ? Number(data.durationMinutes) : null,
      tenantId: this.tenantId,
      createdById: this.userId,
      updatedById: this.userId,
    });
    return lesson;
  }

  async listLessons(courseId: string) {
    await this.findOwnedCourse(courseId);
    const rows = await this.db.trainingLesson.findAll({
      where: { courseId, deletedAt: null },
      order: [['order', 'ASC']],
    });
    return { rows };
  }

  async updateLesson(lessonId: string, data: any) {
    const lesson = await this.db.trainingLesson.findOne({
      where: { id: lessonId, tenantId: this.tenantId, deletedAt: null },
    });
    if (!lesson) throw new Error404(this.options.language);

    const patch: any = { updatedById: this.userId };
    for (const k of ['title', 'description', 'videoUrl', 'richContent', 'resources']) {
      if (data[k] !== undefined) patch[k] = data[k];
    }
    if (data.order !== undefined) patch.order = Number(data.order);
    if (data.durationMinutes !== undefined) patch.durationMinutes = Number(data.durationMinutes);
    await lesson.update(patch);
    return lesson;
  }

  async destroyLesson(lessonId: string) {
    const lesson = await this.db.trainingLesson.findOne({
      where: { id: lessonId, tenantId: this.tenantId, deletedAt: null },
    });
    if (!lesson) throw new Error404(this.options.language);
    await lesson.destroy();
    return { success: true };
  }

  // ---- Course quiz (reuses quizBank/quizQuestion) ------------------------

  async upsertQuiz(courseId: string, data: any) {
    const course = await this.findOwnedCourse(courseId);
    if (course.tenantId !== this.tenantId) {
      // Addon courses are authored by superadmin; tenants cannot edit their quiz.
      throw new Error400(this.options.language, 'training.errors.addonReadOnly');
    }

    let bank = await this.db.quizBank.findOne({
      where: { courseId, tenantId: this.tenantId, deletedAt: null },
    });

    const questionsPerAttempt = Number(data.questionsPerAttempt) || 10;
    const passPct = Number(data.passPct) || course.passingScore || 70;

    if (!bank) {
      bank = await this.db.quizBank.create({
        title: course.title,
        questionsPerAttempt,
        passPct,
        active: true,
        courseId,
        stationId: null,
        tenantId: this.tenantId,
        createdById: this.userId,
        updatedById: this.userId,
      });
    } else {
      await bank.update({ questionsPerAttempt, passPct, updatedById: this.userId });
    }

    // Replace question set if provided.
    if (Array.isArray(data.questions)) {
      await this.db.quizQuestion.destroy({
        where: { quizBankId: bank.id, tenantId: this.tenantId },
      });
      for (const q of data.questions) {
        await this.db.quizQuestion.create({
          quizBankId: bank.id,
          prompt: q.prompt,
          options: q.options || [],
          correctIndex: Number(q.correctIndex) || 0,
          active: true,
          tenantId: this.tenantId,
          createdById: this.userId,
          updatedById: this.userId,
        });
      }
    }

    return { id: bank.id, bankId: bank.id, courseName: course.title };
  }

  // ---- Enrollment (admin assignment) -------------------------------------

  async enroll(courseId: string, data: any) {
    await this.findOwnedCourse(courseId);
    const assignmentType = data.assignmentType === 'all_guards' ? 'all_guards' : 'individual';

    if (assignmentType === 'individual') {
      if (!data.securityGuardId) {
        throw new Error400(this.options.language, 'training.errors.guardRequired');
      }
      const guard = await this.db.securityGuard.findOne({
        where: { id: data.securityGuardId, tenantId: this.tenantId, deletedAt: null },
        attributes: ['id'],
      });
      if (!guard) throw new Error404(this.options.language);

      const existing = await this.db.trainingEnrollment.findOne({
        where: {
          courseId,
          securityGuardId: data.securityGuardId,
          tenantId: this.tenantId,
          deletedAt: null,
        },
      });
      if (existing) return existing;

      return this.db.trainingEnrollment.create({
        courseId,
        securityGuardId: data.securityGuardId,
        assignmentType: 'individual',
        assignedAt: new Date(),
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        status: 'assigned',
        tenantId: this.tenantId,
        createdById: this.userId,
      });
    }

    // all_guards: a single template row (securityGuardId null). Per-guard rows
    // are materialized lazily when each guard opens the course.
    const existingAll = await this.db.trainingEnrollment.findOne({
      where: {
        courseId,
        securityGuardId: null,
        assignmentType: 'all_guards',
        tenantId: this.tenantId,
        deletedAt: null,
      },
    });
    if (existingAll) return existingAll;

    return this.db.trainingEnrollment.create({
      courseId,
      securityGuardId: null,
      assignmentType: 'all_guards',
      assignedAt: new Date(),
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      status: 'assigned',
      tenantId: this.tenantId,
      createdById: this.userId,
    });
  }

  async listEnrollments(courseId: string, args: any = {}) {
    await this.findOwnedCourse(courseId);
    const where: any = { courseId, tenantId: this.tenantId, deletedAt: null };
    if (args.status) where.status = args.status;

    const result = await this.db.trainingEnrollment.findAndCountAll({
      where,
      limit: args.limit != null ? Number(args.limit) : undefined,
      offset: args.offset != null ? Number(args.offset) : undefined,
      order: [['assignedAt', 'DESC']],
      include: [{ model: this.db.securityGuard, as: 'guard', required: false }],
    });

    const rows = result.rows.map((e: any) => {
      const g = e.guard;
      const guardName = g
        ? g.fullName || null
        : null;
      return {
        id: e.id,
        guardId: e.securityGuardId,
        guardName,
        assignmentType: e.assignmentType,
        status: e.status,
        progressPercentage: e.progressPercentage,
        quizPassed: e.quizPassed,
        quizScore: e.quizScore,
        completedAt: e.completedAt,
        dueDate: e.dueDate,
      };
    });
    return { rows, count: result.count };
  }

  async enrollmentDetail(enrollmentId: string) {
    const e = await this.db.trainingEnrollment.findOne({
      where: { id: enrollmentId, tenantId: this.tenantId, deletedAt: null },
      include: [{ model: this.db.securityGuard, as: 'guard', required: false }],
    });
    if (!e) throw new Error404(this.options.language);

    const lessons = await this.db.trainingLesson.findAll({
      where: { courseId: e.courseId, deletedAt: null },
      order: [['order', 'ASC']],
    });
    const completions = await this.db.trainingLessonCompletion.findAll({
      where: { enrollmentId, tenantId: this.tenantId, deletedAt: null },
    });
    const doneByLesson: Record<string, any> = {};
    completions.forEach((c: any) => { doneByLesson[c.lessonId] = c; });

    const g = e.guard;
    const guardName = g
      ? g.fullName || null
      : null;

    return {
      id: e.id,
      courseId: e.courseId,
      guardName,
      status: e.status,
      progressPercentage: e.progressPercentage,
      quizPassed: e.quizPassed,
      quizScore: e.quizScore,
      lessonCompletions: lessons.map((l: any) => ({
        lessonId: l.id,
        title: l.title,
        completedAt: doneByLesson[l.id] ? doneByLesson[l.id].completedAt : null,
      })),
    };
  }
}

/**
 * Quiz helpers for the "station security test" performance factor.
 *
 * A guard's test is built by sampling N active questions from their station's
 * quiz bank. Questions returned to the guard are SANITIZED — `correctIndex` is
 * never exposed. Grading happens server-side from the stored bank.
 */

const shuffle = <T>(arr: T[]): T[] => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export interface SanitizedQuestion {
  id: string;
  prompt: string;
  options: string[];
}

export default class QuizService {
  /** The active quiz bank for a station, or null. */
  static async bankForStation(db: any, tenantId: string, stationId: string) {
    return db.quizBank.findOne({
      where: { tenantId, stationId, active: true, deletedAt: null },
    });
  }

  /**
   * Build a sanitized N-question attempt for a station bank.
   * Returns null if the station has no active bank with questions.
   */
  static async buildAttempt(db: any, tenantId: string, stationId: string) {
    const bank = await QuizService.bankForStation(db, tenantId, stationId);
    if (!bank) return null;

    const questions = await db.quizQuestion.findAll({
      where: { tenantId, quizBankId: bank.id, active: true, deletedAt: null },
    });
    if (!questions.length) return null;

    const n = Math.max(1, Number(bank.questionsPerAttempt) || 10);
    const picked = shuffle(questions).slice(0, Math.min(n, questions.length));

    const sanitized: SanitizedQuestion[] = picked.map((q: any) => ({
      id: q.id,
      prompt: q.prompt,
      options: q.options, // model getter already parses JSON
    }));

    return {
      bankId: bank.id,
      stationId,
      title: bank.title || null,
      passPct: Number(bank.passPct) || 70,
      total: sanitized.length,
      questions: sanitized,
    };
  }

  /**
   * Grade a set of answers against the stored bank and persist a quizAttempt.
   * `answers` = [{ questionId, chosenIndex }]. Returns the graded result.
   */
  static async gradeAndSave(
    db: any,
    {
      tenantId,
      bankId,
      stationId,
      subjectUserId,
      securityGuardId,
      subjectType,
      answers,
      startedAt,
    }: {
      tenantId: string;
      bankId: string;
      stationId?: string | null;
      subjectUserId: string;
      securityGuardId?: string | null;
      subjectType: 'guard' | 'supervisor';
      answers: Array<{ questionId: string; chosenIndex: number }>;
      startedAt?: Date | null;
    },
  ) {
    const list = Array.isArray(answers) ? answers : [];
    const ids = list.map((a) => a.questionId).filter(Boolean);

    const questions = ids.length
      ? await db.quizQuestion.findAll({
          where: { tenantId, quizBankId: bankId, id: ids, deletedAt: null },
        })
      : [];
    const byId: Record<string, any> = {};
    questions.forEach((q: any) => {
      byId[q.id] = q;
    });

    const graded = list.map((a) => {
      const q = byId[a.questionId];
      const correct =
        !!q && Number(q.correctIndex) === Number(a.chosenIndex);
      return {
        questionId: a.questionId,
        chosenIndex: Number(a.chosenIndex),
        correct,
      };
    });

    const total = graded.length;
    const correctCount = graded.filter((g) => g.correct).length;
    const scorePct = total ? Math.round((correctCount / total) * 100) : 0;

    const attempt = await db.quizAttempt.create({
      quizBankId: bankId,
      stationId: stationId || null,
      subjectUserId,
      securityGuardId: securityGuardId || null,
      subjectType,
      total,
      correctCount,
      scorePct,
      answers: graded,
      startedAt: startedAt || null,
      completedAt: new Date(),
      tenantId,
    });

    const bank = await db.quizBank.findByPk(bankId, { attributes: ['passPct'] });
    const passPct = Number(bank?.passPct) || 70;

    return {
      id: attempt.id,
      total,
      correctCount,
      scorePct,
      passed: scorePct >= passPct,
      passPct,
      results: graded,
    };
  }
}

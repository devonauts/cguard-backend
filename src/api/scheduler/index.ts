/**
 * Legacy OpenAI schedule generator (POST /scheduler/generate + /apply) was
 * RETIRED in Phase 3: it was a second, competing generator/writer that wrote
 * shifts directly and fabricated cost. The deterministic rotation engine plus
 * the draft → review → publish proposal flow (POST /scheduler/proposals…) is now
 * the single source of truth. The advisory LLM lives on at /scheduler/ai-recommend.
 */
export default (_app) => {
  // No routes — intentionally retired.
};

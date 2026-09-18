// What public benchmarks say about which model is better at what, so routing is an evidence-based
// choice rather than anyone's impression. Every row records the benchmark, the score, the date it
// was read and the page it came from; nothing here is inferred from reputation or vibes.
//
// Two rules keep this table honest rather than flattering:
//
//  1. No capability is decided by a single leaderboard. One benchmark is one test with one bias,
//     and a worker that wins it has won that test, not the category. A capability with only one
//     source says so in `because`, so a thin claim never reads like a strong one.
//  2. A benchmark with a known validity problem carries its `caveat` and a reduced `weight`.
//     SWE-bench Verified is the case in point: its 500 Python tasks predate publication and appear
//     in training data, models have been shown to reproduce gold patches verbatim, and scores on it
//     run ~35 points above the same models on SWE-bench Pro. It is kept because it is still the
//     most-cited number, and discounted because it is the least trustworthy one.
//
// This table goes stale. `capturedOn` is shown wherever it is used, and refreshing it is a normal
// task: re-read the sources and replace the rows.

import type { WorkerCapability } from "./types.ts";

export interface BenchmarkScore {
  /** The model as the leaderboard names it. */
  model: string;
  /** Score as the leaderboard reports it, with its unit. */
  score: string;
  /** Sort key: higher is better. */
  rank: number;
}

export interface BenchmarkEvidence {
  capability: WorkerCapability;
  benchmark: string;
  what: string;
  source: string;
  readOn: string;
  /**
   * How much this benchmark counts, 0-1. Anything below 1 must say why in `caveat`. A discounted
   * benchmark still appears in the evidence shown to the user; it just does not decide the order.
   */
  weight: number;
  /** A known reason to distrust this benchmark, shown next to its scores. */
  caveat?: string;
  scores: BenchmarkScore[];
}

export const BENCHMARKS_CAPTURED_ON = "2026-09-18";

export const BENCHMARK_EVIDENCE: BenchmarkEvidence[] = [
  {
    capability: "code",
    benchmark: "Terminal-Bench 4.0",
    what: "autonomous agents completing real command-line work end to end — the closest public test to what DEV actually asks a worker to do",
    source: "https://benchlm.ai/benchmarks/terminal-bench-4",
    readOn: "2026-09-18",
    weight: 1,
    scores: [
      { model: "GPT-6 Astra", score: "58.18%", rank: 1 },
      { model: "Claude Fable 5.1", score: "57.88%", rank: 2 },
      { model: "Claude Opus 5", score: "51.82%", rank: 3 },
      { model: "Claude Fable 5", score: "44.55%", rank: 4 },
      { model: "GLM-5.3", score: "41.82%", rank: 5 },
      { model: "GPT-5.6 Sol", score: "37.27%", rank: 6 },
      { model: "Claude Opus 4.8", score: "23.64%", rank: 7 },
      { model: "GPT-5.6 Terra", score: "21.52%", rank: 8 },
      { model: "Grok 4.6", score: "20.30%", rank: 9 },
      { model: "Gemini 3.8 Flash", score: "19.09%", rank: 10 },
      { model: "GPT-5.6 Luna", score: "17.27%", rank: 11 },
      { model: "Grok 4.5", score: "12.42%", rank: 12 },
      { model: "Claude Sonnet 5", score: "12.42%", rank: 12 },
      { model: "Gemini 3.7 Flash", score: "11.21%", rank: 14 },
    ],
  },
  {
    capability: "code",
    benchmark: "SWE-bench Pro",
    what: "longer-horizon issue resolution, including private codebases the models cannot have memorised",
    source: "https://codeant.ai/blogs/swe-bench-scores",
    readOn: "2026-09-18",
    weight: 1,
    caveat: "Scores here are far lower than on Verified (best model ~57%, average ~25%), which is the point: this is the uncontaminated measurement.",
    scores: [
      { model: "GPT-5", score: "23.1% (14.9% on private repositories)", rank: 1 },
      { model: "Claude Opus 4.1", score: "22.7% (17.8% on private repositories)", rank: 2 },
    ],
  },
  {
    capability: "code",
    benchmark: "SWE-bench Verified",
    what: "resolving real GitHub issues in Python repositories",
    source: "https://benchlm.ai/benchmarks/swe-bench-verified",
    readOn: "2026-09-18",
    weight: 0.4,
    caveat:
      "Known contaminated: the 500 tasks predate publication and appear in training data, models reproduce gold patches verbatim, and OpenAI stopped reporting it in early 2026 in favour of SWE-bench Pro. Counted at reduced weight.",
    scores: [
      { model: "Claude Opus 5", score: "96%", rank: 1 },
      { model: "Claude Mythos 5", score: "95.5%", rank: 2 },
      { model: "Claude Fable 5", score: "95%", rank: 3 },
      { model: "Claude Opus 4.8", score: "88.6%", rank: 4 },
      { model: "Claude Opus 4.7 (Adaptive)", score: "87.6%", rank: 5 },
      { model: "Ornith-1.5-397B", score: "86%", rank: 6 },
      { model: "Claude Sonnet 5", score: "85.2%", rank: 7 },
      { model: "GPT-5.3 Codex", score: "85%", rank: 8 },
      { model: "Claude Opus 4.5", score: "80.9%", rank: 10 },
      { model: "Claude Opus 4.6", score: "80.8%", rank: 11 },
      { model: "DeepSeek V4 Pro 0813", score: "80.6%", rank: 12 },
      { model: "MiniMax M3", score: "80.5%", rank: 13 },
      { model: "Qwen3.7 Max", score: "80.4%", rank: 14 },
      { model: "Kimi K2.6", score: "80.2%", rank: 15 },
    ],
  },
  {
    capability: "research",
    benchmark: "BrowseComp",
    what: "hard questions that need persistent web browsing to answer",
    source: "https://leaderboard.steel.dev/leaderboards/browsecomp/",
    readOn: "2026-09-17",
    weight: 1,
    caveat: "Only one source for this capability, and only one model on it. Treat the resulting order as weak.",
    scores: [{ model: "GPT-5.6 Sol Ultra", score: "92.2%", rank: 1 }],
  },
  {
    capability: "plan",
    benchmark: "GPQA Diamond",
    what: "graduate-level reasoning across the sciences",
    source: "https://greenflagdigital.com/top-ai-models-ranked/",
    readOn: "2026-09-17",
    weight: 1,
    scores: [{ model: "GPT-6 Astra (xhigh)", score: "96.3%", rank: 1 }],
  },
  {
    capability: "plan",
    benchmark: "ARC-AGI-2",
    what: "abstract reasoning on unseen problem shapes",
    source: "https://llm-stats.com/benchmarks/arc-agi",
    readOn: "2026-09-17",
    weight: 1,
    scores: [
      { model: "GPT-5.6 Sol (max reasoning)", score: "92.5%", rank: 1 },
      { model: "Gemini 3.7 Flash", score: "84.6%", rank: 2 },
    ],
  },
];

/**
 * Which DEV worker runs which family of model. A worker is only as good as the model it is
 * configured with, so the match is made on the configured model when there is one.
 *
 * Every worker DEV can build appears here, including the local and API ones, so that a model a
 * leaderboard names can be credited to whichever worker would actually run it — not only to the
 * three vendors with their own CLI.
 */
const FAMILY: { worker: string; matches: RegExp }[] = [
  { worker: "claude-code", matches: /^claude|^fable|^opus|^sonnet|^haiku|^mythos/i },
  { worker: "codex", matches: /^gpt|^codex|^o[1-9]/i },
  { worker: "grok", matches: /^grok/i },
  { worker: "gemini", matches: /^gemini|^gemma/i },
  { worker: "opencode", matches: /^glm|^qwen|^deepseek|^kimi|^minimax/i },
];

export interface RoutingSuggestion {
  capability: WorkerCapability;
  /** Worker ids, best first, that the evidence supports and that this machine actually has. */
  order: string[];
  /** Why, in the user's terms: the benchmark, the winning model and its score. */
  because: string;
  evidence: BenchmarkEvidence[];
  /** Workers the evidence favours that are not installed or not healthy here. */
  unavailable: string[];
  /**
   * How much this order is worth believing. "strong" = several benchmarks agree at full weight,
   * "weak" = one benchmark, or only discounted ones. Shown so a thin basis is never hidden.
   */
  confidence: "strong" | "weak";
}

/**
 * Turn the benchmark table into an order for the workers this machine actually has.
 *
 * A worker's standing is its weighted mean rank across every benchmark for the capability in which
 * one of its models appears — so winning a single leaderboard does not win the category, and a
 * discounted benchmark moves the order less than a sound one. Workers with no evidence keep their
 * existing relative order at the end, so nothing is silently dropped.
 */
export function suggestRouting(input: {
  /** Workers available here: id, the capabilities they offer, and the model each is configured with. */
  workers: { id: string; capabilities: readonly string[]; model?: string | null; healthy: boolean }[];
}): RoutingSuggestion[] {
  const out: RoutingSuggestion[] = [];
  const capabilities = [...new Set(BENCHMARK_EVIDENCE.map((e) => e.capability))];
  for (const capability of capabilities) {
    const evidence = BENCHMARK_EVIDENCE.filter((e) => e.capability === capability);
    const able = input.workers.filter((w) => w.capabilities.includes(capability));
    /** Per worker: the best rank it earned in each benchmark, with that benchmark's weight. */
    const perWorker = new Map<string, { benchmark: string; rank: number; position: number; weight: number; why: string }[]>();
    for (const row of evidence) {
      const bestHere = new Map<string, { rank: number; why: string }>();
      for (const score of row.scores) {
        for (const worker of able) {
          const family = FAMILY.find((f) => f.worker === worker.id);
          const modelMatches = worker.model ? score.model.toLowerCase().includes(worker.model.toLowerCase().split(/[:/]/)[0] ?? "") : false;
          if (!family?.matches.test(score.model) && !modelMatches) continue;
          const existing = bestHere.get(worker.id);
          if (!existing || score.rank < existing.rank) bestHere.set(worker.id, { rank: score.rank, why: `${score.model} scores ${score.score} on ${row.benchmark}` });
        }
      }
      // Score on position among the workers in the running, not on raw leaderboard rank. Whether a
      // worker's model placed 2nd or 8th overall says little when only three workers are being
      // compared; what decides the choice is which of those three came out ahead. Using raw ranks
      // let one discounted benchmark's wide gap outvote two sound benchmarks it had lost.
      const byPosition = [...bestHere.entries()].sort((a, b) => a[1].rank - b[1].rank);
      byPosition.forEach(([id, hit], index) => {
        const list = perWorker.get(id) ?? [];
        list.push({ benchmark: row.benchmark, rank: hit.rank, position: index + 1, weight: row.weight, why: hit.why });
        perWorker.set(id, list);
      });
    }
    const scored = new Map<string, { rank: number; why: string }>();
    for (const [id, hits] of perWorker) {
      const totalWeight = hits.reduce((sum, h) => sum + h.weight, 0);
      const mean = totalWeight > 0 ? hits.reduce((sum, h) => sum + h.position * h.weight, 0) / totalWeight : Number.POSITIVE_INFINITY;
      // Quote the worker's result on the soundest benchmark it appeared in, not its flattering one.
      const best = [...hits].sort((a, b) => b.weight - a.weight || a.rank - b.rank)[0];
      scored.set(id, { rank: mean, why: best?.why ?? "" });
    }
    const ranked = [...scored.entries()].sort((a, b) => a[1].rank - b[1].rank);
    const healthyRanked = ranked.filter(([id]) => able.find((w) => w.id === id)?.healthy);
    const order = healthyRanked.map(([id]) => id);
    const unavailable = ranked.filter(([id]) => !able.find((w) => w.id === id)?.healthy).map(([id]) => id);
    const best = healthyRanked[0] ?? ranked[0];
    const fullWeight = evidence.filter((e) => e.weight >= 1).length;
    const confidence: "strong" | "weak" = fullWeight >= 2 && (perWorker.get(best?.[0] ?? "")?.length ?? 0) >= 2 ? "strong" : "weak";
    // A capability with evidence but no matching worker still gets a row: silence would read as
    // "no data", when the truth is "the leader is a model none of your workers offers for this".
    const leaders = evidence.flatMap((e) => e.scores.filter((s) => s.rank === 1).map((s) => s.model));
    const basis = `across ${evidence.length} benchmark${evidence.length === 1 ? "" : "s"}`;
    out.push({
      capability: capability as WorkerCapability,
      order,
      because: best
        ? `${best[0]}: ${best[1].why} (${basis}${confidence === "weak" ? "; thin evidence, treat as a starting point" : ""})`
        : `the benchmark leaders (${leaders.join(", ")}) are not offered for "${capability}" by any worker here`,
      evidence,
      unavailable,
      confidence,
    });
  }
  return out;
}

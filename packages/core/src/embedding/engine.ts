import type {
  KeywordVector,
  ProductGeometry,
  RankingJudgment,
  RankingQuery,
  TrainingOptions,
  TrainingResult,
} from '../types.js';
import {
  DEFAULT_GEOMETRY,
  projectEmbedding,
  sameGeometry,
  validateKeywordVector,
} from './geometry.js';
import {
  buildComparisons,
  findLogicalConflicts,
  validateRankingJudgment,
  type Comparison,
} from './judgments.js';
import { optimizeRanking } from './optimizer.js';
import { selectRanking } from './selection.js';
/** Shared browser/Node engine: joint ordinal optimization on H × R. */
export class ProductEmbeddingEngine {
  readonly geometry: ProductGeometry;
  private vectors: KeywordVector[];
  private history: RankingJudgment[];
  private readonly comparisons: Comparison[];
  private readonly index: Map<string, number>;

  constructor(vectors: KeywordVector[], history: RankingJudgment[] = []) {
    if (vectors.length > 1000) throw new Error('At most 1000 keywords are supported');
    this.geometry = { ...(vectors[0]?.geometry ?? DEFAULT_GEOMETRY) };
    for (const v of vectors) {
      validateKeywordVector(v);
      if (!sameGeometry(v.geometry, this.geometry))
        throw new Error('Mixed embedding configurations');
    }
    this.vectors = structuredClone(vectors);
    this.index = new Map(vectors.map((v, i) => [v.keywordId, i]));
    if (this.index.size !== vectors.length) throw new Error('Duplicate keyword vectors');
    const ids = new Set(this.index.keys());
    // Deleted keywords remove only judgments that actually involve them.
    this.history = structuredClone(
      history.filter((j) => [j.anchorId, ...j.groups.flat()].every((id) => ids.has(id))),
    );
    for (const j of this.history) validateRankingJudgment(j, ids);
    if (new Set(this.history.map((j) => j.id)).size !== this.history.length)
      throw new Error('Duplicate judgment ids');
    this.comparisons = buildComparisons(this.history, this.index);
    if (findLogicalConflicts(this.comparisons).length)
      throw new Error('Inconsistent ranking history');
  }

  getVectors(): KeywordVector[] {
    return structuredClone(this.vectors);
  }
  getHistory(): RankingJudgment[] {
    return structuredClone(this.history);
  }

  trainRanking(judgment: RankingJudgment, options: TrainingOptions = {}): TrainingResult {
    validateRankingJudgment(judgment, new Set(this.index.keys()));
    const existing = this.history.find((j) => j.id === judgment.id);
    if (
      existing &&
      (existing.anchorId !== judgment.anchorId ||
        existing.confidence !== judgment.confidence ||
        existing.createdAt !== judgment.createdAt ||
        JSON.stringify(existing.groups.map((g) => [...g].sort())) !==
          JSON.stringify(judgment.groups.map((g) => [...g].sort())))
    )
      throw new Error('Judgment id already used');
    const result = (
      accepted: boolean,
      loss: number,
      conflicts: string[],
      updatedVectors: KeywordVector[] = [],
      maxDistanceDrift = 0,
    ): TrainingResult => ({
      accepted,
      loss,
      conflicts,
      updatedVectors,
      maxDistanceDrift,
      history: this.getHistory(),
    });
    if (existing) return result(true, 0, []);
    const fresh = buildComparisons([judgment], this.index);
    const conflicts = findLogicalConflicts([...this.comparisons, ...fresh]);
    if (conflicts.length) return result(false, 0, conflicts);
    const optimization = optimizeRanking(
      this.vectors,
      this.geometry,
      this.index,
      judgment,
      fresh,
      this.comparisons,
      options,
    );
    if (!optimization.accepted) {
      return result(false, optimization.loss, [
        'Cannot fit this judgment while preserving confirmed rankings. No changes were saved.',
      ]);
    }
    const { positions, touched, maxDistanceDrift } = optimization;
    const now = Math.max(Date.now(), ...this.vectors.map((v) => v.updatedAt + 1));
    const updated: KeywordVector[] = [];
    this.vectors = this.vectors.map((v, i) => {
      if (!touched.has(i) || v.embedding.every((n, k) => n === positions[i]![k])) return v;
      const [px, py] = projectEmbedding(positions[i]!, this.geometry);
      const next = { ...v, embedding: positions[i]!, x: px, y: py, updatedAt: now };
      updated.push(next);
      return next;
    });
    this.history.push(structuredClone(judgment));
    this.comparisons.push(...fresh);
    return result(true, optimization.loss, [], structuredClone(updated), maxDistanceDrift);
  }

  recommendRanking(options: { size?: number; excludedKeys?: string[] } = {}): RankingQuery | null {
    return selectRanking(
      this.vectors,
      this.history,
      this.index,
      this.geometry,
      this.comparisons,
      options,
    );
  }
}

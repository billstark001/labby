/**
 * Weighted Proportional Scheduling
 *
 * Generates a length-m sequence over k weighted objects such that:
 *  1. Var(n_i / w_i) is minimized  (Hamilton quota allocation)
 *  2. Per-object gap variance is minimized  (three-distance theorem)
 *  3. Output is randomized via independent per-object phase offsets
 */

// ── Quota Allocation ──────────────────────────────────────────────────────────

/**
 * Hamilton's largest-remainder method.
 * Returns integer n[i] s.t. sum(n) === m and Var(n_i / w_i) is minimized.
 */
export function allocateQuotas(weights: number[], m: number): number[] {
  const W = weights.reduce((s, w) => s + w, 0);
  const exact = weights.map(w => (m * w) / W);
  const n = exact.map(Math.floor);
  const extra = m - n.reduce((s, v) => s + v, 0);

  // Award +1 to objects with the largest fractional remainders
  exact
    .map((e, i) => [e - n[i], i] as [number, number])
    .sort(([a], [b]) => b - a)
    .slice(0, extra)
    .forEach(([, i]) => n[i]++);

  return n;
}

// ── Full Generation ───────────────────────────────────────────────────────────

/**
 * Batch stratified random generation.
 *
 * Object i receives n[i] positions at gap_i * (j + φ_i), φ_i ~ U[0,1).
 * By the three-distance theorem, consecutive gaps for object i take only
 * the values ⌊m/n_i⌋ and ⌈m/n_i⌉ — the integer optimum.
 *
 * @param jitterFrac  Per-occurrence noise in (-1, 1) relative to gap/2.
 *                    Must be < 1 to preserve gap optimality. Default: 0.
 */
export function fullGenerate(
  weights: number[],
  m: number,
  jitterFrac = 0
): number[] {
  const n = allocateQuotas(weights, m);
  const items: [pos: number, id: number][] = [];
  const noiseScale = Math.min(Math.abs(jitterFrac), 0.99);

  for (let i = 0; i < weights.length; i++) {
    if (n[i] === 0) continue;
    const gap = m / n[i];
    const phase = Math.random(); // independent per-object random offset
    for (let j = 0; j < n[i]; j++) {
      const jitter = noiseScale > 0 ? (Math.random() * 2 - 1) * gap * 0.5 * noiseScale : 0;
      items.push([gap * (j + phase) + jitter, i]);
    }
  }

  // Sort by position; break ties randomly
  items.sort(([a], [b]) => a - b || Math.random() - 0.5);
  return items.map(([, id]) => id);
}

// ── Incremental Generation ────────────────────────────────────────────────────

/**
 * Regenerate seq[l..r] in-place, anchored to occurrences outside [l, r].
 *
 * For each object i, new positions are uniformly interpolated between:
 *   - left anchor:  last occurrence at index < l  (or extrapolated)
 *   - right anchor: first occurrence at index > r  (or extrapolated)
 * A single bounded random phase shift preserves gap optimality.
 *
 * Precondition: n === allocateQuotas(weights, seq.length), and seq
 * was produced consistently with n (count(seq, i) === n[i] for all i).
 */
export function incrementalGenerate(
  seq: readonly number[],
  l: number,
  r: number,
  n: number[]
): number[] {
  const m = seq.length;
  const k = n.length;

  const lAnc = new Array<number>(k).fill(NaN); // last occurrence in [0, l)
  const rAnc = new Array<number>(k).fill(NaN); // first occurrence in (r, m)
  const outside = new Array<number>(k).fill(0);

  for (let t = 0; t < m; t++) {
    if (t >= l && t <= r) continue;
    const id = seq[t];
    outside[id]++;
    if (t < l) lAnc[id] = t;
    else if (isNaN(rAnc[id])) rAnc[id] = t;
  }

  const items: [pos: number, id: number][] = [];

  for (let i = 0; i < k; i++) {
    const q = n[i] - outside[i]; // slots to fill inside [l, r]
    if (q <= 0) continue;

    const idealGap = m / Math.max(n[i], 1);

    // Extrapolate virtual anchors when real ones are absent
    const la = isNaN(lAnc[i])
      ? (isNaN(rAnc[i]) ? l - idealGap : rAnc[i] - (q + 1) * idealGap)
      : lAnc[i];
    const ra = isNaN(rAnc[i]) ? la + (q + 1) * idealGap : rAnc[i];

    const gap = (ra - la) / (q + 1);
    const shift = (Math.random() * 2 - 1) * 0.45 * gap; // bounded phase

    for (let j = 1; j <= q; j++) {
      // Clamp to [l, r] to guard against extreme anchor extrapolations
      items.push([Math.max(l, Math.min(r, la + j * gap + shift)), i]);
    }
  }

  items.sort(([a], [b]) => a - b || Math.random() - 0.5);

  // sum(q[i]) === r - l + 1 when seq is consistent with n
  const result = Array.from(seq);
  for (let j = 0; j <= r - l; j++) result[l + j] = items[j][1];
  return result;
}

// ── Online: Randomized Deficit Round Robin (R-DRR) ───────────────────────────

/** Mutable accumulator state for streaming R-DRR generation. */
export interface DRRState {
  readonly weights: number[];
  readonly W: number;
  readonly jitter: number;
  acc: number[]; // fractional credit per object
}

/**
 * Initialize R-DRR with random phase offsets to eliminate warm-up bias.
 * Each acc[i] starts at a random value in [0, w_i/W).
 */
export function drrInit(weights: number[], jitter: number = 0): DRRState {
  const W = weights.reduce((s, w) => s + w, 0);
  return {
    weights,
    W,
    jitter: Math.min(Math.max(jitter, 0), 0.99),
    acc: weights.map(w => Math.random() * (w / W)),
  };
}

/** Convenience wrapper: batch-generate a sequence of length m via R-DRR. */
export function drrGenerate(weights: number[], m: number): number[] {
  const state = drrInit(weights);
  return Array.from({ length: m }, () => drrNext(state)!);
}

/**
 * Emit next object id and update state.
 * O(k) per call — for large k, maintain a max-heap over acc for O(log k).
 *
 * If the argmax winner is vetoed, its credit is NOT decremented (it keeps
 * the accumulated balance) and we fall through to the next-best candidate.
 * The vetoed object will almost certainly win the very next slot, so the
 * long-run proportion converges to w_i / W as long as veto probability < 1.
 *
 * @param isVetoed  Return true to reject a candidate and try the next one.
 * @param weightAdjust  Optionally adjust weights on the fly, e.g. to implement time-varying priorities. Return null to use the original weight.
 */
export function drrNext(
  state: DRRState,
  isVetoed?: (id: number) => boolean,
  weightAdjust?: (id: number) => number | null,

): number | null {
  const { acc, weights, W, jitter } = state;

  // Increment all credits
  for (let i = 0; i < weights.length; i++) {
    const adjustedWeight = weightAdjust?.(i) ?? weights[i];
    acc[i] += adjustedWeight / W;
  }

  // Sort candidates by descending credit; walk until a non-vetoed one is found
  const order = acc
    .map((a, i) => [a, i] as [number, number])
    .sort(
      jitter
        ? (([a], [b]) => (b - a) + (Math.random() - 0.5) * jitter)
        : (([a], [b]) => (b - a) || (Math.random() - 0.5))
    );

  for (const [, id] of order) {
    if (!isVetoed || !isVetoed(id)) {
      acc[id] -= 1;
      return id;
    }
  }

  return null; // All candidates vetoed
}

/**
 * Reconstruct DRR accumulator state from an observed sequence.
 *
 * acc[i] = t * (w_i / W) - count(i, seq[0..t))
 *
 * This is the "credit balance": positive means object i is owed future
 * selections; negative means it was over-represented so far. Starting DRR
 * from this state corrects any existing imbalance in the input sequence,
 * regardless of whether the sequence was DRR-generated or externally given.
 *
 * @param seq     Observed sequence of object IDs.
 * @param weights Weights for all k objects.
 * @param upTo    Use only the first `upTo` elements (default: full seq).
 * @param jitter  Jitter to use for subsequent drrNext calls; does not affect state recovery. Default: 0 (no jitter).
 */
export function drrRecover(
  seq: readonly number[],
  weights: number[],
  upTo?: number,
  jitter = 0,
): DRRState {
  const t = upTo ?? seq.length;
  const W = weights.reduce((s, w) => s + w, 0);
  const counts = new Array<number>(weights.length).fill(0);
  for (let i = 0; i < t; i++) counts[seq[i]]++;
  return {
    weights,
    W,
    jitter, // Default jitter value for recovered state
    acc: weights.map((w, i) => (t * w) / W - counts[i]),
  };
}

// ── Online: Virtual Finish Time (VFT / WFQ) ──────────────────────────────────

/** Mutable state for streaming VFT generation. */
export interface VFTState {
  readonly weights: number[];
  readonly W: number;
  readonly jitter: number;
  finish: number[]; // virtual finish time per object
  clock: number;    // global virtual clock
}

/**
 * Initialize VFT with random phase offsets to eliminate warm-up bias.
 * Each finish[i] starts uniformly in [0, 1/w_i), placing objects at
 * random points within their first virtual service interval.
 */
export function vftInit(weights: number[], jitter = 0): VFTState {
  const W = weights.reduce((s, w) => s + w, 0);
  return {
    weights,
    W,
    jitter: Math.min(Math.max(jitter, 0), 0.99),
    finish: weights.map(w => Math.random() / w),
    clock: 0,
  };
}

/** Convenience wrapper: batch-generate a sequence of length m via VFT. */
export function vftGenerate(weights: number[], m: number): number[] {
  const state = vftInit(weights);
  return Array.from({ length: m }, () => vftNext(state)!);
}

/**
 * Emit next object id and update state.
 * O(k) per call — for large k, maintain a min-heap over finish for O(log k).
 *
 * Selects the eligible candidate with the smallest virtual finish time, then
 * advances its finish time by 1/w_i (or 1/w'_i when weightAdjust is given).
 * The virtual clock advances by 1/W_eff each call.
 *
 * Long-run proportion guarantee (WFQ lag bound, Parekh & Gallager 1993):
 *   |count_i(T) - T * w_i / W| = O(k)
 * This holds even with time-varying weights via weightAdjust, provided weight
 * changes are bounded. Unlike DRR, vetoed candidates' finish times are NOT
 * frozen — they continue accumulating at their natural rate, so veto does not
 * cause unbounded debt.
 *
 * @param isVetoed     Return true to skip a candidate.
 * @param weightAdjust Override the effective weight for this step only.
 *                     Return null/undefined to use the original weight.
 *                     The sum of effective weights is used for clock advancement,
 *                     so long-run proportions track the effective weights correctly.
 */
export function vftNext(
  state: VFTState,
  isVetoed?: (id: number) => boolean,
  weightAdjust?: (id: number) => number | null,
): number | null {
  const { weights, W, jitter, finish } = state;

  // Compute effective weights; sum them for clock advancement
  let Weff = 0;
  const effWeights = weights.map((w, i) => {
    const ew = weightAdjust?.(i) ?? w;
    Weff += ew;
    return ew;
  });
  if (Weff === 0) Weff = W; // guard against degenerate zero-weight case

  state.clock += 1 / Weff;
  const V = state.clock;
  const stepSize = 1 / Weff; // scale jitter to one virtual clock tick

  // Sort by finish time ascending; pick the first non-vetoed candidate
  const order = finish
    .map((f, i) => [f, i] as [number, number])
    .sort(
      jitter
        ? ([a], [b]) => (a - b) + (Math.random() - 0.5) * jitter * stepSize
        : ([a], [b]) => (a - b) || (Math.random() - 0.5)
    );

  for (const [, id] of order) {
    if (isVetoed && isVetoed(id)) continue;
    finish[id] = Math.max(V, finish[id]) + 1 / effWeights[id];
    return id;
  }

  return null; // All candidates vetoed
}

/**
 * Reconstruct VFT state from an observed sequence.
 *
 * finish[i] = count_i / w_i   (accumulated virtual service time)
 * clock     = t / W           (virtual clock after t uniform steps)
 *
 * Derivation: under ideal WFQ with constant weights, after t steps the
 * virtual clock is V = t/W. Object i has been selected count_i times, each
 * advancing its finish time by 1/w_i, so the "lag" relative to V is:
 *   finish[i] - V = count_i/w_i - t/W
 * Setting finish[i] = count_i/w_i and clock = t/W recovers this imbalance
 * exactly. Objects with finish[i] > clock are over-represented and will be
 * deferred; those with finish[i] < clock are under-represented and prioritized.
 *
 * @param seq     Observed sequence of object IDs.
 * @param weights Weights for all k objects.
 * @param upTo    Use only the first `upTo` elements (default: full seq).
 * @param jitter  Jitter for subsequent vftNext calls; does not affect recovery.
 */
export function vftRecover(
  seq: readonly number[],
  weights: number[],
  upTo?: number,
  jitter = 0,
): VFTState {
  const t = upTo ?? seq.length;
  const W = weights.reduce((s, w) => s + w, 0);
  const counts = new Array<number>(weights.length).fill(0);
  for (let i = 0; i < t; i++) counts[seq[i]]++;
  return {
    weights,
    W,
    jitter,
    finish: weights.map((w, i) => counts[i] / w),
    clock: t / W,
  };
}

// ── Usage Example ─────────────────────────────────────────────────────────────
/*
const weights = [3, 1, 2];   // 3 objects with weights 3, 1, 2
const m = 12;

// Full generation (pure / with jitter)
const seq = fullGenerate(weights, m);
const seqJittered = fullGenerate(weights, m, 0.4);

// Incremental: erase positions [3, 7] and regenerate
const n = allocateQuotas(weights, m);
const updated = incrementalGenerate(seq, 3, 7, n);

// Online streaming (DRR)
const state = drrInit(weights);
for (let t = 0; t < m; t++) console.log(drrNext(state));

// Online streaming (VFT — with time-varying weights via weightAdjust)
const vState = vftInit(weights);
for (let t = 0; t < m; t++) console.log(vftNext(vState));
*/
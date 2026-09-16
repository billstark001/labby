# Keyword similarity and ranking

## Representation

Each keyword stores `embedding`, `geometry`, display coordinates `x/y`, and `updatedAt`.
The default is **16 active dimensions: H8 × R8**, selected using the reproducible
[dimension experiment](dimension-benchmark.md). Experiments include explicit 4/8/16 dimensional configurations.
Dimensions are not padded to 64. All keywords in a dataset must use the same geometry.

The first H coordinates are spatial coordinates of a Lorentz hyperboloid of curvature -1;
the time coordinate is derived as sqrt(1 + ||h||²). The remaining coordinates are Euclidean.
Squared distance is (d_H² + d_E²)/2. Similarity is 1/(1+d). Training, graph edges, and scheduling
all use this same product distance. Display x/y are the first two Poincaré coordinates;
the 2D overview is not a faithful depiction of every high-dimensional distance.

## Supervision

`RankingJudgment` contains an idempotency ID, anchorId, ordered near-to-far groups,
confidence in (0,1], and createdAt. Items in the same group are tied. Omitted candidates are unknown.
A judgment includes 2–12 distinct candidates excluding the anchor.

All within-list comparisons are optimized jointly; they are normalized by list size so a
long list is not counted as many independent answers. Fresh strict comparisons use a
smooth logistic ordinal loss; ties use squared distance-gap error. Historical comparisons
use a margin penalty and a hard acceptance check. Confidence weights the loss, but accepted
judgments of every confidence are protected: low confidence is not permission to silently reverse them.

Historical strict orders that are currently satisfied may not flip; currently satisfied
ties must stay within a squared-distance-gap tolerance of 0.04. Direct and transitive cycles
over symmetric pair distances, including cycles spanning different anchors, are rejected.
Optimization uses analytic derivatives, Riemannian exponential steps, step limits, and backtracking.
Only the current judgment's nodes move. Distances between untouched nodes are exactly invariant;
touched-to-untouched distance changes are softly penalized and their maximum drift is reported.
It is **not** a guarantee that all external distances remain unchanged.

If the new judgment cannot fit while protecting history, the update is rejected atomically.
No new judgment or coordinate updates are saved. Repeating the same ID and semantic payload
is idempotent, including JSONB object-key reordering and tie-group item ordering.
The model retains complete accepted history, not only an in-memory replay cache.

## Active selection

Lists default to five candidates. The selector balances anchor coverage, unknown comparisons,
distance-gap entropy, and disagreement between the hyperbolic and Euclidean components.
It considers near and globally stratified candidates and greedily chooses informative additions.
Known pairwise comparisons are penalized. Recent query keys exclude skipped lists.
Candidate display order is lexical, not the model's predicted similarity order.

This is a bounded heuristic, not a calibrated Bayesian information-gain calculation.
The benchmark shows better accepted-answer counts and coverage, but does not establish a
consistent held-out-accuracy advantage over random selection at the same dimensionality.
Reported held-out accuracy excludes all asked comparisons, including rejected judgments.

## Persistence and API

- POST /api/v1/nlp/recommend-ranking — {size?, excludedKeys?} → {query}
- POST /api/v1/nlp/train-ranking — RankingJudgment → TrainingResult
- GET /api/v1/nlp/history — accepted judgments
- DELETE /api/v1/nlp/history/:id — explicitly forget a mistaken judgment, retaining current coordinates

The NLP API is admin-only. Obsolete triplet/pair endpoints and 64D runtime types are removed.
The browser uses the same core engine, with a local transaction for vectors and history.
Server training is serialized, with a PostgreSQL advisory lock across application instances;
each accepted result commits vectors and history together. The engine is reloaded from storage
before an operation, so restarts and database restores do not reuse stale cached coordinates.
The browser uses Web Locks to coordinate training across tabs when available.

See [database migrations](database-migrations.md) for schema conversion and recovery.

## Validation

- Analytic distance/gradient checks, geometry invariants, joint lists/ties, cycle rejection.
- Historical order preservation, idempotency, failed-update atomicity, 1000-node operations.
- API authorization, persistence and restart, old endpoints absent.
- Memory-only PGlite migrations: fresh, legacy conversion/archive, rollback, future-version refusal.
- Multi-seed synthetic graph benchmarks, separate held-out comparisons, active/random comparison.


## Implementation boundaries and cost

The embedding implementation consists of five files in packages/core/src/embedding:
- engine.ts owns validated state and accepted history.
- geometry.ts implements product distances, gradients, stepping and display projection.
- judgments.ts expands ranked groups and detects contradictions between symmetric distance variables.
- optimizer.ts evaluates the objective and searches for a history-preserving update.
- selection.ts chooses active lists and builds nearest-neighbor graph edges.

Historical comparisons are expanded once per engine instance and appended after acceptance.
Objective evaluation caches repeated pair distances and derivatives within one coordinate state.
Loss-only backtracking allocates no gradient arrays. Fixed-node historical terms remain a constant
in reported loss. Selection uses a symmetric distance matrix and caches candidate-pair gains.
The matrix costs O(n²) memory (approximately 8 MB of numeric storage for 1000 nodes).

A local synthetic before/after check (Node 26, H8 × R8, fixed seed 71; median of five runs
after one warmup) gave:

| Keywords | Selection before | Selection after | Training before | Training after |
| --- | --- | --- | --- | --- |
| 100 | 43.9 ms | 16.6 ms | 2.23 ms | 1.44 ms |
| 1000 | 696.4 ms | 345.4 ms | 11.12 ms | 11.23 ms |

Both sizes selected the same query and accepted the test ranking; cached pair distances
matched scalar distances exactly. These are microbenchmarks of one synthetic input per size,
not end-to-end browser latency or a claim of universal training speedup.

## Keyword graph loading

The graph uses GraphStore.list and GET /api/v1/db/graph with cursor/since/limit parameters.
The old full-snapshot endpoint is removed. The UI requests 100 records per page and publishes
each page before requesting the next. Initial records use keyword ID keyset order (C collation).
KeywordList separately retains offset pagination at 20 items per page.

A returned nextCursor continues the current batch; checkpoint appears only on its last page.
Pass that checkpoint as since to read changes. Initial loading captures a revision watermark,
then immediately replays changes since that watermark to catch edits during the scan.
Subsequent polls run every two seconds while the page is mounted. Local keyword edits and
accepted ranking updates request an immediate incremental sync.

Database triggers maintain one latest change per keyword, retaining deletions as tombstones.
Updating the shared clock row serializes graph writers until transaction commit; rollback
publishes nothing. Each delta batch has a fixed upper revision. Updates beyond it are deferred
to the next batch. The epoch identifies the database, so a replaced database requests a reset.
Revisions are decimal strings rather than lossy JavaScript numbers.

The frontend merges records by ID and removes tombstones. Failed batches retain their old
checkpoint and are safely replayed. Incomplete initial loads restart from an empty model.
Unmounting stops polling and ignores in-flight results. New/changed coordinates update only
affected nearest-neighbor lists; unchanged polls keep existing graph arrays.

Positions still use the first two Poincaré coordinates with visual spreading and jitter;
missing embeddings use the fallback circle. Edges are the union of four nearest neighbors
under full product-space distance. This is a projected embedding, not a force-directed layout.
All loaded nodes and labels remain in deck.gl: streaming reduces transfer and initial wait,
but is not viewport virtualization. The training engine still supports at most 1000 keywords.
The change table keeps tombstones for correctness; no automatic retention cleanup is performed.

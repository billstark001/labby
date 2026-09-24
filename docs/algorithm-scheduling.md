# Scheduling algorithm

Labby uses simulated annealing, not a genetic algorithm. The implementation is in `packages/core/src/schedule/`; the reproducible synthetic benchmark is `pnpm --filter @labby/core benchmark:scheduling`. The [project audit](audits/2026-09-24-project-audit.md) records the original production and product findings.

## Inputs and rules

Full scheduling builds the configured calendar dates. Incremental scheduling preserves sessions before `changeDate` and rebuilds the rest; questioner-only mode preserves presenters too. Active people, unavailability, similarity, prior sessions, and optional constraints guide the solve.

Hard rules are checked on candidates and on the final result: a presenter cannot question themselves, a presentation cannot repeat a questioner, a session cannot repeat a presenter, assignments must use active and available people, `no-overlap` pairs cannot question each other, and a same-session reciprocal pair is forbidden when the config says `forbid`. If too few valid people exist, construction can leave a slot unfilled. An infeasible fixed assignment throws an error rather than being returned as a valid plan. The same validator runs when a plan is saved in server and browser storage.

Each constraint resolves its person IDs and tag IDs to the union of **currently active** members at solve time. Duplicate membership is counted once. A tag rename keeps its identity; a membership change affects subsequent solves. History stores assignments rather than a tag-membership snapshot, so metrics recalculated later use the then-current membership and constraints. An empty resolved group has no effect. A referenced tag cannot be deleted until its constraint is changed or deleted. Existing person-only constraints are migrated to canonical `tagIds: []` in schema version 6. Pair constraints can use one group internally or two groups across which only crossing pairs are affected, including overlap between groups. `frequency-multiplier` can target presenter, questioner, or both roles. Its `baseline × multiplier` sets a relative desired load and `weight` controls its squared deviation cost. An `affinity-boost` above 1 rewards matching pairs; below 1 discourages them. `no-overlap` is always hard and has no weight.

`reciprocalPairPreference` is `forbid`, `discourage`, `neutral`, or `encourage`. A reciprocal pair means that in one session A presents with B questioning and B presents with A questioning. `forbid` is a hard rule; the other values add a positive, zero, or negative cost respectively. It does not override availability, self-questioning, or other hard rules.

## Construction and search

The initial presenter assignment uses deficit round robin with prior presenter history and frequency weights. The initial questioner assignment uses virtual finish time, similarity, affinity weights, and hard candidate vetoes. The objective then evaluates:

- Each person's actual calendar-day presenter and questioner gaps, with half a nominal session interval of padding at the plan boundaries; count/load imbalance is scored separately.
- Repeated directed presenter/questioner pairs and same-session reciprocal pairs.
- Similarity distance from the configured radius, presenter/questioner/total role load, affinity and frequency preferences, and invalid-assignment penalties.

The search uses swaps, replacements, questioner and session rebuilds, frequency repair, short-gap repair, and reciprocal-pair repair. It runs two independent starts, up to 1,200 annealing steps per start, and samples up to four times when a neighbor is invalid or unchanged. Better moves are accepted; a worse move with cost increase `Δ` is accepted with probability `exp(-Δ/T)` as temperature cools. Search stops after the configured patience or iteration limit and returns the lowest-cost valid plan found. Incremental search also penalizes unnecessary presenter changes using Hamming distance.

`SolverDiagnostics` records initial and final objective, attempted iterations, accepted/invalid/unchanged neighbors, elapsed search milliseconds, and starts. The metrics dialog shows these alongside `ScheduleQualityReport`: each person's presentation count, target gap from weighted share, min/max actual gap, coefficient of variation, rate of gaps shorter than 75% of target, and first/last wait. For a person with zero or one presentation, internal gap statistics are `null`; first/last wait is shown when one exists. The report also counts reciprocal pairs and hard-rule violations. A lower aggregate objective is not by itself proof of acceptable business quality.

## Fixed-seed synthetic benchmark

The benchmark uses seeds 1 and 2 for 12-person/13-week, 18-person/26-week with leave, and 24-person/40-week with leave and tag constraints. Each date has two presenters and two questioners per presentation. It compares the constructed initial plan with the final plan under the same seed. Results from 2026-09-24 on a local Mac:

| Scenario / seed | Min presenter gap (days) | Gaps < 14 days | Reciprocal pairs | Objective | Search time |
| --- | --- | --- | --- | --- | --- |
| Small / 1 | 14 → 21 | 0 → 0 | 0 → 0 | 749 → 614 | 184 ms |
| Small / 2 | 7 → 21 | 2 → 0 | 0 → 0 | 689 → 601 | 172 ms |
| Leave / 1 | 14 → 28 | 0 → 0 | 2 → 0 | 1156 → 1048 | 307 ms |
| Leave / 2 | 21 → 21 | 0 → 0 | 1 → 0 | 1409 → 1098 | 297 ms |
| Tags / 1 | 35 → 35 | 0 → 0 | 1 → 0 | 2039 → 1425 | 494 ms |
| Tags / 2 | 21 → 42 | 0 → 0 | 0 → 0 | 1886 → 1380 | 470 ms |

All six final plans had zero hard-rule violations. A separate incremental seed 4 kept the frozen prefix byte-for-byte, reached a 35-day minimum presenter gap and zero reciprocal pairs, and took 267 ms. These are synthetic workloads and elapsed times vary by host; they do not establish production latency or a universal minimum gap. An infeasible hard-rule combination can still fail, and sparse schedules can have undefined gap statistics. Review per-person quality before publishing a plan.

## History and manual editing

The recommended incremental change date is today plus seven days. The boundary date belongs to the mutable suffix. The UI warns, but does not block, when the selected date is earlier. Manual editing creates a new history snapshot; previous snapshots remain. Temporary session insertion and deletion are date-driven, with in-place or suffix-shift strategies. The final assignment is validated before saving, and validation errors are shown to the editor.

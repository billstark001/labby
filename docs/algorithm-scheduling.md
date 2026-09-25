# Scheduling algorithm

Labby uses simulated annealing, not a genetic algorithm. The implementation is in `packages/core/src/schedule/`; the reproducible synthetic benchmark is `pnpm --filter @labby/core benchmark:scheduling`.

`annealing.ts` constructs schedules and coordinates full and incremental solves. `annealing-strategies.ts` owns the weighted move registry and the shared annealing loop; `targeted-strategies.ts` owns frequency, presenter-gap, reciprocal, and post-search questioner repair moves. Strategy functions receive their random source and return a new schedule without modifying the input. `strategy-utils.ts` contains shared cloning, count, and distance helpers. The post-search repair is an optional final strategy rather than a separate solver implementation.

## Inputs and rules

Full scheduling builds the configured calendar dates. Incremental scheduling preserves sessions before `changeDate` and rebuilds the rest; questioner-only mode preserves presenters too. Active people, unavailability, similarity, prior sessions, and optional constraints guide the solve.

An unavailable interval includes **both** its start and end dates. It may select people, tags, or `allPeople`. `allPeople` is a persisted boolean selector, evaluated against the active roster at solve time, so people added later are covered without rewriting the record. Selecting everyone excludes person and tag selectors. Tag membership is also resolved at solve time. Whole-group closure dates are removed from the generated calendar before assignment; if every date is closed, full scheduling returns an empty plan with finite zero diagnostics. The availability lookup only expands dates in the current solve, so a long stored interval does not allocate every calendar day.

Hard rules are checked on candidates and on the final result: a presenter cannot question themselves, a presentation cannot repeat a questioner, a session cannot repeat a presenter, assignments must use active and available people, `no-overlap` pairs cannot question each other, and a same-session reciprocal pair is forbidden when the config says `forbid`. If too few valid people exist, construction can leave a slot unfilled. An infeasible fixed assignment throws an error rather than being returned as a valid plan. The same validator runs when a plan is saved in server and browser storage.

Each constraint resolves its person IDs and tag IDs to the union of **currently active** members at solve time. Duplicate membership is counted once. A tag rename keeps its identity; a membership change affects subsequent solves. History stores assignments rather than a tag-membership snapshot, so metrics recalculated later use the then-current membership and constraints. An empty resolved group has no effect. A referenced tag cannot be deleted until its constraint is changed or deleted. Existing person-only constraints are migrated to canonical `tagIds: []` in schema version 6. Pair constraints can use one group internally or two groups across which only crossing pairs are affected, including overlap between groups. `frequency-multiplier` can target presenter, questioner, or both roles. Its `baseline × multiplier` sets a relative desired load and `weight` controls its squared deviation cost. An `affinity-boost` above 1 rewards matching pairs; below 1 discourages them. `no-overlap` is always hard and has no weight.

Constraints can be disabled without deleting them. Disabled constraints remain visible and editable but contribute no hard veto, frequency target, or soft penalty.

`reciprocalPairPreference` is `forbid`, `discourage`, `neutral`, or `encourage`. A reciprocal pair means that in one session A presents with B questioning and B presents with A questioning. `forbid` is a hard rule; the other values add a positive, zero, or negative cost respectively. It does not override availability, self-questioning, or other hard rules.

## Construction and search

The initial presenter assignment uses deficit round robin with prior presenter history and frequency weights. The initial questioner assignment uses virtual finish time, similarity, affinity weights, and hard candidate vetoes. The objective then evaluates:

- Each person's actual calendar-day presenter and questioner gaps, with half a nominal session interval of padding at the plan boundaries. Consecutive gaps below a configurable fraction of that person's own target receive an extra squared penalty; variation among consecutive gaps receives a separate penalty. Count/load imbalance is scored separately.
- Repeated directed presenter/questioner pairs and same-session reciprocal pairs.
- Similarity distance from the configured radius, presenter/questioner/total role load, affinity and frequency preferences, and invalid-assignment penalties.

The search uses swaps, replacements, questioner and session rebuilds, frequency repair, short-gap repair, and reciprocal-pair repair. Short-gap repair swaps the clustered presenter with a presenter in another mutable session, choosing a locally improving exchange that keeps both people's presentation counts fixed; questioners for the exchanged presentations are rebuilt and the complete candidate is validated. It runs two independent starts, up to 1,000 annealing steps per start, and samples up to four times when a neighbor is invalid or unchanged. Better moves are accepted; a worse move with cost increase `Δ` is accepted with probability `exp(-Δ/T)` as temperature cools. Search stops after the configured patience or iteration limit and returns the lowest-cost valid plan found. Incremental search also penalizes unnecessary presenter changes using Hamming distance.

`SolverDiagnostics` records initial and final objective, attempted iterations, accepted/invalid/unchanged neighbors, elapsed search milliseconds, and starts. The metrics dialog shows these alongside `ScheduleQualityReport`: each person's presentation count, target gap derived from their assigned count and the calendar span, min/max actual gap, coefficient of variation, rate of gaps shorter than the configured presenter threshold, and first/last wait. Frequency weights affect the assigned count; the gap score then evaluates how evenly those appearances are placed. For a person with zero or one presentation, internal gap statistics are `null`; first/last wait is shown when one exists. The report also counts reciprocal pairs and hard-rule violations. A lower aggregate objective is not by itself proof of acceptable business quality.

## Gap balance policy

Real schedules can give one person a 14-day gap and a 63-day gap while maintaining an acceptable presentation count. A reduced presentation frequency (for example 0.6) can legitimately produce longer gaps. Each person's target is the padded calendar span divided by their number of appearances plus one, so a low frequency changes the expected spacing through its lower assignment count. The solver does not impose a global hard minimum.

Each schedule configuration can tune the presenter and questioner policies independently in **Gap balance tuning**. `shortGapRatio` is a fraction from 0 to 1, `shortGapWeight` is 0–100, and `spreadWeight` is 0–50. Defaults are presenter `(0.80, 20, 4)` and questioner `(0.75, 16, 2)`. Zero disables the corresponding extra penalty. Missing settings in existing configurations use these defaults; no database schema change is required because configurations are JSON payloads. The solver bounds non-finite or out-of-range inputs. Boundary waits retain their ordinary squared deviation but do not count as actual consecutive gaps for the threshold or spread penalties. This policy is soft: it cannot guarantee a minimum gap when availability or other hard rules make one infeasible.

## Questioner tuning and objective weights

The schedule preference editor exposes three independent kinds of tuning. **Initial questioner selection** can prefer less-used directed questioner–presenter pairs and lower normalized question counts, with a 0–100% chance per slot. It applies to full solves, full incremental solves, and the initial rebuild in questioners-only incremental mode; the latter includes the frozen prefix when counting prior pairings and questions. **Targeted questioner repair** tries valid replacements and swaps after annealing. It has an attempt limit and extra weights for pair repetition and count imbalance. Both are off by default, preserving the previous search behavior unless a schedule opts in. Repair keeps presenter assignments and all hard rules; it can take substantially longer on large schedules. Both controls can be enabled in the same schedule: each search start first constructs an initial assignment, then anneals, then repairs its questioners before the solver chooses the best result.

**Objective weights** exposes all ten fields of `COST_WEIGHTS`. That frozen object remains the current model's default and is read directly by the editor. Each row can reset its value to the default; the reset button is disabled when the value already matches. A schedule stores only values that differ from those defaults in its JSON configuration; missing fields resolve to the latest defaults. The questioner pair, question count, and question gap terms are distinct, so they can be traded off independently. Setting a hard-rule weight to zero does not permit hard-rule violations: the assignment validator still rejects them. No database migration is needed because configurations are already stored as JSON payloads.

To compare the controls, run `pnpm --filter @labby/core benchmark:questioner-tuning`. It uses two synthetic 14-person, 31-week scenarios, three fixed seeds per variant, two presenters and two questioners per presentation. The second scenario includes three one-day absences and two people at 0.6 presenter frequency. Every variant begins with the same seed, and metrics are recalculated with the default weights for comparison. The tested settings were assignment chances 85%/85%; repair 30 attempts with extra pair/count weights 8/8; and objective weights pair/count/gap 10/24/4. The combined variant enables assignment and repair on the same configuration. Mean results from 2026-09-25:

| Scenario | Variant | Repeated pair excess | Question count range | Question count penalty | Question gap penalty |
| --- | --- | ---: | ---: | ---: | ---: |
| Plain | Default | 24.0 | 5.0 | 3.86 | 50.34 |
| Plain | Initial selection | 16.0 | 2.67 | 1.62 | 34.00 |
| Plain | Targeted repair | 5.33 | 2.67 | 1.45 | 40.23 |
| Plain | Both enabled | 6.0 | 2.33 | 1.14 | 33.24 |
| Plain | Objective weights | 11.67 | 2.67 | 1.71 | 79.03 |
| Frequency and leave | Default | 24.67 | 3.33 | 2.61 | 46.13 |
| Frequency and leave | Initial selection | 12.0 | 3.33 | 2.04 | 32.59 |
| Frequency and leave | Targeted repair | 9.33 | 2.33 | 0.95 | 42.10 |
| Frequency and leave | Both enabled | 2.0 | 2.33 | 1.04 | 36.54 |
| Frequency and leave | Objective weights | 9.33 | 2.67 | 1.54 | 89.83 |

All 30 plans in the main comparison had zero hard-rule violations. The plain combined variant did produce reciprocal pairs in two of three seeds (mean raw reciprocal penalty 6.67) even though the default and assignment-only variants produced none: `discourage` is a soft preference, and repair's extra repeated-pair emphasis can trade against it. Use `forbid` if a reciprocal pair must never appear. The objective-weight variant deliberately reduced the question-gap weight, exposing the tradeoff with pair and count quality. A separate sensitivity run changed only `questionerPair` from 1 to 2 or 4: repeated-pair excess fell only from 24.0 to 23.67 or 21.0 in the plain scenario and from 24.67 to 23.0 or 22.33 with frequency/leave. Question-count range sometimes worsened. Changing only `reciprocal` from 1 to 2 was inconclusive because the baseline solutions already had zero reciprocal pairs. Under `discourage`, each reciprocal pair contributes a raw penalty of 10 before the weight; under `neutral`, the term is zero regardless of weight. The repeated-pair term grows exponentially with each additional reuse, so its raw contribution (about 47–50 in these baseline scenarios) is meaningful even at weight 1. These three-seed synthetic results do not establish a best production setting or reliable latency prediction. The measured wall times varied widely between runs on the same machine, although repair evaluates many more candidates by construction. Use the per-person metrics and a broader workload before changing the defaults.

## Localized collection ordering

The person and keyword tables sort multilingual names using the selected UI language, falling back to English when that translation is empty. Sorting a person by their keyword or tag collection currently sorts the localized member names, joins them to form a stable key, and breaks ties by person ID. The displayed order inside each person's collection still follows its stored IDs. If that display order is changed later, it should use the same localized comparator and stable ID tie break without rewriting the stored relationship order. This preserves a deterministic result when translations are added or changed.

## Fixed-seed synthetic benchmark

The benchmark uses seeds 1 and 2 for 12-person/13-week, 18-person/26-week with leave, and 24-person/40-week with leave and tag constraints; a 14-person/31-week scenario with leave and two people at 0.6 presenter frequency uses seeds 1–5. Each date has two presenters and two questioners per presentation. Old and new solver revisions were run from isolated local checkouts with the same script and seeds on 2026-09-24. It counts consecutive presenter gaps below 80% and questioner gaps below 75% of each person's target, and reports the largest presenter `(max gap − min gap) / target` across people:

| Scenario / seeds | Short presenter gaps | Short questioner gaps | Worst presenter spread | New search time |
| --- | --- | --- | --- | --- |
| Small / 1–2 | 0 → 0 | 1 → 1 | 0.92 → 0.62 | 129–141 ms |
| Leave / 1–2 | 10 → 3 | 14 → 20 | 1.35 → 0.77 | 276–282 ms |
| Tags / 1–2 | 11 → 0 | 39 → 45 | 1.50 → 1.13 | 456–509 ms |
| 14 people, 0.6 frequency / 1–5 | 39 → 24 | 115 → 98 | 1.94 → 1.16 | 307–325 ms |

All eleven full plans had zero hard-rule violations. Across all twelve samples, short presenter gaps fell from 61 to 31 and short questioner gaps from 179 to 172. A separate incremental seed 4 kept the frozen prefix byte-for-byte but increased short presenter gaps from 1 to 4; its short questioner gaps fell from 10 to 8 and the new search took 258 ms. The changes improve the aggregate distribution, not every scenario or seed. These synthetic workloads do not establish production latency or a universal minimum gap. An infeasible hard-rule combination can still fail, and sparse schedules can have undefined gap statistics. Review per-person quality before publishing a plan.

## History and manual editing

The recommended incremental change date is today plus seven days. The boundary date belongs to the mutable suffix. The UI warns, but does not block, when the selected date is earlier. Manual editing creates a new history snapshot; previous snapshots remain. Inserting a session before or after another date suggests a nearby date within the configured period; the editor can change it and keeps the chosen presentation count. Moving a session to another date preserves its presentations. Postponing a session advances it and every later session to the next originally configured meeting date, extending the last one to the next configured weekday. Exchanging adjacent sessions swaps their presentations while preserving the date slots. Whole-group closure dates cannot receive inserted sessions, and the final assignment is validated before saving.

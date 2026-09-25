import { constraintSelectorIds, SYSTEM_SETTINGS_ID } from '@labby/core';
import type {
  EmailTask, Keyword, KeywordVector, Person, PersonTag, PersonUnavailability,
  RankingJudgment, ScheduleConfig, ScheduleConstraint, SchedulePlan, SystemSettings,
} from '@labby/core';

export type BusinessKind =
  | 'person' | 'person-tag' | 'keyword' | 'keyword-vector' | 'ranking-judgment'
  | 'config' | 'constraint' | 'schedule' | 'unavailability' | 'email-task'
  | 'system-settings';

export interface RecordQueryClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const tables = {
  person: ['persons', 'id'],
  'person-tag': ['person_tags', 'id'],
  keyword: ['keywords', 'id'],
  'keyword-vector': ['keyword_vectors', 'keyword_id'],
  'ranking-judgment': ['ranking_judgments', 'id'],
  config: ['configs', 'id'],
  constraint: ['constraints', 'id'],
  schedule: ['schedules', 'id'],
  unavailability: ['unavailabilities', 'id'],
  'email-task': ['email_tasks', 'id'],
  'system-settings': ['system_settings', 'id'],
} as const satisfies Record<BusinessKind, readonly [string, string]>;

export function businessTable(kind: BusinessKind): readonly [string, string] {
  return tables[kind];
}

export async function readBusinessRecord<T>(client: RecordQueryClient, kind: BusinessKind, id: string): Promise<T | undefined> {
  const [table, key] = businessTable(kind);
  return (await client.query<{ payload: T }>(`SELECT payload FROM ${table} WHERE ${key}=$1`, [id])).rows[0]?.payload;
}

export async function readAllBusinessRecords<T>(client: RecordQueryClient, kind: BusinessKind): Promise<T[]> {
  const [table] = businessTable(kind);
  return (await client.query<{ payload: T }>(`SELECT payload FROM ${table}`)).rows.map(row => row.payload);
}

export async function deleteBusinessRecord(client: RecordQueryClient, kind: BusinessKind, id: string): Promise<void> {
  const [table, key] = businessTable(kind);
  await client.query(`DELETE FROM ${table} WHERE ${key}=$1`, [id]);
}

export async function clearBusinessRecords(client: RecordQueryClient, kind: BusinessKind): Promise<void> {
  const [table] = businessTable(kind);
  await client.query(`DELETE FROM ${table}`);
}

const jsonbColumns = new Set(['payload', 'keyword_ids', 'person_ids', 'tag_ids', 'embedding', 'geometry']);
function timestamp(value: number | undefined): Date {
  return new Date(Number.isFinite(value) ? value! : Date.now());
}
function json(value: unknown): string { return JSON.stringify(value); }
function unique(values: readonly string[]): string[] { return [...new Set(values.filter(Boolean))]; }

async function upsert(
  client: RecordQueryClient,
  table: string,
  key: string,
  fields: Record<string, unknown>,
  insertOnlyColumns: readonly string[] = [],
): Promise<void> {
  const columns = Object.keys(fields);
  const values = Object.values(fields);
  const placeholders = columns.map((column, index) => `$${index + 1}${jsonbColumns.has(column) ? '::jsonb' : ''}`);
  const updates = columns.filter(column => column !== key && !insertOnlyColumns.includes(column))
    .map(column => `${column}=excluded.${column}`);
  await client.query(
    `INSERT INTO ${table}(${columns.join(',')}) VALUES(${placeholders.join(',')}) ` +
      `ON CONFLICT(${key}) DO UPDATE SET ${updates.join(',')}`,
    values,
  );
}

function modifiedAt(value: { modifiedAt?: number }): Date { return timestamp(value.modifiedAt); }

export function upsertPerson(client: RecordQueryClient, person: Person): Promise<void> {
  return upsert(client, 'persons', 'id', {
    id: person.id, updated_at: modifiedAt(person), keyword_ids: json(person.keywordIds ?? []), payload: json(person),
  });
}

export function upsertPersonTag(client: RecordQueryClient, tag: PersonTag): Promise<void> {
  return upsert(client, 'person_tags', 'id', {
    id: tag.id, updated_at: modifiedAt(tag), payload: json(tag),
  });
}

export function upsertKeyword(client: RecordQueryClient, keyword: Keyword): Promise<void> {
  return upsert(client, 'keywords', 'id', {
    id: keyword.id, updated_at: modifiedAt(keyword), payload: json(keyword),
  });
}

export function upsertKeywordVector(client: RecordQueryClient, vector: KeywordVector): Promise<void> {
  const embedding = Array.from(vector.embedding);
  return upsert(client, 'keyword_vectors', 'keyword_id', {
    keyword_id: vector.keywordId, x: vector.x, y: vector.y, embedding: json(embedding),
    geometry: json(vector.geometry), updated_at: timestamp(vector.updatedAt),
    payload: json({ ...vector, embedding }),
  });
}

export function upsertRankingJudgment(client: RecordQueryClient, judgment: RankingJudgment): Promise<void> {
  return upsert(client, 'ranking_judgments', 'id', { id: judgment.id, payload: json(judgment) });
}

export function upsertConfig(client: RecordQueryClient, config: ScheduleConfig): Promise<void> {
  return upsert(client, 'configs', 'id', {
    id: config.id, updated_at: modifiedAt(config), payload: json(config),
  });
}

export function upsertConstraint(client: RecordQueryClient, constraint: ScheduleConstraint): Promise<void> {
  const selectors = constraintSelectorIds(constraint);
  const updatedAt = modifiedAt(constraint);
  return upsert(client, 'constraints', 'id', {
    id: constraint.id, config_id: constraint.configId || null, type: constraint.type,
    person_ids: json(unique(selectors.personIds)), tag_ids: json(unique(selectors.tagIds)),
    payload: json(constraint), created_at: updatedAt, updated_at: updatedAt,
  }, ['created_at']);
}

export function upsertSchedule(client: RecordQueryClient, schedule: SchedulePlan): Promise<void> {
  const personIds = unique(schedule.sessions.flatMap(session => session.presentations.flatMap(presentation =>
    [presentation.presenterId, ...presentation.questionerIds])));
  return upsert(client, 'schedules', 'id', {
    id: schedule.id, config_id: schedule.configId, created_at: timestamp(schedule.createdAt),
    updated_at: modifiedAt(schedule), person_ids: json(personIds), payload: json(schedule),
  });
}

export function upsertUnavailability(client: RecordQueryClient, item: PersonUnavailability): Promise<void> {
  return upsert(client, 'unavailabilities', 'id', {
    id: item.id, person_ids: json(item.personIds ?? []), tag_ids: json(item.tagIds ?? []),
    all_people: item.allPeople === true, config_id: item.configId, start_date: item.startDate,
    end_date: item.endDate, payload: json(item),
  });
}

export function upsertEmailTask(client: RecordQueryClient, task: EmailTask): Promise<void> {
  return upsert(client, 'email_tasks', 'id', {
    id: task.id, config_id: task.configId, updated_at: modifiedAt(task), payload: json(task),
  });
}

export function upsertSystemSettings(client: RecordQueryClient, settings: SystemSettings): Promise<void> {
  const payload = { ...settings, id: SYSTEM_SETTINGS_ID };
  return upsert(client, 'system_settings', 'id', {
    id: SYSTEM_SETTINGS_ID, updated_at: modifiedAt(settings), payload: json(payload),
  });
}

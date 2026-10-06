/**
 * Parsing of the REST describe (`GET /sobjects/{o}/describe`) into the client's
 * `SObjectDescribe`. Every key is copied only when it has the expected type: a
 * missing or odd value is left out (`undefined`), never coerced, so a caller
 * that needs a write flag treats "unknown" as "no".
 */

export interface PicklistValue {
  value: string;
  label: string;
  active: boolean;
}

export interface SObjectField {
  name: string;
  type: string;
  label: string;
  length?: number;
  updateable?: boolean;
  createable?: boolean;
  calculated?: boolean;
  nillable?: boolean;
  restrictedPicklist?: boolean;
  picklistValues?: PicklistValue[];
}

export interface RecordTypeInfo {
  recordTypeId: string;
  name: string;
  developerName: string;
  available: boolean;
  defaultRecordTypeMapping: boolean;
}

export interface SObjectDescribe {
  name: string;
  fields: SObjectField[];
  /** Object level: the connected user may create / update records of this object. */
  createable?: boolean;
  updateable?: boolean;
  /** Which record types the connected user has, and which one is their default. */
  recordTypeInfos?: RecordTypeInfo[];
}

const FIELD_FLAGS = ['updateable', 'createable', 'calculated', 'nillable', 'restrictedPicklist'] as const;

/** `{ [key]: v }` when `v` is a boolean, else `{}`: spread into a result. */
function bool<K extends string>(key: K, v: unknown): Partial<Record<K, boolean>> {
  return typeof v === 'boolean' ? ({ [key]: v } as Record<K, boolean>) : {};
}

function toPicklistValue(raw: unknown): PicklistValue[] {
  const p = (raw ?? {}) as { value?: unknown; label?: unknown; active?: unknown };
  if (typeof p.value !== 'string') return [];
  return [{ value: p.value, label: typeof p.label === 'string' ? p.label : p.value, active: p.active === true }];
}

export function toField(raw: unknown): SObjectField[] {
  const f = (raw ?? {}) as Record<string, unknown>;
  if (typeof f.name !== 'string' || typeof f.type !== 'string') return [];
  const flags: Partial<Record<(typeof FIELD_FLAGS)[number], boolean>> = {};
  for (const key of FIELD_FLAGS) Object.assign(flags, bool(key, f[key]));
  return [
    {
      name: f.name,
      type: f.type,
      label: typeof f.label === 'string' ? f.label : f.name,
      ...(typeof f.length === 'number' ? { length: f.length } : {}),
      ...flags,
      ...(Array.isArray(f.picklistValues) ? { picklistValues: f.picklistValues.flatMap(toPicklistValue) } : {}),
    },
  ];
}

function toRecordTypeInfo(raw: unknown): RecordTypeInfo[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.recordTypeId !== 'string' || typeof r.name !== 'string' || typeof r.developerName !== 'string') return [];
  return [
    {
      recordTypeId: r.recordTypeId,
      name: r.name,
      developerName: r.developerName,
      available: r.available === true,
      defaultRecordTypeMapping: r.defaultRecordTypeMapping === true,
    },
  ];
}

/** The describe body → `SObjectDescribe`; `fallbackName` when the body has no name. */
export function toDescribe(json: unknown, fallbackName: string): SObjectDescribe {
  const body = (json ?? {}) as Record<string, unknown>;
  return {
    name: typeof body.name === 'string' ? body.name : fallbackName,
    fields: Array.isArray(body.fields) ? body.fields.flatMap(toField) : [],
    ...bool('createable', body.createable),
    ...bool('updateable', body.updateable),
    ...(Array.isArray(body.recordTypeInfos) ? { recordTypeInfos: body.recordTypeInfos.flatMap(toRecordTypeInfo) } : {}),
  };
}

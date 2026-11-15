import type { FormChoice, FormCondition, FormProperty, FormSchema, InputField } from "@octo/agent-client";
import { patternProblem } from "./pattern";

/**
 * Schema forms (spec 2026-11-15 §A.1, UI decision 97): parse and normalise the one form format, the MCP elicitation schema
 * plus `x-octo` keys. The limits and refusals mirror the harness's `inputs.ParseSchema`, so a bad schema fails the same way
 * on both sides. Pure: no React, no DOM.
 */

/** Where a form came from: only an agent's `request_input` may ask for a password (decision 5). */
export type FormOrigin = "tool" | "block" | "tool_server";

export const LIMITS = {
  schemaBytes: 32 * 1024,
  properties: 20,
  choices: 50,
  groups: 8,
  propertyTitle: 120,
  description: 500,
  placeholder: 120,
  patternBytes: 256,
  textBytes: 16 * 1024,
  secretMinBytes: 4,
  secretMaxBytes: 16 * 1024,
} as const;

/** Property ids (and secret names): today's `fieldID`. */
export const FIELD_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** One property, in form order, with what the renderer and the checks need resolved once. */
export type SchemaField = {
  id: string;
  prop: FormProperty;
  /** The property's title, or its id when it has none. */
  title: string;
  description: string;
  required: boolean;
  /** One-of choices (enum, oneOf) or many-of choices (array items); null for other kinds. */
  choices: readonly FormChoice[] | null;
  condition: FormCondition | null;
  /** `format: "password"`: its value is a secret and never lives in state. */
  secret: boolean;
};

export type SchemaGroup = { title: string; fields: string[] };

export type NormalForm = {
  fields: SchemaField[];
  groups: SchemaGroup[];
  submitLabel: string | null;
  /** The normalised schema (`x-octo.order` lists every property). */
  schema: FormSchema;
};

export type ParseResult = { ok: true; form: NormalForm } | { ok: false; reason: string };

const STRING_FORMATS: readonly string[] = ["email", "uri", "date", "date-time", "password"];
/** Keys a flat MCP form never needs; each one refuses the schema with a reason (spec §A.1 "Not in v1"). */
const REFUSED_KEYS: readonly string[] = ["$ref", "$defs", "definitions", "allOf", "anyOf", "if", "then", "else", "not", "properties", "additionalProperties"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const bytes = (s: string) => new TextEncoder().encode(s).length;

class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason);
};

/** Parses and normalises a form schema; refusals name the cause (and the property), never a value. */
export function parseSchema(raw: unknown, origin: FormOrigin = "tool"): ParseResult {
  try {
    return { ok: true, form: normalise(raw, origin) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.message };
    throw e;
  }
}

function normalise(raw: unknown, origin: FormOrigin): NormalForm {
  if (!isRecord(raw)) return refuse("the schema must be an object");
  let text = "";
  try {
    text = JSON.stringify(raw);
  } catch {
    refuse("the schema is not plain JSON");
  }
  if (bytes(text) > LIMITS.schemaBytes) refuse("the schema is larger than 32 KB");
  if (raw.type !== "object") refuse('the schema\'s type must be "object"');
  for (const key of ["$ref", "$defs", "allOf", "anyOf", "oneOf", "if", "then"]) if (key in raw) refuse(`"${key}" is not supported in a form`);
  if (!isRecord(raw.properties)) return refuse("the schema needs properties");
  const entries = Object.entries(raw.properties);
  if (entries.length === 0 || entries.length > LIMITS.properties) refuse(`a form takes 1 to ${LIMITS.properties} properties`);

  const required = raw.required === undefined ? [] : raw.required;
  if (!Array.isArray(required) || !required.every((r): r is string => typeof r === "string")) return refuse("required must be a list of property ids");
  for (const r of required) if (!(r in raw.properties)) refuse(`required names "${r}", which is not a property`);

  const octo = raw["x-octo"] === undefined ? {} : raw["x-octo"];
  if (!isRecord(octo)) return refuse("x-octo must be an object");
  const ids = entries.map(([id]) => id);
  const order = readOrder(octo.order, ids);
  const byId = new Map(entries);
  const fields: SchemaField[] = [];
  const seen: string[] = [];
  for (const id of order) {
    const prop = readProperty(id, byId.get(id), origin, seen);
    const choices = choicesOf(prop);
    const condition = prop["x-octo"]?.visible_when ?? null;
    fields.push({
      id,
      prop,
      title: prop.title?.trim() || id,
      description: prop.description?.trim() ?? "",
      required: required.includes(id),
      choices,
      condition,
      secret: prop.type === "string" && prop.format === "password",
    });
    seen.push(id);
  }
  const groups = readGroups(octo.groups, ids);
  const submit = octo.submit_label;
  if (submit !== undefined && (typeof submit !== "string" || submit.length > 40)) refuse("submit_label must be text of at most 40 characters");
  const submitLabel = typeof submit === "string" && submit.trim() ? submit.trim() : null;
  const schema: FormSchema = {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.id, f.prop])),
    ...(required.length ? { required: [...required] } : {}),
    "x-octo": { order: [...order], ...(groups.length ? { groups } : {}), ...(submitLabel ? { submit_label: submitLabel } : {}) },
  };
  return { fields, groups, submitLabel, schema };
}

function readOrder(raw: unknown, ids: readonly string[]): string[] {
  if (raw === undefined) return [...ids];
  if (!Array.isArray(raw) || !raw.every((x): x is string => typeof x === "string")) return refuse("x-octo.order must be a list of property ids");
  for (const id of raw) if (!ids.includes(id)) refuse(`x-octo.order names "${id}", which is not a property`);
  if (new Set(raw).size !== raw.length) refuse("x-octo.order names a property twice");
  // The service normalises `order` to list every property: the ones it leaves out follow in document order.
  return [...raw, ...ids.filter((id) => !raw.includes(id))];
}

function readGroups(raw: unknown, ids: readonly string[]): SchemaGroup[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > LIMITS.groups) return refuse(`x-octo.groups takes at most ${LIMITS.groups} groups`);
  return raw.map((g) => {
    if (!isRecord(g) || typeof g.title !== "string" || !g.title.trim() || g.title.length > LIMITS.propertyTitle) return refuse("each group needs a title");
    if (!Array.isArray(g.fields) || !g.fields.every((f): f is string => typeof f === "string" && ids.includes(f)))
      return refuse(`group "${g.title}" names an unknown property`);
    return { title: g.title.trim(), fields: [...g.fields] };
  });
}

function readText(id: string, v: unknown, what: string, max: number): void {
  if (v === undefined) return;
  if (typeof v !== "string") refuse(`property "${id}": ${what} must be text`);
  else if (Array.from(v).length > max) refuse(`property "${id}": ${what} is longer than ${max} characters`);
}

function readChoices(id: string, raw: unknown, key: string): FormChoice[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > LIMITS.choices) return refuse(`property "${id}": ${key} takes 1 to ${LIMITS.choices} choices`);
  const out = raw.map((c): FormChoice => {
    if (!isRecord(c) || typeof c.const !== "string" || typeof c.title !== "string") return refuse(`property "${id}": each choice needs const and title`);
    return { const: c.const, title: c.title };
  });
  if (new Set(out.map((c) => c.const)).size !== out.length) refuse(`property "${id}": a choice is listed twice`);
  return out;
}

function readEnum(id: string, raw: unknown, names: unknown): void {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > LIMITS.choices || !raw.every((x) => typeof x === "string")) {
    refuse(`property "${id}": enum takes 1 to ${LIMITS.choices} strings`);
    return;
  }
  if (new Set(raw).size !== raw.length) refuse(`property "${id}": a choice is listed twice`);
  if (names !== undefined && (!Array.isArray(names) || names.length !== raw.length || !names.every((x) => typeof x === "string"))) {
    refuse(`property "${id}": enumNames must give one name per choice`);
  }
}

function readProperty(id: string, raw: unknown, origin: FormOrigin, earlier: readonly string[]): FormProperty {
  if (!FIELD_ID.test(id)) refuse(`property id "${id.slice(0, 64)}" must start with a letter and use letters, digits, _ . - (at most 64)`);
  if (!isRecord(raw)) return refuse(`property "${id}" must be an object`);
  for (const key of REFUSED_KEYS) if (key in raw) refuse(`property "${id}": "${key}" is not supported in a form`);
  readText(id, raw.title, "title", LIMITS.propertyTitle);
  readText(id, raw.description, "description", LIMITS.description);
  const octo = raw["x-octo"];
  if (octo !== undefined) readPropertyOcto(id, octo, earlier);
  const type = raw.type;
  const dflt = raw.default;
  switch (type) {
    case "string": {
      if (raw.enum !== undefined) readEnum(id, raw.enum, raw.enumNames);
      if (raw.oneOf !== undefined) readChoices(id, raw.oneOf, "oneOf");
      if (raw.enum !== undefined && raw.oneOf !== undefined) refuse(`property "${id}": use enum or oneOf, not both`);
      const format = raw.format;
      if (format !== undefined && (typeof format !== "string" || !STRING_FORMATS.includes(format)))
        refuse(`property "${id}": format must be email, uri, date, date-time or password`);
      if (format === "password") {
        if (origin !== "tool") refuse(`property "${id}": only an agent's request_input may ask for a password`);
        if (!FIELD_ID.test(id)) refuse(`property "${id}" cannot name a secret`);
        if (dflt !== undefined) refuse(`property "${id}": a password has no default`);
      }
      for (const key of ["minLength", "maxLength"] as const)
        if (raw[key] !== undefined && !isCount(raw[key])) refuse(`property "${id}": ${key} must be a whole number of 0 or more`);
      if (isCount(raw.minLength) && isCount(raw.maxLength) && raw.minLength > raw.maxLength) refuse(`property "${id}": minLength is above maxLength`);
      if (raw.pattern !== undefined) {
        if (typeof raw.pattern !== "string") refuse(`property "${id}": pattern must be text`);
        else {
          const problem = patternProblem(raw.pattern);
          if (problem) refuse(`property "${id}": ${problem}`);
        }
      }
      if (dflt !== undefined && typeof dflt !== "string") refuse(`property "${id}": default must be text`);
      const choices = raw.enum !== undefined || raw.oneOf !== undefined ? choicesOf(raw as FormProperty) : null;
      if (choices && typeof dflt === "string" && !choices.some((c) => c.const === dflt)) refuse(`property "${id}": default is not one of the choices`);
      break;
    }
    case "number":
    case "integer": {
      for (const key of ["minimum", "maximum"] as const)
        if (raw[key] !== undefined && !(typeof raw[key] === "number" && Number.isFinite(raw[key]))) refuse(`property "${id}": ${key} must be a number`);
      if (typeof raw.minimum === "number" && typeof raw.maximum === "number" && raw.minimum > raw.maximum) refuse(`property "${id}": minimum is above maximum`);
      if (dflt !== undefined && !(typeof dflt === "number" && Number.isFinite(dflt) && (type === "number" || Number.isInteger(dflt))))
        refuse(`property "${id}": default must be a ${type === "integer" ? "whole " : ""}number`);
      break;
    }
    case "boolean":
      if (dflt !== undefined && typeof dflt !== "boolean") refuse(`property "${id}": default must be true or false`);
      break;
    case "array": {
      const items = raw.items;
      if (!isRecord(items)) return refuse(`property "${id}": an array needs items with choices`);
      if (items.anyOf !== undefined) readChoices(id, items.anyOf, "items.anyOf");
      else if (items.type === "string" && items.enum !== undefined) readEnum(id, items.enum, items.enumNames);
      else refuse(`property "${id}": an array is a list of choices (items.enum or items.anyOf); nested objects are not supported`);
      for (const key of ["minItems", "maxItems"] as const)
        if (raw[key] !== undefined && !isCount(raw[key])) refuse(`property "${id}": ${key} must be a whole number of 0 or more`);
      if (isCount(raw.minItems) && isCount(raw.maxItems) && raw.minItems > raw.maxItems) refuse(`property "${id}": minItems is above maxItems`);
      const choices = choicesOf(raw as FormProperty) ?? [];
      if (dflt !== undefined && !(Array.isArray(dflt) && dflt.every((d) => typeof d === "string" && choices.some((c) => c.const === d))))
        refuse(`property "${id}": default must list some of the choices`);
      break;
    }
    case "object":
      return refuse(`property "${id}": nested objects are not supported`);
    default:
      return refuse(`property "${id}": type must be string, number, integer, boolean or array`);
  }
  // The checks above proved the shape of each kind; the type system cannot follow the switch over an unknown record.
  return raw as FormProperty;
}

function readPropertyOcto(id: string, octo: unknown, earlier: readonly string[]): void {
  if (!isRecord(octo)) {
    refuse(`property "${id}": x-octo must be an object`);
    return;
  }
  readText(id, octo.placeholder, "placeholder", LIMITS.placeholder);
  if (octo.step !== undefined && !(typeof octo.step === "number" && octo.step > 0)) refuse(`property "${id}": step must be a number above 0`);
  const when = octo.visible_when;
  if (when === undefined) return;
  if (!isRecord(when) || typeof when.field !== "string") {
    refuse(`property "${id}": visible_when needs field and equals`);
    return;
  }
  if (!earlier.includes(when.field)) refuse(`property "${id}": visible_when must name an earlier property`);
  const eq = when.equals;
  if (!(isScalar(eq) || (Array.isArray(eq) && eq.length > 0 && eq.every(isScalar))))
    refuse(`property "${id}": visible_when.equals must be a value or a list of values`);
}

/** The labelled choices of a one-of or many-of property; null for other kinds. */
export function choicesOf(prop: FormProperty): FormChoice[] | null {
  if (prop.type === "string") {
    if (prop.oneOf) return prop.oneOf.map((c) => ({ const: c.const, title: c.title }));
    if (prop.enum) return prop.enum.map((v, i) => ({ const: v, title: prop.enumNames?.[i] ?? v }));
    return null;
  }
  if (prop.type === "array") {
    const items = prop.items;
    if ("anyOf" in items) return items.anyOf.map((c) => ({ const: c.const, title: c.title }));
    return items.enum.map((v, i) => ({ const: v, title: items.enumNames?.[i] ?? v }));
  }
  return null;
}

/**
 * The legacy five kinds as a schema (decision 2), for a harness that sends `fields` without `schema`: text → string,
 * secret → password, select → enum, confirm → boolean (a required one must be ticked), path → string with the path widget.
 */
export function fromFields(fields: readonly InputField[]): FormSchema {
  const properties: Record<string, FormProperty> = {};
  for (const f of fields) {
    const base = { title: f.label, ...(f.help ? { description: f.help } : {}) };
    switch (f.kind) {
      case "secret":
        properties[f.id] = { ...base, type: "string", format: "password" };
        break;
      case "select":
        properties[f.id] = { ...base, type: "string", enum: [...(f.options ?? [])] };
        break;
      case "confirm":
        properties[f.id] = { ...base, type: "boolean", ...(f.required ? { "x-octo": { accept: true } } : {}) };
        break;
      case "path":
        properties[f.id] = { ...base, type: "string", "x-octo": { widget: "path" } };
        break;
      default:
        properties[f.id] = { ...base, type: "string" };
    }
  }
  const required = fields.filter((f) => f.required).map((f) => f.id);
  return { type: "object", properties, ...(required.length ? { required } : {}), "x-octo": { order: fields.map((f) => f.id) } };
}

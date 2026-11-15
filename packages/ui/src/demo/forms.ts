import { BridgeError, type FormSchema, type InputAnswer, type InputRequest } from "@octo/agent-client";

/**
 * Schema forms in the demo (spec 2026-11-15 §A.4). `?demo=1&forms=1` adds every form below to the Atlas API conversation,
 * after the legacy "Deploy settings" (a `fields` form, converted on the client); `?forms=signin,region` adds only those.
 * The demo service refuses the email `taken@example.com` with 400 `error.fields`, so the refused state can be seen.
 */

type DemoForm = { key: string; title: string; reason: string; schema: FormSchema };

const FORMS: DemoForm[] = [
  {
    key: "signin",
    title: "Sign in to staging",
    reason: "The smoke tests log in as a test user.",
    schema: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email", title: "Email", "x-octo": { placeholder: "you@example.com" } },
        password: {
          type: "string",
          format: "password",
          title: "Password",
          minLength: 8,
          description: "At least 8 characters. Stored for this project as a secret.",
        },
        remember: { type: "boolean", title: "Keep me signed in for this project", default: true },
      },
    },
  },
  {
    key: "region",
    title: "Choose a region",
    reason: "The new database goes where most of the traffic is.",
    schema: {
      type: "object",
      required: ["region", "env"],
      properties: {
        region: {
          type: "string",
          title: "Region",
          oneOf: [
            { const: "eu-west", title: "Europe (Ireland)" },
            { const: "eu-central", title: "Europe (Frankfurt)" },
            { const: "us-east", title: "US East (Virginia)" },
            { const: "us-west", title: "US West (Oregon)" },
            { const: "ap-south", title: "Asia Pacific (Mumbai)" },
            { const: "ap-east", title: "Asia Pacific (Tokyo)" },
          ],
        },
        env: {
          type: "string",
          title: "Environment",
          enum: ["dev", "staging", "prod"],
          enumNames: ["Development", "Staging", "Production"],
          default: "staging",
        },
      },
    },
  },
  {
    key: "rollout",
    title: "Rollout settings",
    reason: "I'll write the rollout plan from these.",
    schema: {
      type: "object",
      required: ["replicas", "window", "canary_percent"],
      properties: {
        replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 10, default: 2, "x-octo": { step: 1 } },
        window: { type: "string", format: "date-time", title: "Deploy window starts" },
        freeze: { type: "string", format: "date", title: "Change freeze ends" },
        notes: {
          type: "string",
          title: "Release notes",
          maxLength: 500,
          description: "One line per change; they go into the changelog.",
          "x-octo": { multiline: true },
        },
        canary: { type: "boolean", title: "Use a canary" },
        canary_percent: {
          type: "integer",
          title: "Canary traffic (%)",
          minimum: 1,
          maximum: 50,
          default: 5,
          "x-octo": { visible_when: { field: "canary", equals: true } },
        },
      },
    },
  },
  {
    key: "checks",
    title: "Release checks",
    reason: "Which checks should I run before the release?",
    schema: {
      type: "object",
      required: ["checks"],
      properties: {
        checks: {
          type: "array",
          title: "Checks",
          minItems: 1,
          default: ["unit", "lint"],
          items: {
            anyOf: [
              { const: "unit", title: "Unit tests" },
              { const: "lint", title: "Lint" },
              { const: "types", title: "Type check" },
              { const: "e2e", title: "End-to-end" },
            ],
          },
        },
      },
      "x-octo": { submit_label: "Run checks" },
    },
  },
];

/** The forms the `?forms=` knob asks for (none without it). */
export function demoFormKeys(): string[] {
  const raw = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("forms");
  if (!raw) return [];
  if (raw === "1" || raw === "all") return FORMS.map((f) => f.key);
  return raw.split(",").filter((k) => FORMS.some((f) => f.key === k));
}

export function demoSchemaForms(
  keys: readonly string[],
  base: Omit<InputRequest, "id" | "title" | "reason" | "fields" | "schema">,
  newId: () => string,
): InputRequest[] {
  return FORMS.filter((f) => keys.includes(f.key)).map((f) => ({
    ...base,
    id: newId(),
    title: f.title,
    reason: f.reason,
    fields: [],
    schema: structuredClone(f.schema),
  }));
}

/** The secret ids of a form: password properties of its schema, or its legacy secret fields. */
export function secretIds(form: InputRequest): Set<string> {
  if (form.schema) return new Set(Object.entries(form.schema.properties).flatMap(([id, p]) => (p.type === "string" && p.format === "password" ? [id] : [])));
  return new Set(form.fields.filter((f) => f.kind === "secret").map((f) => f.id));
}

/** As the harness would refuse it (decision 4): 400 `invalid_request` with messages by field, never a value. */
export function demoRefusal(answer: InputAnswer): BridgeError | null {
  if (answer.values?.email !== "taken@example.com") return null;
  return new BridgeError(400, "invalid_request", "1 field needs attention", {
    fields: { email: "This test user is already signed in elsewhere; use another email" },
  });
}

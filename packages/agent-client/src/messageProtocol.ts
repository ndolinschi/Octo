import { BRIDGE_EVENT_TYPES, type Bridge } from "./client";
import type { BridgeEvent } from "./types";

export type MessagePortLike = {
  postMessage(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): () => void;
};

export type Theme = "dark" | "light";
export type BridgeMethod = Exclude<keyof Bridge, "subscribe">;
export type WireError = { status: number; code: string; message: string };

export type ClientMessage =
  | { kind: "call"; id: number; method: string; args: unknown[] }
  | { kind: "subscribe"; sub: number; projectId: string }
  | { kind: "unsubscribe"; sub: number }
  | { kind: "host"; id: number; action: string; args: unknown[] };

export type ResultMessage =
  | { kind: "result"; id: number; ok: true; value: unknown }
  | { kind: "result"; id: number; ok: false; error: WireError };

export type HostMessage =
  | ResultMessage
  | { kind: "event"; sub: number; event: BridgeEvent }
  | { kind: "open"; sub: number }
  | { kind: "error"; sub: number; message: string }
  | { kind: "theme"; theme: Theme };

export const BRIDGE_METHODS: readonly BridgeMethod[] = [
  "health",
  "getConfig",
  "listProjects",
  "createProject",
  "getProject",
  "updateProject",
  "deleteProject",
  "listAgents",
  "getAgent",
  "listMessages",
  "sendMessage",
  "cancelTurn",
  "listNotes",
  "createNote",
  "updateNote",
  "deleteNote",
];

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isBridgeMethod(v: unknown): v is BridgeMethod {
  return typeof v === "string" && (BRIDGE_METHODS as readonly string[]).includes(v);
}

function isBridgeEvent(v: unknown): v is BridgeEvent {
  return (
    isRec(v) &&
    typeof v.type === "string" &&
    (BRIDGE_EVENT_TYPES as readonly string[]).includes(v.type)
  );
}

function isWireError(v: unknown): v is WireError {
  return (
    isRec(v) &&
    isNum(v.status) &&
    typeof v.code === "string" &&
    typeof v.message === "string"
  );
}

export function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light";
}

export function isClientMessage(msg: unknown): msg is ClientMessage {
  if (!isRec(msg)) return false;
  switch (msg.kind) {
    case "call":
      return isNum(msg.id) && typeof msg.method === "string" && Array.isArray(msg.args);
    case "subscribe":
      return isNum(msg.sub) && typeof msg.projectId === "string";
    case "unsubscribe":
      return isNum(msg.sub);
    case "host":
      return isNum(msg.id) && typeof msg.action === "string" && Array.isArray(msg.args);
    default:
      return false;
  }
}

export function isHostMessage(msg: unknown): msg is HostMessage {
  if (!isRec(msg)) return false;
  switch (msg.kind) {
    case "result":
      return isNum(msg.id) && (msg.ok === true || (msg.ok === false && isWireError(msg.error)));
    case "event":
      return isNum(msg.sub) && isBridgeEvent(msg.event);
    case "open":
      return isNum(msg.sub);
    case "error":
      return isNum(msg.sub) && typeof msg.message === "string";
    case "theme":
      return isTheme(msg.theme);
    default:
      return false;
  }
}

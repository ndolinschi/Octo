import assert from "node:assert/strict";
import test from "node:test";
import { middleSplit } from "./truncate";

test("sibling folders with a long shared head keep the part that tells them apart", () => {
  const a = "product-configuration-management-system";
  const b = "product-configuration-facade-service";
  assert.deepEqual(middleSplit(a, [a, b]), { head: "product-configuration-", tail: "management-system", distinct: true });
  assert.deepEqual(middleSplit(b, [a, b]), { head: "product-configuration-", tail: "facade-service", distinct: true });
  // The owner's pair: the shared head runs into the third word; the cut goes back to the break before the difference.
  assert.equal(middleSplit("product-configuration-management-data-subsystem", ["product-configuration-management-system"])?.tail, "data-subsystem");
});

test("siblings that differ early, or a name with no siblings, cut as before", () => {
  assert.equal(middleSplit("app-api", ["app-web"]), null, "a shared head under six characters is no reason to cut");
  // A split is only where the CSS may cut: a row wide enough shows the whole name.
  assert.deepEqual(middleSplit("atlas-api", ["atlas-web"]), { head: "atlas-", tail: "api", distinct: true });
  assert.equal(middleSplit("orbit", ["orbit"]), null, "the name itself in the list is not a sibling");
  assert.deepEqual(middleSplit("product-configuration-manager", ["docs-site"]), middleSplit("product-configuration-manager"));
  assert.equal(middleSplit("PCFS", ["PCMS + PCFS"]), null, "a short name is one plain span");
});

test("a name that is the whole head of a sibling is not split into an empty tail", () => {
  assert.equal(middleSplit("web-app", ["web-app-legacy"]), null);
});

test("non-ASCII names are cut on code points, never inside a surrogate pair", () => {
  const name = "проверка-конфигурации-сервиса";
  const split = middleSplit(name);
  assert.ok(split);
  assert.equal(split.head + split.tail, name);
  const emoji = "\u{1F680}".repeat(16);
  const e = middleSplit(emoji);
  assert.ok(e);
  assert.equal(Array.from(e.tail).length, 5);
  assert.equal(e.head + e.tail, emoji);
  assert.ok(!/[\uD800-\uDBFF]$/.test(e.head) && !/^[\uDC00-\uDFFF]/.test(e.tail));
  assert.deepEqual(middleSplit("проект-оплаты-ядро", ["проект-оплаты-шлюз"]), { head: "проект-оплаты-", tail: "ядро", distinct: true });
});

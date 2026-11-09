import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { handleMessageReceived, sign, signingKey, verify } from "../dist/backend-events.js";

/**
 * The AgentPhone backend's push route (docs/backend-events.md): Standard
 * Webhooks signatures and the request handler, without a server or Wakeshift.
 */

const SECRET = "whsec_" + randomBytes(32).toString("base64");
const KEY = signingKey(SECRET);
const BODY = JSON.stringify({
  number_id: "num_1",
  message_id: "msg_1",
  from: "+15550000002",
  received_at: "2026-11-09T19:00:00Z",
});

function signed(body = BODY, { key = KEY, id = "evt_1", timestamp = Math.floor(Date.now() / 1000) } = {}) {
  return { id, timestamp: String(timestamp), signature: sign(key, id, timestamp, body) };
}

test("signingKey accepts a whsec_ secret and refuses anything else", () => {
  assert.equal(KEY.length, 32);
  assert.throws(() => signingKey("not-a-secret"), /Standard Webhooks secret/);
  assert.throws(() => signingKey("whsec_c2hvcnQ="), /at least 24 bytes/);
});

test("verify accepts a current, correct signature", () => {
  assert.equal(verify(KEY, signed(), BODY), true);
});

test("verify refuses a changed body, another key, or a missing header", () => {
  assert.equal(verify(KEY, signed(), BODY.replace("msg_1", "msg_2")), false);
  assert.equal(verify(KEY, signed(BODY, { key: randomBytes(32) }), BODY), false);
  const { id, timestamp, signature } = signed();
  assert.equal(verify(KEY, { timestamp, signature }, BODY), false);
  assert.equal(verify(KEY, { id, signature }, BODY), false);
  assert.equal(verify(KEY, { id, timestamp }, BODY), false);
});

test("verify refuses a timestamp more than 5 minutes off", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verify(KEY, signed(BODY, { timestamp: now - 301 }), BODY, now), false);
  assert.equal(verify(KEY, signed(BODY, { timestamp: now + 301 }), BODY, now), false);
  assert.equal(verify(KEY, signed(BODY, { timestamp: now - 299 }), BODY, now), true);
});

test("verify accepts any one of several signatures (secret rotation)", () => {
  const h = signed();
  const old = sign(randomBytes(32), h.id, Number(h.timestamp), BODY);
  assert.equal(verify(KEY, { ...h, signature: `${old} ${h.signature}` }, BODY), true);
});

test("a signed, valid request emits once and answers 204", async () => {
  const emitted = [];
  const r = await handleMessageReceived(KEY, signed(), BODY, async (m) => emitted.push(m));
  assert.equal(r.status, 204);
  assert.deepEqual(emitted, [JSON.parse(BODY)]);
});

test("an unsigned request is refused with 401 and emits nothing", async () => {
  const emitted = [];
  const r = await handleMessageReceived(KEY, { ...signed(), signature: "v1,AAAA" }, BODY, async (m) => emitted.push(m));
  assert.equal(r.status, 401);
  assert.equal(emitted.length, 0);
});

test("a signed but malformed body is refused with 400, naming the fields", async () => {
  const bad = JSON.stringify({ number_id: "num_1" });
  const r = await handleMessageReceived(KEY, signed(bad), bad, async () => assert.fail("must not emit"));
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.fields.sort(), ["from", "message_id", "received_at"]);
  const notJson = "{";
  assert.equal((await handleMessageReceived(KEY, signed(notJson), notJson, async () => {})).status, 400);
});

test("an emit failure answers 502 so the backend retries", async () => {
  const r = await handleMessageReceived(KEY, signed(), BODY, async () => {
    throw new Error("unreachable");
  });
  assert.equal(r.status, 502);
});

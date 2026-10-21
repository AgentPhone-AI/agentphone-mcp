import assert from "node:assert/strict";
import test from "node:test";

import { AgentPhoneAPI } from "../dist/api.js";

test("sendMessage serializes recipients and channel and omits absent fields", async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({
      url: String(url),
      method: options.method,
      body: JSON.parse(options.body),
    });
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const api = new AgentPhoneAPI("https://api.example.com", "test-key");
    await api.sendMessage({
      toNumber: "+14155551234",
      body: "one-to-one",
    });
    await api.sendMessage({
      recipients: ["+14155550101", "+14155550102"],
      channel: "whatsapp",
      body: "group",
    });
    await api.sendMessage({
      toNumber: "+14155551234",
      recipients: [],
      body: "empty recipients are absent",
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.url, "https://api.example.com/v1/messages");
    assert.equal(request.method, "POST");
  }
  assert.equal(requests[0].body.to_number, "+14155551234");
  assert.equal(requests[0].body.body, "one-to-one");
  assert.equal(Object.hasOwn(requests[0].body, "recipients"), false);
  assert.equal(Object.hasOwn(requests[0].body, "channel"), false);

  assert.deepEqual(requests[1].body.recipients, ["+14155550101", "+14155550102"]);
  assert.equal(requests[1].body.channel, "whatsapp");
  assert.equal(Object.hasOwn(requests[1].body, "to_number"), false);

  assert.equal(requests[2].body.to_number, "+14155551234");
  assert.equal(Object.hasOwn(requests[2].body, "recipients"), false);
});

# Backend events: telling the MCP server a message arrived

The MCP server's `watch_messages` tool lets an agent ask to be woken whenever a
message arrives on one of its numbers. It wakes agents through
[Wakeshift](https://wakeshift.ai), by emitting a `message.received` event.

The server has no other way to learn that a message arrived: it doesn't poll.
The AgentPhone backend reports each inbound message to the MCP server as it
arrives, and the server emits the event at once. Until the backend does,
leave this off: `watch_messages` is offered only when it's configured.

## What the backend does

For **every inbound message** (SMS, iMessage or WhatsApp) on any number, after
the message is stored, send one HTTP request to the MCP server:

```http
POST /internal/events/message-received
Content-Type: application/json
webhook-id: <unique ID for this notification>
webhook-timestamp: <Unix time in seconds>
webhook-signature: v1,<signature>

{
  "number_id": "num_abc123",
  "message_id": "msg_def456",
  "from": "+14155551234",
  "received_at": "2026-11-09T19:00:00Z"
}
```

Send it for every inbound message, whether or not anyone is watching the
number: the backend can't know who is watching, and Wakeshift delivers only to
conversations subscribed to that number. Don't send outbound messages (ones the
account sent).

### The body

| Field | Type | Meaning |
| --- | --- | --- |
| `number_id` | string | The ID of the account's number that received the message, as `list_numbers` and the API return it. |
| `message_id` | string | The message's ID, as `get_messages` returns it. |
| `from` | string or `null` | The sender, in E.164 form (`+14155551234`) when it's a phone number. `null` when unknown. |
| `received_at` | string | When the message arrived, ISO 8601 in UTC. |

Each string is at most 200 characters (`received_at` at most 64), and the body
at most 16 KB. Unknown fields are ignored.

**Don't include the message text.** The event tells the agent that a message
arrived; the agent reads it with `get_messages`, through the account's own
credentials. Event text that came from a third party could also instruct the
agent.

### Signing

Requests are signed with [Standard Webhooks](https://www.standardwebhooks.com/),
which has libraries for most languages (`standardwebhooks` on npm and PyPI, and
others listed on its site). The shared secret is `AGENTPHONE_EVENTS_SECRET`,
which has the form `whsec_` followed by base64 (at least 24 bytes; 32 is
typical).

If you sign by hand:

1. `webhook-id`: an ID unique to this notification. The message ID works.
2. `webhook-timestamp`: the current Unix time, in seconds.
3. The signed content is `<webhook-id>.<webhook-timestamp>.<body>`, where
   `<body>` is the exact bytes you send.
4. The key is the base64 after `whsec_`, decoded.
5. `webhook-signature` is `v1,` followed by the base64 HMAC-SHA256 of the signed
   content with that key.

The server refuses a timestamp more than 5 minutes from its own clock. During a
secret rotation, send several signatures separated by spaces
(`v1,<new> v1,<old>`); one valid signature is enough.

Node, with the `standardwebhooks` package:

```ts
import { Webhook } from "standardwebhooks";

const wh = new Webhook(process.env.AGENTPHONE_EVENTS_SECRET!);

export async function notifyMessageReceived(m: {
  numberId: string;
  messageId: string;
  from: string | null;
  receivedAt: Date;
}) {
  const body = JSON.stringify({
    number_id: m.numberId,
    message_id: m.messageId,
    from: m.from,
    received_at: m.receivedAt.toISOString(),
  });
  const timestamp = new Date();
  const res = await fetch(`${process.env.MCP_SERVER_URL}/internal/events/message-received`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": m.messageId,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": wh.sign(m.messageId, timestamp, body),
    },
    body,
  });
  if (res.status !== 204) throw new Error(`message-received notification failed: ${res.status}`);
}
```

Python, with the `standardwebhooks` package:

```python
import json, os
from datetime import datetime, timezone

import httpx
from standardwebhooks import Webhook

wh = Webhook(os.environ["AGENTPHONE_EVENTS_SECRET"])

def notify_message_received(number_id: str, message_id: str, sender: str | None, received_at: datetime) -> None:
    body = json.dumps({
        "number_id": number_id,
        "message_id": message_id,
        "from": sender,
        "received_at": received_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    })
    now = datetime.now(timezone.utc)
    res = httpx.post(
        f"{os.environ['MCP_SERVER_URL']}/internal/events/message-received",
        content=body,
        headers={
            "content-type": "application/json",
            "webhook-id": message_id,
            "webhook-timestamp": str(int(now.timestamp())),
            "webhook-signature": wh.sign(message_id, now, body),
        },
    )
    res.raise_for_status()
```

### Responses and retries

| Status | Meaning | Retry? |
| --- | --- | --- |
| `204` | Emitted (or already emitted for this message). | No |
| `400` | The body isn't valid JSON, or a field is missing or the wrong type. The response's `fields` lists which. | No: fix the sender |
| `401` | Missing, invalid or stale signature. | No: check the secret and the clock |
| `404` | The route is off: the server has no `AGENTPHONE_EVENTS_SECRET` or no `WAKESHIFT_KEY`. | No |
| `413` | The body is over 16 KB. | No |
| `502` | Wakeshift couldn't be reached or refused the emit. | Yes, with backoff |
| Other 5xx, timeout | The server is down or restarting. | Yes, with backoff |

Retrying is always safe. The event's ID comes from `number_id` and
`message_id`, so Wakeshift delivers a message once, however many times it's
reported, for a day after the first report.

Send the notification off the request path that stores the message (a queue
or a background job), so a slow or failed notification never delays or fails
receiving the message.

## Configuring the MCP server

| Variable | Value |
| --- | --- |
| `WAKESHIFT_KEY` | The Wakeshift app key. |
| `AGENTPHONE_EVENTS_SECRET` | The shared signing secret, `whsec_…`. |

With both set, the server mounts the route and offers `watch_messages`. With
either missing, Wakeshift is off: no route (`404`), no `watch_messages`, and
nothing is sent to Wakeshift.

Generate a secret with, for example:

```sh
node -e "console.log('whsec_' + require('crypto').randomBytes(32).toString('base64'))"
```

Give the same value to the backend. A malformed secret stops the server at
startup with an error, rather than refusing every request.

Wakeshift runs only on the HTTP transport. A stdio server (`npx
agentphone-mcp` on someone's machine) can't be reached by the backend, so it
never offers `watch_messages`.

A message the backend doesn't report wakes nobody. Turn it on only once the
backend sends every inbound message.

### Exposure

The route takes no AgentPhone credentials and isn't behind the MCP server's
OAuth: the signature is its only check. Keep the secret out of logs and code.
If the server sits behind a gateway, you can also allow
`/internal/events/*` only from the backend's network.

A valid request makes the server emit `message.received` for the number it
names. Only conversations that subscribed to that number through
`watch_messages`, which first checks that the caller's credentials can read
the number, receive it.

## Trying it locally

With the server running with both variables set, on port 3001 here:

```sh
node --input-type=module -e '
import { createHmac } from "node:crypto";
const key = Buffer.from(process.env.AGENTPHONE_EVENTS_SECRET.slice(6), "base64");
const body = JSON.stringify({ number_id: process.argv[1], message_id: "msg_test_" + Date.now(), from: "+15550000002", received_at: new Date().toISOString() });
const id = "evt_" + Date.now(), ts = Math.floor(Date.now() / 1000);
const sig = "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
const res = await fetch("http://localhost:3001/internal/events/message-received", { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sig }, body });
console.log(res.status);
' num_abc123
```

`204` means the event was emitted. An agent that called `watch_messages` for
that number wakes within seconds.

## The watched-number filter: the MCP server registers watches

Emitting for every inbound message is simple but wasteful once volume is high —
most numbers aren't being watched at any moment. To let the backend emit only
for numbers an agent is actually watching, the MCP server registers each watch
with the backend.

Whenever `watch_messages` creates or renews a Wakeshift subscription for a
number, the server also sends:

```http
POST /internal/watches
Content-Type: application/json
webhook-id: <unique ID for this request>
webhook-timestamp: <unix seconds>
webhook-signature: v1,<base64 HMAC-SHA256 of `{id}.{timestamp}.{body}`>

{ "number_id": "<number id, as list_numbers returns it>", "ttl_seconds": 86400 }
```

Signed with Standard Webhooks using the **same** `AGENTPHONE_EVENTS_SECRET` that
signs inbound events (same key: base64-decode the part after `whsec_`). The
backend tolerates 5 minutes of clock skew; the body is at most 4 KB. Sending
`ttl_seconds: 0` drops a watch early. The server re-registers on every renewal,
so a watch's expiry keeps sliding while an agent keeps calling `watch_messages`.

Responses: `200 {"number_id","watched":true,"expires_at":"...Z"}`; `401` on a bad
signature; `404` when the backend has no secret configured (treated as
"filter not enabled"); `422` on a bad body.

Registration is **best-effort**: a failure never fails `watch_messages`. Until
the backend's `MCP_EVENTS_WATCHED_ONLY` is on, it emits for every number
regardless, so a missed registration changes nothing; once it's on, a missed
registration just means that number isn't woken until the next renewal.

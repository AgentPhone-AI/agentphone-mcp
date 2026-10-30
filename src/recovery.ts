import { ApiError } from "./api.js";

type Recovery = {
  action: "reconcile" | "retry_read" | "retry_end_call" | "backoff" |
    "wait_for_call" | "wait_for_reset" | "wait_for_reply" | "investigate" |
    "credentials" | "lookup" | "none";
  hint: string;
};

// Advice only: the client never retries automatically. Keep this decision in
// one place so every tool treats ambiguous writes and explicit rejections alike.
export function classifyRecovery(error: ApiError): Recovery {
  const read = error.method === "GET" || error.method === "HEAD";
  const endCall = error.method === "POST" && /^\/v1\/calls\/[^/?]+\/end$/.test(error.path);
  const uncertain = error.kind === "invalid-response" || error.status === 0 || error.status === 408 || error.status >= 500;

  if (error.code === "DELIVERY_UNCONFIRMED" || (uncertain && !read && !endCall)) {
    return {
      action: "reconcile",
      hint: " The outcome is UNKNOWN — the action may already have taken effect. Do NOT blindly retry," +
        " which could duplicate it. Inspect the original attempt with the matching list_* or get_* tool" +
        " and any available message or call ID. An empty history or missing record is not proof that" +
        " it did not execute. Contact support if the outcome remains unknown; resend only after" +
        " non-acceptance is established.",
    };
  }

  if (uncertain) {
    return endCall
      ? { action: "retry_end_call", hint: " Ending an already-ended call is a no-op. Retry end_call for the same call ID with bounded backoff, or inspect it with get_call." }
      : { action: "retry_read", hint: " This read is safe to retry with bounded backoff." };
  }

  if (error.status === 429) {
    if (error.code === "OUTBOUND_LIMIT_REACHED" || error.code === "NEW_CONVERSATION_LIMIT_REACHED") {
      return { action: "wait_for_reset", hint: " Wait for the daily window to reset. Retrying before the reset will not clear this cap." };
    }
    if (["CONVERSATION_STREAK_LIMIT", "CONVERSATION_AWAITING_REPLY", "CONVERSATION_INACTIVE"].includes(error.code ?? "")) {
      return { action: "wait_for_reply", hint: " Wait for the recipient to reply. Retrying will not clear this conversation limit." };
    }
    // Retry-After is meaningful for an endpoint throttle, not an unknown error
    // code. Recognized cap codes above take precedence over even a stale header.
    if ((!error.code || error.code === "RATE_LIMITED") && validRetryAfter(error.retryAfter)) {
      return { action: "backoff", hint: ` Rate limited — wait ${error.retryAfter} (per Retry-After), then use bounded retries for this rejected request.` };
    }
    if (error.code === "RATE_LIMITED") {
      return { action: "backoff", hint: " Sending too fast. Slow down and use bounded backoff before retrying this rejected request." };
    }
    // This documented rejection has no code or Retry-After. Match its specific
    // route and message; arbitrary headerless 429s are not presumed transient.
    if (!error.code && error.method === "POST" && error.path === "/v1/calls" &&
        /^Concurrent outbound call limit reached \(\d+\)\. Please wait for an active call to end\.$/.test(error.detail)) {
      return { action: "wait_for_call", hint: " Wait for an active call to finish before requesting another call." };
    }
    return { action: "investigate", hint: " This limit is not recognized. Investigate the error before retrying; do not assume a short wait will clear it." };
  }

  if (error.status === 401) {
    return { action: "credentials", hint: " The supplied credential was rejected. Check the bearer token (HTTP) or AGENTPHONE_API_KEY (stdio)." };
  }
  if (error.status === 404) {
    const routes = [
      ["/agents/", "list_agents", "valid agent IDs"],
      ["/numbers/", "list_numbers", "valid number IDs"],
      ["/calls/", "list_calls", "recent call IDs"],
      ["/conversations/", "list_conversations", "valid conversation IDs"],
    ];
    for (const [route, tool, target] of routes) {
      if (error.path.includes(route)) return { action: "lookup", hint: ` Use ${tool} to see ${target}.` };
    }
    if (error.path.includes("/webhook")) {
      return { action: "lookup", hint: " Use get_webhook to check whether a webhook is configured." };
    }
  }
  return { action: "none", hint: "" };
}

function validRetryAfter(value: string | null): boolean {
  if (!value) return false;
  return /^\d+$/.test(value) ||
    (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value)));
}

/**
 * AgentPhone API client.
 *
 * Minimal typed HTTP client for the AgentPhone REST API.
 * Used by the MCP server to proxy tool calls to the backend.
 */
export class AgentPhoneAPI {
    baseUrl;
    // A static key, or a getter resolved per request (used when the credential
    // comes from the per-request OAuth token rather than a fixed env var).
    apiKey;
    constructor(baseUrl, apiKey) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.apiKey = apiKey;
    }
    async request(method, path, body, timeoutMs) {
        const url = `${this.baseUrl}${path}`;
        const token = typeof this.apiKey === "function" ? this.apiKey() : this.apiKey;
        const headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        };
        const timeout = timeoutMs ?? 30_000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text();
                let detail = text;
                try {
                    const json = JSON.parse(text);
                    detail = json.detail ?? json.message ?? text;
                }
                catch {
                    // use raw text
                }
                throw new ApiError(res.status, method, path, detail);
            }
            if (res.status === 204)
                return {};
            return res.json();
        }
        catch (e) {
            if (e instanceof Error && e.name === "AbortError") {
                throw new ApiError(0, method, path, `Request timed out after ${timeout}ms`);
            }
            throw e;
        }
        finally {
            clearTimeout(timer);
        }
    }
    // --- Numbers ---
    async listNumbers(limit = 20, offset = 0) {
        return this.request("GET", `/v1/numbers?limit=${limit}&offset=${offset}`);
    }
    async buyNumber(country = "US", agentId, areaCode) {
        return this.request("POST", "/v1/numbers", { country, agentId, areaCode });
    }
    async releaseNumber(numberId) {
        return this.request("DELETE", `/v1/numbers/${encodeURIComponent(numberId)}`);
    }
    // --- SMS / Messages ---
    async getMessages(numberId, limit = 50) {
        return this.request("GET", `/v1/numbers/${encodeURIComponent(numberId)}/messages?limit=${limit}`);
    }
    async sendMessage(params) {
        return this.request("POST", "/v1/messages", {
            agent_id: params.agentId,
            to_number: params.toNumber,
            body: params.body,
            media_url: params.mediaUrl,
            media_urls: params.mediaUrls,
            number_id: params.numberId,
            from_number: params.fromNumber,
            reply_to_message_id: params.replyToMessageId,
            send_style: params.sendStyle,
        });
    }
    async sendReaction(messageId, reaction) {
        return this.request("POST", `/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
            reaction,
        });
    }
    // --- Agents ---
    async listVoices() {
        return this.request("GET", "/v1/agents/voices");
    }
    async listAgents(limit = 20, offset = 0) {
        return this.request("GET", `/v1/agents?limit=${limit}&offset=${offset}`);
    }
    async createAgent(params) {
        return this.request("POST", "/v1/agents", params);
    }
    async updateAgent(agentId, params) {
        return this.request("PATCH", `/v1/agents/${encodeURIComponent(agentId)}`, params);
    }
    async deleteAgent(agentId) {
        return this.request("DELETE", `/v1/agents/${encodeURIComponent(agentId)}`);
    }
    async getAgent(agentId) {
        return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}`);
    }
    async attachNumber(agentId, numberId) {
        return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/numbers`, { numberId });
    }
    async detachNumber(agentId, numberId) {
        return this.request("DELETE", `/v1/agents/${encodeURIComponent(agentId)}/numbers/${encodeURIComponent(numberId)}`);
    }
    // --- Agent-scoped queries ---
    async listAgentConversations(agentId, limit = 20, offset = 0) {
        return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}/conversations?limit=${limit}&offset=${offset}`);
    }
    async listAgentCalls(agentId, limit = 20, offset = 0) {
        return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}/calls?limit=${limit}&offset=${offset}`);
    }
    // --- Agent Webhooks ---
    async getAgentWebhook(agentId) {
        return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}/webhook`);
    }
    async setAgentWebhook(agentId, url, contextLimit, timeout) {
        const body = { url };
        if (contextLimit !== undefined)
            body.contextLimit = contextLimit;
        if (timeout !== undefined)
            body.timeout = timeout;
        return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/webhook`, body);
    }
    async deleteAgentWebhook(agentId) {
        return this.request("DELETE", `/v1/agents/${encodeURIComponent(agentId)}/webhook`);
    }
    async testAgentWebhook(agentId) {
        return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/webhook/test`);
    }
    async listAgentWebhookDeliveries(agentId, limit = 20, hours) {
        let path = `/v1/agents/${encodeURIComponent(agentId)}/webhook/deliveries?limit=${limit}`;
        if (hours !== undefined)
            path += `&hours=${hours}`;
        return this.request("GET", path);
    }
    // --- Calls ---
    async listCalls(limit = 20, offset = 0, filters) {
        let path = `/v1/calls?limit=${limit}&offset=${offset}`;
        if (filters?.status)
            path += `&status=${encodeURIComponent(filters.status)}`;
        if (filters?.direction)
            path += `&direction=${encodeURIComponent(filters.direction)}`;
        if (filters?.search)
            path += `&search=${encodeURIComponent(filters.search)}`;
        return this.request("GET", path);
    }
    async getCall(callId, opts) {
        let path = `/v1/calls/${encodeURIComponent(callId)}`;
        const params = [];
        if (opts?.wait)
            params.push("wait=true");
        if (opts?.timeout)
            params.push(`timeout=${opts.timeout}`);
        if (params.length)
            path += `?${params.join("&")}`;
        const fetchTimeout = opts?.wait ? 300_000 : undefined;
        return this.request("GET", path, undefined, fetchTimeout);
    }
    async makeCall(agentId, toNumber, initialGreeting, fromNumberId, voice) {
        const body = { agentId, toNumber };
        if (initialGreeting !== undefined)
            body.initialGreeting = initialGreeting;
        if (fromNumberId !== undefined)
            body.fromNumberId = fromNumberId;
        if (voice !== undefined)
            body.voice = voice;
        return this.request("POST", "/v1/calls", body);
    }
    async makeConversationCall(agentId, toNumber, systemPrompt, initialGreeting, waitForCompletion, maxWaitSeconds, fromNumberId, voice) {
        const body = { agentId, toNumber, systemPrompt };
        if (initialGreeting !== undefined)
            body.initialGreeting = initialGreeting;
        if (waitForCompletion !== undefined)
            body.waitForCompletion = waitForCompletion;
        if (maxWaitSeconds !== undefined)
            body.maxWaitSeconds = maxWaitSeconds;
        if (fromNumberId !== undefined)
            body.fromNumberId = fromNumberId;
        if (voice !== undefined)
            body.voice = voice;
        const fetchTimeout = waitForCompletion ? 600_000 : undefined;
        return this.request("POST", "/v1/calls", body, fetchTimeout);
    }
    async listCallsForNumber(numberId, limit = 20, offset = 0) {
        return this.request("GET", `/v1/numbers/${encodeURIComponent(numberId)}/calls?limit=${limit}&offset=${offset}`);
    }
    // --- Conversations ---
    async listConversations(limit = 20, offset = 0) {
        return this.request("GET", `/v1/conversations?limit=${limit}&offset=${offset}`);
    }
    async getConversation(conversationId, messageLimit = 50) {
        return this.request("GET", `/v1/conversations/${encodeURIComponent(conversationId)}?message_limit=${messageLimit}`);
    }
    async updateConversation(conversationId, metadata) {
        return this.request("PATCH", `/v1/conversations/${encodeURIComponent(conversationId)}`, { metadata });
    }
    // --- Contacts ---
    async listContacts(limit = 50, offset = 0, search) {
        let path = `/v1/contacts?limit=${limit}&offset=${offset}`;
        if (search)
            path += `&search=${encodeURIComponent(search)}`;
        return this.request("GET", path);
    }
    async createContact(params) {
        return this.request("POST", "/v1/contacts", params);
    }
    async updateContact(contactId, params) {
        return this.request("PATCH", `/v1/contacts/${encodeURIComponent(contactId)}`, params);
    }
    async deleteContact(contactId) {
        return this.request("DELETE", `/v1/contacts/${encodeURIComponent(contactId)}`);
    }
    // --- Webhooks ---
    async getWebhook() {
        return this.request("GET", "/v1/webhooks");
    }
    async setWebhook(url, contextLimit, timeout) {
        const body = { url };
        if (contextLimit !== undefined)
            body.contextLimit = contextLimit;
        if (timeout !== undefined)
            body.timeout = timeout;
        return this.request("POST", "/v1/webhooks", body);
    }
    async deleteWebhook() {
        return this.request("DELETE", "/v1/webhooks");
    }
    async testWebhook() {
        return this.request("POST", "/v1/webhooks/test");
    }
    async listWebhookDeliveries(limit = 20, hours) {
        let path = `/v1/webhooks/deliveries?limit=${limit}`;
        if (hours !== undefined)
            path += `&hours=${hours}`;
        return this.request("GET", path);
    }
    // --- Usage ---
    async getUsage() {
        // NOTE: the legacy `plan` block (free/pro/scale + per-line limits) was
        // removed from GET /v1/usage (agent-phone tasks#141) — it advertised
        // limits nothing enforces. Messaging/voice bill per use from credits.
        return this.request("GET", "/v1/usage");
    }
    async getDailyUsage(days = 30) {
        return this.request("GET", `/v1/usage/daily?days=${days}`);
    }
    async getMonthlyUsage(months = 12) {
        return this.request("GET", `/v1/usage/monthly?months=${months}`);
    }
}
// --- Error class ---
export class ApiError extends Error {
    status;
    method;
    path;
    detail;
    constructor(status, method, path, detail) {
        super(`AgentPhone API ${method} ${path} failed (${status}): ${detail}`);
        this.status = status;
        this.method = method;
        this.path = path;
        this.detail = detail;
        this.name = "ApiError";
    }
}
//# sourceMappingURL=api.js.map
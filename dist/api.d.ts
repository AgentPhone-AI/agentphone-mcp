/**
 * AgentPhone API client.
 *
 * Minimal typed HTTP client for the AgentPhone REST API.
 * Used by the MCP server to proxy tool calls to the backend.
 */
export declare class AgentPhoneAPI {
    private baseUrl;
    private apiKey;
    constructor(baseUrl: string, apiKey: string | (() => string));
    private request;
    listNumbers(limit?: number, offset?: number): Promise<{
        data: Array<{
            id: string;
            phoneNumber: string;
            country: string;
            status: string;
            agentId: string | null;
            createdAt: string;
        }>;
        hasMore: boolean;
        total: number;
    }>;
    buyNumber(country?: string, agentId?: string, areaCode?: string): Promise<{
        id: string;
        phoneNumber: string;
        country: string;
        status: string;
        agentId: string | null;
        createdAt: string;
    }>;
    releaseNumber(numberId: string): Promise<{
        success: boolean;
        phoneNumber: string;
        status: string;
    }>;
    getMessages(numberId: string, limit?: number): Promise<{
        data: Array<{
            id: string;
            from: string;
            to: string;
            body: string;
            receivedAt: string;
        }>;
        hasMore: boolean;
    }>;
    sendMessage(params: {
        agentId?: string;
        toNumber: string;
        body: string;
        mediaUrl?: string;
        mediaUrls?: string[];
        numberId?: string;
        fromNumber?: string;
        replyToMessageId?: string;
        sendStyle?: string;
    }): Promise<{
        id: string;
        status: string;
        channel: string | null;
        from_number: string;
        to_number: string;
        media_urls: string[];
        reply_to_message_id: string | null;
        reply_parent_unresolved: boolean | null;
    }>;
    sendReaction(messageId: string, reaction: string): Promise<{
        id: string;
        reaction_type: string;
        message_id: string;
        channel: string;
    }>;
    listVoices(): Promise<{
        data: Array<{
            voice_id: string;
            voice_name: string;
            provider: string;
            gender: string;
            accent: string;
            preview_audio_url: string | null;
        }>;
    }>;
    listAgents(limit?: number, offset?: number): Promise<{
        data: Array<{
            id: string;
            name: string;
            description: string | null;
            voiceMode: string;
            systemPrompt: string | null;
            beginMessage: string | null;
            voice: string;
            modelTier: string;
            transferNumber: string | null;
            voicemailMessage: string | null;
            sttMode: string;
            ambientSound: string;
            denoisingMode: string;
            maxSilenceMs: number;
            enableMessaging: boolean;
            enableBackchannel: boolean;
            interruptionSensitivity: number;
            voiceSpeed: number;
            language: string;
            createdAt: string;
            numbers?: Array<{
                id: string;
                phoneNumber: string;
                status: string;
            }>;
        }>;
        total: number;
    }>;
    createAgent(params: {
        name: string;
        description?: string;
        voiceMode?: string;
        systemPrompt?: string;
        beginMessage?: string;
        voice?: string;
        modelTier?: string;
        transferNumber?: string;
        voicemailMessage?: string;
        sttMode?: string;
        ambientSound?: string;
        denoisingMode?: string;
        maxSilenceMs?: number;
        enableMessaging?: boolean;
        enableBackchannel?: boolean;
        interruptionSensitivity?: number;
        voiceSpeed?: number;
        language?: string;
    }): Promise<{
        id: string;
        name: string;
        description: string | null;
        voiceMode: string;
        systemPrompt: string | null;
        beginMessage: string | null;
        voice: string;
        modelTier: string;
        transferNumber: string | null;
        voicemailMessage: string | null;
        sttMode: string;
        ambientSound: string;
        denoisingMode: string;
        maxSilenceMs: number;
        enableMessaging: boolean;
        enableBackchannel: boolean;
        interruptionSensitivity: number;
        voiceSpeed: number;
        language: string;
        createdAt: string;
        numbers: Array<{
            id: string;
            phoneNumber: string;
            status: string;
        }>;
    }>;
    updateAgent(agentId: string, params: {
        name?: string;
        description?: string;
        voiceMode?: string;
        systemPrompt?: string;
        beginMessage?: string;
        voice?: string;
        modelTier?: string;
        transferNumber?: string;
        voicemailMessage?: string;
        sttMode?: string;
        ambientSound?: string;
        denoisingMode?: string;
        maxSilenceMs?: number;
        enableMessaging?: boolean;
        enableBackchannel?: boolean;
        interruptionSensitivity?: number;
        voiceSpeed?: number;
        language?: string;
    }): Promise<{
        id: string;
        name: string;
        description: string | null;
        voiceMode: string;
        systemPrompt: string | null;
        beginMessage: string | null;
        voice: string;
        modelTier: string;
        transferNumber: string | null;
        voicemailMessage: string | null;
        sttMode: string;
        ambientSound: string;
        denoisingMode: string;
        maxSilenceMs: number;
        enableMessaging: boolean;
        enableBackchannel: boolean;
        interruptionSensitivity: number;
        voiceSpeed: number;
        language: string;
        createdAt: string;
        numbers?: Array<{
            id: string;
            phoneNumber: string;
            status: string;
        }>;
    }>;
    deleteAgent(agentId: string): Promise<{
        success: boolean;
        id: string;
        name: string;
    }>;
    getAgent(agentId: string): Promise<{
        id: string;
        name: string;
        description: string | null;
        voiceMode: string;
        systemPrompt: string | null;
        beginMessage: string | null;
        voice: string;
        modelTier: string;
        transferNumber: string | null;
        voicemailMessage: string | null;
        sttMode: string;
        ambientSound: string;
        denoisingMode: string;
        maxSilenceMs: number;
        enableMessaging: boolean;
        enableBackchannel: boolean;
        interruptionSensitivity: number;
        voiceSpeed: number;
        language: string;
        createdAt: string;
        numbers?: Array<{
            id: string;
            phoneNumber: string;
            status: string;
        }>;
    }>;
    attachNumber(agentId: string, numberId: string): Promise<{
        agentId: string;
        number: {
            id: string;
            phoneNumber: string;
            status: string;
        };
    }>;
    detachNumber(agentId: string, numberId: string): Promise<{
        success: boolean;
    }>;
    listAgentConversations(agentId: string, limit?: number, offset?: number): Promise<{
        data: Array<{
            id: string;
            agentId: string | null;
            phoneNumberId: string;
            phoneNumber: string;
            participant: string;
            lastMessageAt: string | null;
            lastMessagePreview: string;
            messageCount: number;
            createdAt: string;
        }>;
        hasMore: boolean;
        total: number;
    }>;
    listAgentCalls(agentId: string, limit?: number, offset?: number): Promise<{
        data: Array<{
            id: string;
            fromNumber: string;
            toNumber: string;
            direction: string;
            status: string;
            startedAt: string;
            endedAt: string | null;
            agentId: string | null;
            phoneNumberId: string;
        }>;
        hasMore: boolean;
        total: number;
    }>;
    getAgentWebhook(agentId: string): Promise<{
        id: string;
        url: string;
        secret: string;
        status: string;
        contextLimit: number;
        createdAt: string;
    } | null>;
    setAgentWebhook(agentId: string, url: string, contextLimit?: number, timeout?: number): Promise<{
        id: string;
        url: string;
        secret: string;
        status: string;
        contextLimit: number;
        createdAt: string;
    }>;
    deleteAgentWebhook(agentId: string): Promise<{
        success: boolean;
    }>;
    testAgentWebhook(agentId: string): Promise<{
        success: boolean;
        statusCode: number | null;
        responseMs: number | null;
        error: string | null;
    }>;
    listAgentWebhookDeliveries(agentId: string, limit?: number, hours?: number): Promise<{
        data: Array<{
            id: string;
            event: string;
            statusCode: number | null;
            success: boolean;
            deliveredAt: string;
            responseMs: number | null;
        }>;
        hasMore: boolean;
        total: number;
    }>;
    listCalls(limit?: number, offset?: number, filters?: {
        status?: string;
        direction?: string;
        search?: string;
    }): Promise<{
        data: Array<{
            id: string;
            fromNumber: string;
            toNumber: string;
            direction: string;
            status: string;
            startedAt: string;
            endedAt: string | null;
            agentId: string | null;
            phoneNumberId: string;
        }>;
        hasMore: boolean;
        total: number;
    }>;
    getCall(callId: string, opts?: {
        wait?: boolean;
        timeout?: number;
    }): Promise<{
        id: string;
        fromNumber: string;
        toNumber: string;
        direction: string;
        status: string;
        startedAt: string;
        endedAt: string | null;
        agentId: string | null;
        transcripts: Array<{
            id: string;
            transcript: string;
            response: string | null;
            createdAt: string;
        }>;
    }>;
    makeCall(agentId: string, toNumber: string, initialGreeting?: string, fromNumberId?: string, voice?: string): Promise<{
        id: string;
        fromNumber: string;
        toNumber: string;
        direction: string;
        status: string;
        startedAt: string;
        retellCallId: string | null;
    }>;
    makeConversationCall(agentId: string, toNumber: string, systemPrompt: string, initialGreeting?: string, waitForCompletion?: boolean, maxWaitSeconds?: number, fromNumberId?: string, voice?: string): Promise<{
        id: string;
        fromNumber: string;
        toNumber: string;
        direction: string;
        status: string;
        startedAt: string;
        endedAt: string | null;
        retellCallId: string | null;
        transcripts?: Array<{
            id: string;
            transcript: string;
            response: string | null;
            createdAt: string;
        }>;
    }>;
    listCallsForNumber(numberId: string, limit?: number, offset?: number): Promise<{
        data: Array<{
            id: string;
            fromNumber: string;
            toNumber: string;
            direction: string;
            status: string;
            startedAt: string;
            endedAt: string | null;
            agentId: string | null;
            phoneNumberId: string;
        }>;
        hasMore: boolean;
        total: number;
    }>;
    listConversations(limit?: number, offset?: number): Promise<{
        data: Array<{
            id: string;
            agentId: string | null;
            phoneNumberId: string;
            phoneNumber: string;
            participant: string;
            lastMessageAt: string | null;
            lastMessagePreview: string;
            messageCount: number;
            createdAt: string;
        }>;
        hasMore: boolean;
        total: number;
    }>;
    getConversation(conversationId: string, messageLimit?: number): Promise<{
        id: string;
        agentId: string | null;
        phoneNumberId: string;
        phoneNumber: string;
        participant: string;
        lastMessageAt: string | null;
        messageCount: number;
        metadata: Record<string, unknown> | null;
        createdAt: string;
        messages: Array<{
            id: string;
            body: string;
            fromNumber: string;
            toNumber: string;
            direction: string;
            receivedAt: string;
        }>;
    }>;
    updateConversation(conversationId: string, metadata: Record<string, unknown> | null): Promise<{
        id: string;
        agentId: string | null;
        phoneNumberId: string;
        phoneNumber: string;
        participant: string;
        lastMessageAt: string | null;
        messageCount: number;
        metadata: Record<string, unknown> | null;
        createdAt: string;
    }>;
    listContacts(limit?: number, offset?: number, search?: string): Promise<{
        data: Array<{
            id: string;
            phoneNumber: string;
            name: string;
            email: string | null;
            notes: string | null;
            createdAt: string;
            updatedAt: string;
        }>;
        hasMore: boolean;
        total: number;
    }>;
    createContact(params: {
        phoneNumber: string;
        name: string;
        email?: string;
        notes?: string;
    }): Promise<{
        id: string;
        phoneNumber: string;
        name: string;
        email: string | null;
        notes: string | null;
        createdAt: string;
        updatedAt: string;
    }>;
    updateContact(contactId: string, params: {
        phoneNumber?: string;
        name?: string;
        email?: string;
        notes?: string;
    }): Promise<{
        id: string;
        phoneNumber: string;
        name: string;
        email: string | null;
        notes: string | null;
        createdAt: string;
        updatedAt: string;
    }>;
    deleteContact(contactId: string): Promise<{
        success: boolean;
    }>;
    getWebhook(): Promise<{
        id: string;
        url: string;
        secret: string;
        status: string;
        contextLimit: number;
        createdAt: string;
    } | null>;
    setWebhook(url: string, contextLimit?: number, timeout?: number): Promise<{
        id: string;
        url: string;
        secret: string;
        status: string;
        contextLimit: number;
        createdAt: string;
    }>;
    deleteWebhook(): Promise<{
        success: boolean;
    }>;
    testWebhook(): Promise<{
        success: boolean;
        statusCode: number | null;
        responseMs: number | null;
        error: string | null;
    }>;
    listWebhookDeliveries(limit?: number, hours?: number): Promise<{
        data: Array<{
            id: string;
            event: string;
            statusCode: number | null;
            success: boolean;
            deliveredAt: string;
            responseMs: number | null;
        }>;
        hasMore: boolean;
        total: number;
    }>;
    getUsage(): Promise<{
        numbers: {
            used: number;
            limit: number;
            remaining: number;
        };
        stats: {
            totalMessages: number;
            messagesLast24h: number;
            messagesLast7d: number;
            messagesLast30d: number;
            smsSegmentsLast30d: number;
            totalCalls: number;
            callsLast24h: number;
            callsLast7d: number;
            callsLast30d: number;
            totalWebhookDeliveries: number;
            successfulWebhookDeliveries: number;
            failedWebhookDeliveries: number;
        };
        periodStart: string;
        periodEnd: string;
    }>;
    getDailyUsage(days?: number): Promise<{
        data: Array<{
            date: string;
            messages: number;
            calls: number;
            webhooks: number;
        }>;
        days: number;
    }>;
    getMonthlyUsage(months?: number): Promise<{
        data: Array<{
            month: string;
            messages: number;
            calls: number;
            webhooks: number;
        }>;
        months: number;
    }>;
}
export declare class ApiError extends Error {
    readonly status: number;
    readonly method: string;
    readonly path: string;
    readonly detail: string;
    constructor(status: number, method: string, path: string, detail: string);
}
//# sourceMappingURL=api.d.ts.map
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedMemory, DomainContext } from "../../core/types.js";
import { loadPrompt } from "../../core/prompt-loader.js";
import { CHAT_TAG, CHAT_MESSAGE_TAG } from "./types.js";
import { TOPIC_TAG, TOPIC_DOMAIN_ID } from "../topic/types.js";
import { ensureTag } from "./utils.js";

const BASE_DIR = dirname(fileURLToPath(import.meta.url));

function logInboxWarning(scope: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[memory-domain warning] ${scope}: ${errorMessage}`);
}

const BATCH_TOPIC_EXTRACTION_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            index: { type: "number", description: "Zero-based index of the message" },
            topics: {
                type: "array",
                items: { type: "string" },
                description: "Topic names extracted from this message",
            },
        },
        required: ["index", "topics"],
    },
});

export async function processInboxBatch(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<void> {
    const userId = context.requestContext.userId as string | undefined;
    const chatSessionId = context.requestContext.chatSessionId as string | undefined;

    if (!userId || !chatSessionId) return;

    await context.debug.time(
        "chat.inbox.total",
        async () => {
            const chatTagId = await ensureTag(context, CHAT_TAG);
            const chatMessageTagId = await ensureTag(context, CHAT_MESSAGE_TAG);
            try {
                await context.graph.relate(chatMessageTagId, "child_of", chatTagId);
            } catch {
                /* already related */
            }

            const existing = await context.getMemories({
                tags: [CHAT_MESSAGE_TAG],
                attributes: { chatSessionId, userId },
            });
            let messageIndex = existing.length;

            await context.debug.time(
                "chat.inbox.tagAndAttribute",
                async () => {
                    for (const entry of entries) {
                        const role = (entry.domainAttributes.role as string | undefined) ?? "user";

                        await context.updateAttributes(entry.memory.id, {
                            role,
                            layer: "working",
                            chatSessionId,
                            userId,
                            messageIndex,
                        });
                        messageIndex++;

                        await context.tagMemory(entry.memory.id, chatTagId);
                        await context.tagMemory(entry.memory.id, chatMessageTagId);
                    }
                },
                { entries: entries.length },
            );

            const topicsMap = await context.debug.time(
                "chat.inbox.topicExtraction",
                () => batchExtractTopics(entries, context),
                { entries: entries.length },
            );

            await context.debug.time(
                "chat.inbox.topicLinking",
                async () => {
                    for (const entry of entries) {
                        const topicNames = topicsMap.get(entry.memory.id) ?? [];
                        for (const topicName of topicNames) {
                            const trimmed = topicName.trim();
                            if (!trimmed) continue;
                            await linkTopic(context, entry.memory.id, trimmed);
                        }
                    }
                },
                { entries: entries.length },
            );
        },
        { entries: entries.length },
    );
}

async function batchExtractTopics(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const llm = context.llmAt("low");
    const topicPrompt = await loadPrompt(BASE_DIR, "topic-extraction");

    // Build numbered content list
    const numberedItems = entries.map((e, i) => `${i}. ${e.memory.content}`).join("\n\n");

    if (llm.extractStructured) {
        try {
            const raw = (await llm.extractStructured(
                numberedItems,
                BATCH_TOPIC_EXTRACTION_SCHEMA,
                topicPrompt,
            )) as Array<{ index: number; topics: string[] }>;

            for (const item of raw) {
                if (item.index >= 0 && item.index < entries.length && Array.isArray(item.topics)) {
                    result.set(entries[item.index].memory.id, item.topics);
                }
            }
            return result;
        } catch (error) {
            logInboxWarning("chat.inbox.topicExtraction.extractStructured", error);
            // Fall through to sequential fallback
        }
    }

    // Fallback: sequential extract calls
    for (const entry of entries) {
        try {
            const topics = await llm.extract(entry.memory.content);
            result.set(entry.memory.id, topics);
        } catch (error) {
            logInboxWarning("chat.inbox.topicExtraction.extract", error);
            result.set(entry.memory.id, []);
        }
    }

    return result;
}

async function linkTopic(
    context: DomainContext,
    memoryId: string,
    topicName: string,
): Promise<void> {
    const searchResult = await context.search({
        text: topicName,
        tags: [TOPIC_TAG],
        minScore: 0.8,
    });

    let topicId: string;

    if (searchResult.entries.length > 0) {
        topicId = searchResult.entries[0].id;
        const topicAttrs = searchResult.entries[0].domainAttributes[TOPIC_DOMAIN_ID] as
            | Record<string, unknown>
            | undefined;
        const currentCount = (topicAttrs?.mentionCount as number | undefined) ?? 0;

        await context.updateAttributes(topicId, {
            ...topicAttrs,
            mentionCount: currentCount + 1,
            lastMentionedAt: Date.now(),
        });
    } else {
        topicId = await context.writeMemory({
            content: topicName,
            tags: [TOPIC_TAG],
            ownership: {
                domain: TOPIC_DOMAIN_ID,
                attributes: {
                    name: topicName,
                    status: "active",
                    mentionCount: 1,
                    lastMentionedAt: Date.now(),
                    createdBy: context.domain,
                },
            },
        });
    }

    await context.graph.relate(memoryId, "about_topic", topicId, { domain: context.domain });
}

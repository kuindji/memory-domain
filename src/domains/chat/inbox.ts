import type { OwnedMemory, DomainContext } from "../../core/types.js";
import { CHAT_TAG, CHAT_MESSAGE_TAG } from "./types.js";
import { ensureTag } from "./utils.js";

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
        },
        { entries: entries.length },
    );
}

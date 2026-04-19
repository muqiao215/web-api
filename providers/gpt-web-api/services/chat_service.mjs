export function createChatService({ chatState, browserRuntime, sessionLocks }) {
  async function chatCompletion(messages, options = {}) {
    const target = await chatState.resolveChatTarget(messages, options.conversationId, options.fileIds || [], {
      providerId: options.providerId,
      model: options.model,
    });
    const lockKey = target.affinity?.lock_key || (options.conversationId ? `chat:${options.conversationId}` : "");

    return sessionLocks.run(lockKey, async () => {
      const result = await browserRuntime.chatViaBrowser({
        pageUrl: target.pageUrl,
        prompt: target.prompt,
        files: target.files,
        model: options.model || "chatgpt-web",
      });
      const withConversation = {
        ...result,
        conversation_id: target.conversationId,
      };
      await chatState.storeConversation(target.conversations, target.conversationId, withConversation, {
        providerId: options.providerId,
        model: options.model,
        lockKey: lockKey || `chat:${target.conversationId}`,
      });
      return withConversation;
    });
  }

  async function chatCompletionStream(messages, options = {}, onDelta) {
    const target = await chatState.resolveChatTarget(messages, options.conversationId, options.fileIds || [], {
      providerId: options.providerId,
      model: options.model,
    });
    const lockKey = target.affinity?.lock_key || (options.conversationId ? `chat:${options.conversationId}` : "");

    return sessionLocks.run(lockKey, async () => {
      const result = await browserRuntime.streamChatViaBrowser({
        pageUrl: target.pageUrl,
        prompt: target.prompt,
        files: target.files,
        model: options.model || "chatgpt-web",
        onDelta,
      });
      const withConversation = {
        ...result,
        conversation_id: target.conversationId,
      };
      await chatState.storeConversation(target.conversations, target.conversationId, withConversation, {
        providerId: options.providerId,
        model: options.model,
        lockKey: lockKey || `chat:${target.conversationId}`,
      });
      return withConversation;
    });
  }

  return {
    chatCompletion,
    chatCompletionStream,
    generateImage: browserRuntime.generateImage,
  };
}

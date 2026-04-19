export class ChatGPTWebProvider {
  id = "chatgpt-web";
  name = "ChatGPT Web";
  type = "browser-session";
  capabilities = {
    chat: true,
    streaming: true,
    images: true,
    files: true,
    vision: true,
    image_edits: false,
  };

  constructor({ chatCompletion, chatCompletionStream, generateImage, healthCheck = null }) {
    this.operations = {
      chatCompletion,
      chatCompletionStream,
      generateImage,
      healthCheck,
    };
  }

  models() {
    return [
      { id: "chatgpt-web", object: "model", owned_by: "openai-web", provider: this.id },
      { id: "chatgpt-images", object: "model", owned_by: "openai-web", provider: this.id },
    ];
  }

  descriptor() {
    return {
      id: this.id,
      object: "provider",
      name: this.name,
      type: this.type,
      capabilities: this.capabilities,
      models: this.models().map((model) => model.id),
    };
  }

  chatCompletion(messages, options = {}) {
    return this.operations.chatCompletion(messages, options);
  }

  chatCompletionStream(messages, options = {}, onDelta) {
    return this.operations.chatCompletionStream(messages, options, onDelta);
  }

  generateImage(prompt) {
    return this.operations.generateImage(prompt);
  }

  healthCheck() {
    if (typeof this.operations.healthCheck === "function") {
      return this.operations.healthCheck();
    }
    return Promise.resolve({ ok: true });
  }
}

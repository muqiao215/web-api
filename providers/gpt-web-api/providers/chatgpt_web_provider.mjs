import { INTEGRATION_CLASSES, RUNTIME_TIERS } from "../services/runtime_tier_policy.mjs";

export class ChatGPTWebProvider {
  id = "chatgpt-web";
  name = "ChatGPT Web";
  type = "browser-session";
  runtime_tier = RUNTIME_TIERS.BROWSER_CAPABILITY;
  integration_class = INTEGRATION_CLASSES.REPO_NATIVE_RUNTIME;
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

  defaultImageModel() {
    return "chatgpt-images";
  }

  descriptor() {
    return {
      id: this.id,
      object: "provider",
      name: this.name,
      type: this.type,
      runtime_tier: this.runtime_tier,
      integration_class: this.integration_class,
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

  generateImage(prompt, options = {}) {
    return this.operations.generateImage(prompt, options);
  }

  healthCheck() {
    if (typeof this.operations.healthCheck === "function") {
      return this.operations.healthCheck();
    }
    return Promise.resolve({ ok: true });
  }
}

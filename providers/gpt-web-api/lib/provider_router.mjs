export class ProviderRouter {
  constructor() {
    this.providers = new Map();
    this.defaultProviderId = "";
  }

  register(provider, { isDefault = false } = {}) {
    if (!provider?.id) {
      throw new Error("provider.id is required");
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    if (isDefault || !this.defaultProviderId) {
      this.defaultProviderId = provider.id;
    }
    return provider;
  }

  count() {
    return this.providers.size;
  }

  getProvider(providerId) {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return provider;
  }

  defaultProvider() {
    if (!this.defaultProviderId) {
      throw new Error("No provider registered");
    }
    return this.getProvider(this.defaultProviderId);
  }

  listProviders() {
    return [...this.providers.values()];
  }

  listProviderDescriptors() {
    return this.listProviders().map((provider) => provider.descriptor());
  }

  listModels() {
    return this.listProviders().flatMap((provider) => provider.models());
  }

  getProviderByModel(modelId) {
    if (!modelId) return null;
    return (
      this.listProviders().find((provider) =>
        provider.models().some((model) => model.id === modelId)
      ) || null
    );
  }

  getModel(modelId) {
    const owner = this.getProviderByModel(modelId);
    if (!owner) return null;
    return owner.models().find((model) => model.id === modelId) || null;
  }

  resolveProvider({ providerId = "", modelId = "" } = {}) {
    if (providerId) {
      return this.getProvider(providerId);
    }
    if (!modelId) {
      return this.defaultProvider();
    }

    const owner = this.getProviderByModel(modelId);
    if (!owner) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    return owner;
  }
}

function queueRuntime(getQueueDepth, getSessionLockCount) {
  return {
    queue_depth: getQueueDepth(),
    session_locks: getSessionLockCount(),
  };
}

export function createProviderAdminService({
  providerRouter,
  inspectBrowserReadiness,
  getQueueDepth,
  getSessionLockCount,
  jobsPath,
  sessionAffinityPath,
  mediaPath,
  outputDir,
  uploadDir,
  cdpHttp,
}) {
  function getModel(modelId) {
    const model = providerRouter.getModel(modelId);
    if (!model) return null;
    const provider = providerRouter.getProviderByModel(modelId);
    const descriptor = provider.descriptor();
    return {
      ...model,
      provider_name: descriptor.name,
      provider_type: descriptor.type,
      capabilities: descriptor.capabilities,
    };
  }

  async function providerHealth(provider) {
    if (typeof provider.healthCheck === "function") {
      return provider.healthCheck();
    }
    return inspectBrowserReadiness();
  }

  async function getProviderDetail(providerId) {
    const provider = providerRouter.getProvider(providerId);
    const descriptor = provider.descriptor();
    const health = await providerHealth(provider);
    return {
      ...descriptor,
      models: provider.models().map((model) => model.id),
      model_details: provider.models(),
      health,
      runtime: queueRuntime(getQueueDepth, getSessionLockCount),
      paths: {
        jobs: jobsPath,
        session_affinity: sessionAffinityPath,
        media: mediaPath,
        output_dir: outputDir,
        upload_dir: uploadDir,
      },
      transport: {
        cdp_http: cdpHttp,
      },
    };
  }

  async function listProviderDetails() {
    return {
      object: "list",
      data: await Promise.all(providerRouter.listProviders().map((provider) => getProviderDetail(provider.id))),
    };
  }

  async function readiness() {
    const browser = await inspectBrowserReadiness();
    return {
      ok: true,
      service: "gpt_web_api",
      provider_count: providerRouter.count(),
      queue_depth: getQueueDepth(),
      session_locks: getSessionLockCount(),
      browser,
    };
  }

  function health() {
    return {
      ok: true,
      service: "gpt_web_api",
      cdp: cdpHttp,
      provider_count: providerRouter.count(),
      providers: providerRouter.listProviderDescriptors().map((item) => ({
        id: item.id,
        type: item.type,
        capabilities: item.capabilities,
        models: item.models,
      })),
      queue_depth: getQueueDepth(),
      session_locks: getSessionLockCount(),
      jobs_path: jobsPath,
      session_affinity_path: sessionAffinityPath,
      image_output_dir: outputDir,
      upload_dir: uploadDir,
      media_index_path: mediaPath,
    };
  }

  return {
    getModel,
    getProviderDetail,
    listProviderDetails,
    readiness,
    health,
  };
}

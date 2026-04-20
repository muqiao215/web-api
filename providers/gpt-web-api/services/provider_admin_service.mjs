export function createProviderAdminService({
  providerRouter,
  inspectBrowserReadiness,
  inspectRuntimeStatus,
  getQueueDepth,
  getQueueStats = () => ({ pending: null, running: null, total: null }),
  getSessionLockCount,
  jobsPath,
  sessionAffinityPath,
  mediaPath,
  outputDir,
  uploadDir,
  cdpHttp,
}) {
  function queueMetrics() {
    const stats = getQueueStats() || {};
    return {
      queue_depth: getQueueDepth(),
      session_locks: getSessionLockCount(),
      pending: Number.isInteger(stats.pending) ? stats.pending : null,
      running: Number.isInteger(stats.running) ? stats.running : null,
      total: Number.isInteger(stats.total) ? stats.total : null,
      // Phase 4: account pool — these require provider_pool package
      account_id: null,
      profile_lock: null,
      lease: null,
    };
  }

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
    const runtimeContract = typeof inspectRuntimeStatus === "function" ? await inspectRuntimeStatus() : null;
    return {
      ...descriptor,
      models: provider.models().map((model) => model.id),
      model_details: provider.models(),
      health,
      runtime: queueMetrics(),
      runtime_contract: runtimeContract,
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
    const runtimeContract = typeof inspectRuntimeStatus === "function" ? await inspectRuntimeStatus() : null;
    return {
      ok: true,
      service: "gpt_web_api",
      provider_count: providerRouter.count(),
      queue_depth: getQueueDepth(),
      session_locks: getSessionLockCount(),
      browser,
      runtime_contract: runtimeContract,
    };
  }

  async function health() {
    const runtimeContract = typeof inspectRuntimeStatus === "function" ? await inspectRuntimeStatus() : null;
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
      account_id: null,
      profile_lock: null,
      lease: null,
      jobs_path: jobsPath,
      session_affinity_path: sessionAffinityPath,
      image_output_dir: outputDir,
      upload_dir: uploadDir,
      media_index_path: mediaPath,
      runtime_contract: runtimeContract,
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

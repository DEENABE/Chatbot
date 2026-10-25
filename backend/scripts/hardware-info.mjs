import { getHardwareProfile } from '../src/services/gpuProfile.js';

try {
  const profile = await getHardwareProfile();
  if (process.argv.includes('--json')) console.log(JSON.stringify(profile, null, 2));
  else {
    console.log('Chanakya automatic hardware profile (read-only)');
    console.log(
      `CPU: ${profile.cpu?.model || 'Unknown'} (${profile.cpu?.logicalCores || '?'} logical cores)`,
    );
    console.log(
      `RAM: ${((profile.memory?.totalBytes || 0) / 1024 ** 3).toFixed(1)} GB total, ${((profile.memory?.freeBytes || 0) / 1024 ** 3).toFixed(1)} GB currently free`,
    );
    for (const gpu of profile.gpus || [])
      console.log(
        `Display adapter: ${gpu.name}${gpu.vramMiB ? ` (${Math.round(gpu.vramMiB)} MiB reported memory)` : ''}`,
      );
    if (!profile.gpus?.length)
      console.log('No GPU adapter was confirmed. CPU inference remains available.');
    console.log(
      `Verified model execution: ${profile.acceleration?.verified ? profile.acceleration.mode : 'not yet observed'}`,
    );
    console.log(
      `Current hardware context ceiling: ${profile.maxContext} tokens (the selected model may use less).`,
    );
    console.log(
      'The app adapts model/context settings to this computer. Ollama selects supported GPU acceleration or CPU execution.',
    );
    const overrides = [
      'OLLAMA_LLM_LIBRARY',
      'CUDA_VISIBLE_DEVICES',
      'ROCR_VISIBLE_DEVICES',
      'GGML_VK_VISIBLE_DEVICES',
      'OLLAMA_FLASH_ATTENTION',
      'OLLAMA_KV_CACHE_TYPE',
      'OLLAMA_GPU_OVERHEAD',
      'GPU_MAX_CONTEXT',
      'GPU_PROFILE',
    ].filter((name) => process.env[name]);
    if (overrides.length)
      console.log(
        `Existing machine overrides: ${overrides.join(', ')}. This inspection does not change them.`,
      );
    console.log(
      'No settings were persisted, no software was downloaded, and no running Ollama process was stopped.',
    );
  }
} catch (error) {
  console.error(`Hardware inspection failed: ${error.message}`);
  process.exitCode = 1;
}

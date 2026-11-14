/** Use the live model's advertised options. Never turn configuration errors into warnings. */
export async function configureAntigravitySession({ peer, sessionId, session, config, currentOptions }) {
  const mode = await peer.call('session/set_mode', { sessionId, modeId: 'default' });
  let options = mode?.configOptions ?? currentOptions() ?? session.configOptions;
  if (config.model) {
    if (!session.models?.availableModels?.some(model => model.modelId === config.model)) throw new Error('Configured ACP model unavailable');
    const selected = await peer.call('session/set_model', { sessionId, modelId: config.model });
    options = selected?.configOptions ?? currentOptions() ?? options;
  }
  const thought = options?.find(option => option.id === 'thought_level' || option.category === 'thought_level');
  const choices = thought?.options?.flatMap(option => Array.isArray(option.options) ? option.options : [option]);
  if (!choices?.some(option => option.value === config.effort)) throw new Error('ACP thinking option unavailable for selected model');
  if (thought.currentValue === config.effort) return;
  // Use the option's advertised ID, not its semantic category.
  await peer.call('session/set_config_option', { sessionId, configId: thought.id, value: config.effort });
}

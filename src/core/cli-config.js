import { normalizeAntigravityConfig } from '../antigravity-cli/config.js';
import { normalizeCodexConfig } from '../codex-cli/config.js';
const backends = { antigravityCli: normalizeAntigravityConfig, codexCli: normalizeCodexConfig };
/** Invalid persisted settings stay repairable and never start a backend. */
export function loadCliConfigs(config) {
  for (const [key, normalize] of Object.entries(backends)) {
    try { config[key] = normalize(config[key]); }
    catch { config[key] = { ...config[key], enabled: false }; }
  }
  if (config.codexCli.enabled && config.antigravityCli.enabled) config.codexCli.enabled = false;
}
/** Reject conflicting runtime owners and validate feature-only patches. */
export function validateCliConfigs(config, patch, invalidConfig) {
  for (const [key, normalize] of Object.entries(backends)) {
    try { config[key] = normalize(config[key]); }
    catch (error) { if (Object.hasOwn(patch, key) || config[key]?.enabled) throw invalidConfig(error.message); }
  }
  if (config.codexCli?.enabled && config.antigravityCli?.enabled) throw invalidConfig('请先停用另一个 CLI 后端');
}

export { CODEX_DEFAULTS } from '../codex-cli/config.js';

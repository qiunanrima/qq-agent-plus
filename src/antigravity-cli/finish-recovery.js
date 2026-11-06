import { blocksToolFinish } from '../tools/tool-outcome.js';
// A CLI turn has many sequential calls, unlike one API tool batch. A known
// read failure can be acknowledged; failed/partial/unknown writes cannot.
const reads = new Set(['antigravity_quota', 'read_image_text', 'get_message_images', 'search_web', 'fetch_url',
  'knowledge_search', 'memory_query', 'person_memory_lookup', 'persona_background_lookup',
  'personality_lookup', 'hippocampus_lookup', 'memory_card_list', 'memory_card_lookup',
  'semantic_memory_lookup', 'list_stickers', 'get_active_members']);

export function createCliFinishRecovery() {
  let readFailure = false, blockingFailure = false;
  return {
    observe(name, result, blocked = false) {
      if (blocked || !blocksToolFinish(result)) return;
      if (reads.has(name) && !result.partialFailure) readFailure = true;
      else blockingFailure = true;
    },
    canAcknowledge(args, { visibleReply = false, uncertain = false } = {}) {
      return args?.errorAcknowledged === true && readFailure && !blockingFailure && visibleReply && !uncertain;
    }
  };
}

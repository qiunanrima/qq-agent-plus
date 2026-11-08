// Common Agent capabilities. Protocol-specific writes stay in their adapter.
export const COMMON_CHAT_TOOLS = new Set([
  'send_message', 'finish', 'get_recent_messages', 'get_message_detail',
  'get_message_images',
  'memory_query', 'person_memory_lookup', 'memory_card_list', 'memory_card_lookup',
  'hippocampus_lookup', 'personality_lookup', 'persona_background_lookup',
  'search_web', 'fetch_url', 'knowledge_search', 'meme_lookup',
  'skill_list', 'skill_use', 'antigravity_quota'
]);

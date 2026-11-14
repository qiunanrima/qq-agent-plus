// Host policies also cover already-installed official plugin manifests.
// Console tools use their separate authenticated entry point.
export function pluginChatToolAllowed(pluginId, toolName, settings = {}, chatKey = '', ownerUin = '') {
  if (pluginId !== 'xiaomi-health') return true;
  if (toolName === 'login') return false;
  if (toolName === 'query') {
    return settings.acceptUnofficial === true && settings.allowAgentRead === true
      && Boolean(ownerUin) && chatKey === `private:${ownerUin}`;
  }
  return false;
}

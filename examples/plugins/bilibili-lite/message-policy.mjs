export function uidList(value) {
  const items = String(value ?? '').trim().split(/[\s,，;；]+/).filter(Boolean);
  if (items.length > 100 || items.some((id) => !/^[1-9]\d{0,24}$/.test(id))) throw new Error('白名单仅允许 B 站数字 UID，最多100个，用空格或逗号分隔');
  return [...new Set(items)];
}

export function allowsUid(settings, direction, mid) {
  if (!/^[1-9]\d{0,24}$/.test(String(mid))) return false;
  if (settings?.[`${direction}WhitelistEnabled`] === false) return true;
  return uidList(settings?.[`${direction}Uids`]).includes(String(mid));
}

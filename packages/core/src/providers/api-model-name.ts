/**
 * 发给供应商的模型名。注册表 id 可能带 `providerId/` 前缀以免两家撞名。
 */

export function apiModelName(model: { readonly id: string; readonly providerId: string }): string {
  const prefix = `${model.providerId}/`;
  return model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
}

export function namespacedModelId(providerId: string, rawId: string): string {
  if (rawId.startsWith(`${providerId}/`)) return rawId;
  return `${providerId}/${rawId}`;
}

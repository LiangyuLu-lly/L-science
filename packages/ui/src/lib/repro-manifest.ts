/**
 * 可复现包清单。先给人一份能复制的账本；不把缺血缘的图说成可复现。
 */

export type ReproArtifact = {
  readonly id: string;
  readonly filename: string;
  readonly reproducible: boolean;
  readonly versionCount: number;
  readonly deletedAt: number | null;
};

export function formatReproManifest(input: {
  readonly projectId: string;
  readonly exportedAt: number;
  readonly artifacts: readonly ReproArtifact[];
}): string {
  const live = input.artifacts.filter((a) => a.deletedAt === null);
  const bad = live.filter((a) => !a.reproducible);
  const lines = [
    '# L-science 可复现清单',
    '',
    `- 项目：${input.projectId}`,
    `- 导出时间：${new Date(input.exportedAt).toISOString()}`,
    `- 制品数：${String(live.length)}`,
    `- 血缘不完整：${String(bad.length)}`,
    '',
  ];
  for (const artifact of live) {
    const flag = artifact.reproducible ? '可复现' : '血缘不完整';
    lines.push(`- ${artifact.filename} (${artifact.id}) ${flag} · ${String(artifact.versionCount)} 个版本`);
  }
  return `${lines.join('\n')}\n`;
}

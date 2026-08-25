/**
 * Artifact Store（需求 6）。
 *
 * 四层：内容寻址 blob 存储、版本与血缘、`{{artifact:...}}` 标记解析、
 * 保存与删除工具。
 *
 * 贯穿全部四层的一条约定：**更新即新版本，删除是软删除**。论文写作里最需要的
 * 就是「投稿时用的是哪一版、它是哪段代码跑出来的」，覆盖或物理删除会毁掉这个
 * 问题的答案，而且不留任何痕迹表明曾经存在过。空间是可以回收的，血缘断了
 * 补不回来。
 */

export { BlobStore, hashBuffer, hashFile } from './blob-store.js';
export type { BlobRecord } from './blob-store.js';

export { ArtifactStore, assessReproducibility, inferKind } from './store.js';
export type {
  ArtifactKind,
  ArtifactRecord,
  ArtifactVersion,
  CodeLineage,
  DeleteCandidate,
  LineageNode,
  LineageRelation,
  SaveResult,
  SaveVersionInput,
} from './store.js';

export { escapePath, findMarkers, formatRejections, resolveMarkers } from './marker.js';
export type { MarkerOccurrence, ResolveMarkersOptions, ResolveMarkersResult } from './marker.js';

export { createDeleteArtifactsTool, createSaveArtifactsTool, humanBytes } from './tools.js';
export type {
  DeleteArtifactsInput,
  DeleteArtifactsToolOptions,
  SaveArtifactsInput,
  SaveArtifactsToolOptions,
} from './tools.js';

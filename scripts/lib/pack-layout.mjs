/**
 * extraResources copies ONLY these three trees; never repo-root node_modules.
 *
 *   vendor/node-win-x64   → node/           (node.exe)
 *   release/sidecar-stage → sidecar/app     (packages/core/dist/backend.js)
 *   skills/builtin        → skills/builtin
 */

export const nodeDir = 'node';
export const sidecarApp = 'sidecar/app';
export const backendRel = 'packages/core/dist/backend.js';
export const skillsBuiltin = 'skills/builtin';
export const vendorNode = 'vendor/node-win-x64';
export const sidecarStage = 'release/sidecar-stage';

export const extraResourceSources = Object.freeze([
  vendorNode,
  sidecarStage,
  skillsBuiltin,
]);

export const packLayout = Object.freeze({
  nodeDir,
  sidecarApp,
  backendRel,
  skillsBuiltin,
  vendorNode,
  sidecarStage,
});

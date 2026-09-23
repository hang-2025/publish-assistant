import { RELEASE_INFO } from './release-info.generated.mjs';

export const SERVICE_VERSION = RELEASE_INFO.serviceVersion;
export const LOCAL_PROTOCOL = Object.freeze({
  name: RELEASE_INFO.protocol.name,
  version: RELEASE_INFO.protocol.version,
});
export const ACCEPTANCE_BUILD = Object.freeze({
  packageVersion: RELEASE_INFO.packageVersion,
  id: RELEASE_INFO.buildId,
  extensionBuildId: RELEASE_INFO.buildId,
});

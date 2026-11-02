import { packageName } from '@openbots/shared';

export const PACKAGE_NAME = packageName('models');

export {
  DEFAULT_CAPABILITIES,
  missingCapabilities,
  modelSupports,
  type ModelCapabilities,
  type ModelNeed,
  type ModelPricing,
  type ProviderTestResult,
} from '@openbots/shared';
export * from './adapters.js';
export * from './catalog.js';
export * from './cost.js';
export * from './discover.js';
export * from './reasoning.js';
export * from './registry.js';
export * from './test-provider.js';
export * from './tool-names.js';

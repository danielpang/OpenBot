const fs = require('node:fs');
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.unstable_conditionNames = [
  '@openbots/source',
  ...config.resolver.unstable_conditionNames,
];
// Workspace source follows NodeNext's emitted .js specifiers; Metro needs the
// corresponding TypeScript source. Limit this rewrite to our own packages.
config.resolver.resolveRequest = (context, name, platform) => {
  if (
    context.originModulePath.includes(`${path.sep}packages${path.sep}`) &&
    name.startsWith('.') &&
    name.endsWith('.js')
  ) {
    const stem = path.resolve(path.dirname(context.originModulePath), name.slice(0, -3));
    for (const extension of ['.ts', '.tsx']) {
      if (fs.existsSync(stem + extension))
        return context.resolveRequest(context, stem + extension, platform);
    }
  }
  return context.resolveRequest(context, name, platform);
};
module.exports = config;

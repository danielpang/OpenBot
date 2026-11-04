module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/*.native.spec.tsx'],
  moduleNameMapper: {
    '^@babel/runtime/(.*)$': require('node:path').join(
      require('node:path').dirname(
        require.resolve('@babel/runtime/package.json', {
          paths: [require.resolve('react-native/package.json')],
        }),
      ),
      '$1',
    ),
    '^@openbots/([^/]+)$': '<rootDir>/../../packages/$1/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?(?:(?:jest-)?react-native|@react-native|expo(?:nent)?|@expo(?:nent)?/.*|react-navigation|@react-navigation/.*|react-native-svg))',
  ],
};

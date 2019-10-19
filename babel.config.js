module.exports = {
  'presets': [ '@babel/env', '@babel/preset-typescript' ],
  'env': {
    'production': {
      'presets': ['minify'],
    },
  },
  'plugins': [
    ['@babel/plugin-proposal-decorators', { 'legacy': true }],
    '@babel/plugin-proposal-class-properties',
    '@babel/plugin-proposal-function-bind',
    '@babel/plugin-transform-destructuring',
    '@babel/plugin-proposal-object-rest-spread',
    '@babel/plugin-transform-runtime',
    '@babel/plugin-syntax-dynamic-import',
    ['@babel/plugin-transform-modules-commonjs', {
      'allowTopLevelThis': true,
    }],
    '@babel/plugin-proposal-function-sent',
    '@babel/plugin-proposal-throw-expressions',
  ],
}

'use strict';

// Ai SAY ESLint flat config.
// Goals:
// 1) No new hard errors in existing CommonJS server code.
// 2) Catch empty catch blocks / obvious bugs.
// 3) Keep formatting separate from Prettier.
module.exports = [
  {
    ignores: [
      'node_modules/',
      'data/',
      'backups/',
      'platform/',
      'logs/',
      'undefined/',
      'docs/',
      '*.log',
      'console.log'
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly'
      }
    },
    rules: {
      // Project hard rules.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-func-assign': 'error',
      'no-inner-declarations': 'warn',
      'no-fallthrough': 'warn',
      // Low-noise style suggestions only.
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'warn'
    }
  },
  {
    files: ['tests/**/*.js', 'server/**/*.test.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        assert: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly'
      }
    }
  }
];

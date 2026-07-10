module.exports = {
  extends: ['stylelint-config-standard-scss'],
  rules: {
    'at-rule-no-unknown': null,
    'scss/at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: ['tailwind', 'apply', 'layer', 'screen', 'responsive']
      }
    ],
    'selector-class-pattern': null,
    'no-descending-specificity': null
  },
  ignoreFiles: ['**/node_modules/**', '**/dist/**']
};

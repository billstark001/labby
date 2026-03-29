import type { I18nConfig } from './scripts/i18n-gen'

export default {
  languages: ['en', 'zh-CN', 'ja-JP'],
  defaultLang: 'en',
  files: [
    './i18n/common.yaml',
  ],
  output: {
    mode: 'single',       // or 'multiple'
    dir: './src/generated',
    filename: 'translations',
  },
} satisfies I18nConfig
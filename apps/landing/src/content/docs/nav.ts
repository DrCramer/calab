// Docs navigation (ADR-0099 §1): sections → pages by slug, labels in Russian and English.
// PLACEHOLDER from DOC1 (platform): DOC2 replaces this file and the placeholder pages with the real content.
export const nav: { slug: string; section: { ru: string; en: string }; pages: { slug: string; ru: string; en: string }[] }[] = [
  {
    slug: 'overview',
    section: { ru: 'Обзор', en: 'Overview' },
    pages: [
      { slug: 'introduction', ru: 'Что можно интегрировать', en: 'What you can integrate' },
      { slug: 'concepts', ru: 'Основные понятия', en: 'Concepts' },
    ],
  },
  {
    slug: 'bots',
    section: { ru: 'Боты и API', en: 'Bots and API' },
    pages: [
      { slug: 'quickstart', ru: 'Быстрый старт', en: 'Quickstart' },
      { slug: 'gateway', ru: 'Gateway', en: 'Gateway' },
      { slug: 'webhooks', ru: 'Вебхуки', en: 'Webhooks' },
    ],
  },
  {
    slug: 'oauth',
    section: { ru: 'OAuth 2 / OIDC', en: 'OAuth 2 / OIDC' },
    pages: [
      { slug: 'flow', ru: 'Authorization Code + PKCE', en: 'Authorization Code + PKCE' },
      { slug: 'tokens', ru: 'Токены и сроки', en: 'Tokens and lifetimes' },
    ],
  },
  {
    slug: 'sso',
    section: { ru: 'SSO и каталог', en: 'SSO and directory' },
    pages: [
      { slug: 'oidc', ru: 'Подключение OIDC', en: 'Connecting OIDC' },
      { slug: 'directory', ru: 'Каталог LDAPS', en: 'LDAPS directory' },
    ],
  },
  {
    slug: 'reference',
    section: { ru: 'Справочник', en: 'Reference' },
    pages: [
      { slug: 'routes', ru: 'Маршруты ботов', en: 'Bot routes' },
      { slug: 'errors', ru: 'Коды ошибок', en: 'Error codes' },
    ],
  },
];

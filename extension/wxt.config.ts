import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// Public key of the extension's signing pair (~/.dayflow/extension-key.pem stays out of the repo). It pins the
// extension id to jagkpbdiempedibinmfafamdhnogognn, which the Google OAuth client is registered against.
const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6TqRPFlEsVJRB1n3pm2GGgE2txWcwUypIR1Q3TAtOSAXb6usnhTqGJCkygqG654hmOktAKKKQR8xbVuWkTOpqYpUVpHuk9zIzgYahVO1ZRVCjB6TQgk03vb++/3IqUm7ZSZP865B06YOUPs6aS6UekFXh/6mN9pcZyC1V01nJQmJX1Uh1UOmSdQZV0yzi1+bwZR4zAFJkKUKqvSFHVLIrfxEWh9VgenSm1xwLp6UEVcADgjwJnvUXILfQLU7eQV7J6rPMUuG4jGq4eqU1gHzHv1ZEqUVkoY8awWQeWeqhOve8WtO33fNV3ls/HdisKzZR6QDkcKD25OA37PT8eYkrQIDAQAB';

// https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  // Function form: .env files are loaded before it runs, so VITE_GOOGLE_CLIENT_ID is available.
  manifest: () => ({
    name: 'Dayflow Agent',
    description: 'A universal browser agent on Gemini: skills, site profiles and permissions you own. Default pack: KBTU student ops.',
    minimum_chrome_version: '116',
    key: EXTENSION_PUBLIC_KEY,
    permissions: ['storage', 'alarms', 'sidePanel', 'tabs', 'scripting', 'downloads', 'notifications', 'webNavigation', 'activeTab', 'identity'],
    host_permissions: ['<all_urls>'],
    oauth2: {
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID || 'unset.apps.googleusercontent.com',
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    },
    action: { default_title: 'Open Dayflow' },
  }),
});

import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'Dayflow Agent',
    description: 'Your student ops agent, living in Chrome: syncs WSP files, builds courseware, bootstraps projects, runs team ops.',
    minimum_chrome_version: '116',
    permissions: [
      'storage',
      'alarms',
      'sidePanel',
      'tabs',
      'scripting',
      'downloads',
      'notifications',
      'webNavigation',
      'activeTab',
    ],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Open Dayflow' },
  },
});

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  if (mode === 'pages') {
    const env = loadEnv(mode, process.cwd(), 'VITE_');
    const url = URL.parse(env.VITE_SUPABASE_URL ?? '');
    if (!url || url.protocol !== 'https:' || url.href !== url.origin + '/') {
      throw new Error('VITE_SUPABASE_URL must be the Supabase project HTTPS origin');
    }
    if (!env.VITE_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_')) {
      throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY must be the public project key');
    }
  }
  return {
    base: mode === 'pages' ? '/odd-scoring/' : '/',
    plugins: [react()],
    server: {
      proxy: { '/api': 'http://localhost:3000' },
    },
  };
});

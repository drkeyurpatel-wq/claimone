import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"DM Sans"', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
} satisfies Config;

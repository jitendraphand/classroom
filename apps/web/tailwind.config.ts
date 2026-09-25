import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef7ff',
          100: '#d9ecff',
          200: '#bcdcff',
          300: '#8ec6ff',
          400: '#59a6ff',
          500: '#3385ff',
          600: '#1a66f5',
          700: '#1450e1',
          800: '#1742b6',
          900: '#193a8f',
          950: '#122457',
        },
        surface: {
          0: '#0a0d14',
          1: '#10151f',
          2: '#161c2a',
          3: '#1d2536',
          4: '#273148',
        },
        ink: {
          50: '#f7f8fa',
          100: '#eef0f4',
          200: '#d8dce5',
          300: '#b4bbc9',
          400: '#8893a8',
          500: '#69768d',
          600: '#535e73',
          700: '#444d5e',
          800: '#3b4250',
          900: '#343942',
          950: '#1c1f26',
        },
        success: {
          DEFAULT: '#22c55e',
          soft: 'rgba(34, 197, 94, 0.14)',
          fg: '#86efac',
        },
        warning: {
          DEFAULT: '#f59e0b',
          soft: 'rgba(245, 158, 11, 0.14)',
          fg: '#fcd34d',
        },
        danger: {
          DEFAULT: '#ef4444',
          soft: 'rgba(239, 68, 68, 0.14)',
          fg: '#fca5a5',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
        '3xl': '1.5rem',
      },
      boxShadow: {
        soft: '0 8px 30px rgba(0,0,0,0.18)',
        lift: '0 12px 40px rgba(0,0,0,0.28)',
        glow: '0 0 0 1px rgba(51,133,255,0.28), 0 8px 28px rgba(51,133,255,0.18)',
        ring: '0 0 0 3px rgba(51,133,255,0.28)',
        dock: '0 -8px 32px rgba(0,0,0,0.35)',
      },
      spacing: {
        18: '4.5rem',
        22: '5.5rem',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { transform: 'scale(0.92)', opacity: '0.7' },
          '70%': { transform: 'scale(1.15)', opacity: '0' },
          '100%': { transform: 'scale(1.15)', opacity: '0' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        shimmer: 'shimmer 1.4s infinite',
      },
    },
  },
  plugins: [],
};
export default config;

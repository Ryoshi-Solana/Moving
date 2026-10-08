import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: '#0A121C',
        panel: '#121D29',
        raised: '#1B2733',
        edge: 'rgba(110, 168, 178, 0.16)',
        'edge-soft': 'rgba(110, 168, 178, 0.09)',
        'edge-strong': 'rgba(110, 168, 178, 0.30)',
        mint: '#00E5A0',
        amber: '#F2B441',
        rose: '#FF5C72',
        ink: '#ECF2F6',
        muted: '#8496A6',
        faint: '#576A7A'
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)']
      },
      letterSpacing: {
        display: '-0.04em',
        tightest: '-0.045em'
      },
      maxWidth: {
        readable: '64ch'
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        sweep: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(320%)' }
        },
        breathe: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' }
        }
      },
      animation: {
        'fade-up': 'fade-up 300ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 260ms ease-out both',
        sweep: 'sweep 1.5s linear infinite',
        breathe: 'breathe 2.4s ease-in-out infinite'
      }
    }
  },
  plugins: []
};

export default config;

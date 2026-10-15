import type { Config } from 'tailwindcss';

/**
 * MOVING design tokens.
 *
 * Graphite surfaces with a faint green cast (from the logo's emerald→teal
 * ribbon). Colour carries meaning only:
 *   teal  — interactive / brand
 *   mint  — positive change
 *   rose  — negative change
 *   amber — caution / partial data
 *   lime  — the single "live data" signal; used almost nowhere else
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: '#080C0D',
        panel: '#0E1416',
        raised: '#141C1F',
        sunken: '#0A0F10',
        edge: 'rgba(158, 204, 196, 0.12)',
        'edge-soft': 'rgba(158, 204, 196, 0.07)',
        'edge-strong': 'rgba(158, 204, 196, 0.24)',
        teal: '#2EE6D6',
        mint: '#22F0A0',
        lime: '#D4FF3A',
        amber: '#F4B740',
        rose: '#FF6B7D',
        ink: '#E8F0EE',
        muted: '#90A29E',
        faint: '#5F706C'
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace']
      },
      letterSpacing: {
        display: '-0.035em',
        tightest: '-0.05em'
      },
      maxWidth: {
        readable: '64ch',
        shell: '1240px'
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
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
        },
        draw: {
          from: { strokeDashoffset: '1' },
          to: { strokeDashoffset: '0' }
        }
      },
      animation: {
        'fade-up': 'fade-up 380ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 260ms ease-out both',
        sweep: 'sweep 1.6s linear infinite',
        breathe: 'breathe 2.4s ease-in-out infinite',
        draw: 'draw 900ms cubic-bezier(0.65, 0, 0.35, 1) both'
      }
    }
  },
  plugins: []
};

export default config;

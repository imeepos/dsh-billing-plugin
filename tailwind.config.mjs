/** Tailwind config for the billing widget client bundle. Colours map to the
 * dsh theme alias tokens (CSS variables) so the widget follows the active
 * theme (light/dark) automatically. Preflight is off: the widget must not
 * reset the host app's global styles. */
export default {
  content: ['./src/client/index.tsx'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        'bg-overlay': 'var(--dsw-alias-bg-overlay)',
        'border-l1': 'var(--dsw-alias-border-l1)',
        'border-l2': 'var(--dsw-alias-border-l2)',
        'label-primary': 'var(--dsw-alias-label-primary)',
        'label-secondary': 'var(--dsw-alias-label-secondary)',
        'brand': 'var(--dsw-alias-brand-primary)',
        'warn': 'var(--dsw-alias-state-warn-primary)',
        'error': 'var(--dsw-alias-state-error-primary)',
        'success': 'var(--dsw-alias-state-success-primary)',
      },
    },
  },
  plugins: [],
}

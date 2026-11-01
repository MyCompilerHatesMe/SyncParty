/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,html,css}'],
  theme: {
    extend: {
      colors: {
        brand: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },
      },
    },
  },
  plugins: [],
};

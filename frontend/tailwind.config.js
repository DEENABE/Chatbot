/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#09090a', 900: '#0f0f11', 850: '#141416', 800: '#19191c', 700: '#252529' },
        gold: { 300: '#e8cf8b', 400: '#d9b75f', 500: '#bd9134', 600: '#967024' }
      },
      boxShadow: { gold: '0 0 40px rgba(189,145,52,.14)' },
      fontFamily: { sans: ['Inter', 'Segoe UI', 'sans-serif'], serif: ['Georgia', 'serif'] }
    }
  },
  plugins: []
};

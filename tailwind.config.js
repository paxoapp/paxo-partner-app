/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Shared brand amber. `accent` is for filled primary actions (dark text
        // sits on top); `accent.ink` is the readable amber for text/icons on the
        // app's light (stone-50) background. Status badges keep their own
        // semantic colors — amber is for actions, not states.
        accent: { DEFAULT: "#F5A623", ink: "#9A5F0F" },
      },
      fontFamily: {
        // Same pairing as the customer app: Space Grotesk display, Inter body.
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        serif: ['"Space Grotesk"', "ui-sans-serif", "system-ui", "sans-serif"],
        display: ['"Space Grotesk"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
}

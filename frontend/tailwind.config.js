/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#f8f9fa", // page background
          1: "#ffffff", // header / card background
          2: "#ffffff", // card background
          3: "#f9fafb", // subtle section / hover background
          4: "#f3f4f6", // tag / counter background
        },
      },
      boxShadow: {
        card: "0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.04)",
        "card-hover": "0 4px 12px 0 rgb(0 0 0 / 0.08), 0 2px 4px -2px rgb(0 0 0 / 0.05)",
      },
      keyframes: {
        "slide-in": {
          "0%":   { opacity: "0", transform: "translateY(-6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "toast-in": {
          "0%":   { opacity: "0", transform: "translateY(10px) scale(0.97)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        pulse_dot: {
          "0%, 100%": { opacity: "1" },
          "50%":      { opacity: "0.4" },
        },
      },
      animation: {
        "slide-in": "slide-in 0.2s ease-out forwards",
        "toast-in": "toast-in 0.2s ease-out forwards",
        pulse_dot:  "pulse_dot 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

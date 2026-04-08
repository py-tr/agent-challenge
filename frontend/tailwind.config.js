/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#08080f",
          1: "#0f0f1a",
          2: "#14141f",
          3: "#1a1a28",
          4: "#20202f",
        },
      },
      keyframes: {
        "fade-out": {
          "0%": { opacity: "1", transform: "scale(1)" },
          "100%": { opacity: "0", transform: "scale(0.97)" },
        },
        "slide-in": {
          "0%": { opacity: "0", transform: "translateY(-8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulse_dot: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.3" },
        },
      },
      animation: {
        "fade-out": "fade-out 0.3s ease-out forwards",
        "slide-in": "slide-in 0.25s ease-out forwards",
        pulse_dot: "pulse_dot 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#FAF7F2",
        ink: "#0A0A0A",
        muted: "#5C5C5C",
        accent: "#0066cc",
        line: "#E8E2D7",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
      },
      maxWidth: {
        page: "1120px",
      },
    },
  },
  plugins: [],
};
export default config;

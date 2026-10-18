import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "data/**",
      "playwright-report/**",
      "test-results/**",
      ".move-cache/**",
      "output/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-undef": "off",
      "preserve-caught-error": "off",
    },
  },
);

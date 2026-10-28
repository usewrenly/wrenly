// Reuse the API's shared TypeScript lint boundary.
import { config } from "@repo/eslint-config/base";
export default [
  ...config,
  {
    files: ["**/*.ts"],
    // TypeScript resolves declarations/type imports; core JS scope rules do not.
    rules: { "no-undef": "off", "no-unused-vars": "off" },
  },
  { ignores: ["dist/**"] },
];

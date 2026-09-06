// ESLint 9 flat config for the whole workspace.
//
// The one rule that matters most is the barrel ban. Finderly's SPA went blank
// in production because the web bundle imported a shared package's barrel,
// which re-exported server-only code. The packages here export subpaths only
// (no "." entry), so a bare specifier already fails to resolve; this rule
// turns that into a readable message at lint time. CI runs `pnpm lint` on
// every PR — a lint rule nobody runs is not a rule.
import expoConfig from "eslint-config-expo/flat.js";
import tseslint from "typescript-eslint";

const BANNED_BARRELS = ["@keepsake/contracts", "@keepsake/tokens", "@keepsake/observability"];

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.expo/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "apps/api/seeds/**",
      "apps/api/worker-configuration.d.ts",
      "apps/web/expo-env.d.ts",
    ],
  },
  ...expoConfig.map((c) => ({ ...c, files: c.files ?? ["apps/web/**/*.{ts,tsx,js,jsx,mjs}"] })),
  {
    // `@/` is a tsconfig path alias (apps/web/tsconfig.json) that tsc already
    // verifies; eslint-plugin-import's node resolver cannot see it.
    files: ["apps/web/**/*.{ts,tsx,js,jsx,mjs}"],
    rules: { "import/no-unresolved": ["error", { ignore: ["^@/"] }] },
  },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["apps/api/**/*.ts", "packages/**/*.ts", "tools/**/*.{mjs,ts}"],
  })),
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: BANNED_BARRELS.map((name) => ({
            name,
            message: `Import a subpath (${name}/<module>). The bare barrel is banned: see docs/design/README.md#barrel-ban.`,
          })),
        },
      ],
    },
  },
];

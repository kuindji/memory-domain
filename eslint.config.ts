import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["node_modules/", "dist/", "scripts/", "*.js"],
    },

    eslint.configs.recommended,

    ...tseslint.configs.recommendedTypeChecked,

    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },

    {
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
        },
    },

    {
        files: ["tests/**/*.ts"],
        rules: {
            "@typescript-eslint/no-floating-promises": "off",
            // bun-types types `.rejects` as `Matchers<unknown>` (not PromiseLike),
            // so `await expect(...).rejects.toThrow(...)` triggers this rule even
            // though Bun's runtime does honour the await semantics on `.rejects`.
            "@typescript-eslint/await-thenable": "off",
        },
    },

    eslintConfigPrettier,
);

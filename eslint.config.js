import tseslint from 'typescript-eslint';
export default tseslint.config({ ignores: ['dist/**', 'coverage/**', '.superpowers/**'] }, ...tseslint.configs.recommended, { rules: { '@typescript-eslint/no-explicit-any': 'error' } });

// Minimal ambient declaration for the js-yaml surface this package uses (no @types/js-yaml
// dependency). scripts/validate.ts casts the default import at the call site; the src/ module
// decision-api.ts is type-checked (src/**/*.ts is in the package tsconfig include), so it needs a
// declared module. Only `load` is used.
declare module 'js-yaml' {
  const yaml: { load: (input: string) => unknown };
  export default yaml;
}

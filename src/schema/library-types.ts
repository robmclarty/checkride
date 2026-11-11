/**
 * The three libraries the `schema` slot runs on, as the slot reads them: the
 * few members it calls, typed here so no type of `ajv`, `yaml` or
 * `jsonc-parser` reaches a `.d.ts` this package ships. A copy the repo
 * installed and the copy the standalone binary bundles both answer to these.
 */

/** The libraries by their npm names. */
export type LibraryName = 'ajv' | 'yaml' | 'jsonc-parser';

/** One error `ajv` reports for a value that breaks its schema. */
export type AjvError = {
  instancePath: string;
  keyword: string;
  message?: string;
  params?: Record<string, unknown>;
};

/** A compiled schema: true for a value that satisfies it, with why not on `errors`. */
export type AjvValidate = ((data: unknown) => boolean) & { errors?: AjvError[] | null };

/** An `ajv` instance: schemas registered by key, and the validator of one. */
export type AjvInstance = {
  addSchema: (schema: unknown, key?: string) => unknown;
  getSchema: (key: string) => AjvValidate | undefined;
};

/** An `ajv` constructor, of one JSON Schema draft. */
export type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

/** `ajv`'s two constructors: `ajv` itself, which reads draft-07, and `ajv/dist/2020`, which reads draft 2020-12. */
export type AjvLibrary = { draft07: AjvConstructor; draft2020: AjvConstructor };

/** One error `yaml` reports, with the offsets it spans in the text. */
export type YamlError = { message: string; pos?: readonly number[] };

/** A parsed YAML document: its errors, its value, and the node a path leads to. */
export type YamlDocument = {
  errors: readonly YamlError[];
  toJS: () => unknown;
  getIn: (path: readonly unknown[], keepScalar?: boolean) => unknown;
  contents: unknown;
};

/** The part of `yaml` the slot calls. */
export type YamlLibrary = { parseDocument: (text: string, options: Record<string, unknown>) => YamlDocument };

/** One error `jsonc-parser` reports: its code, and the offset it sits at. */
export type JsoncError = { error: number; offset: number; length: number };

/** A node of the tree `jsonc-parser` parses a file into. */
export type JsoncNode = { offset: number };

/** The part of `jsonc-parser` the slot calls. */
export type JsoncLibrary = {
  parse: (text: string, errors: JsoncError[], options: Record<string, unknown>) => unknown;
  parseTree: (text: string, errors: JsoncError[], options: Record<string, unknown>) => JsoncNode | undefined;
  findNodeAtLocation: (root: JsoncNode, path: (string | number)[]) => JsoncNode | undefined;
  printParseErrorCode: (code: number) => string;
};

/** The libraries a run loaded: `ajv` always, `yaml` and `jsonc` only when a rule reads that format. */
export type SchemaLibraries = {
  ajv: AjvLibrary;
  yaml?: YamlLibrary;
  jsonc?: JsoncLibrary;
};

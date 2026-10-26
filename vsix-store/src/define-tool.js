/**
 * A local `defineTool`, equivalent to `@deepseek-ai/dsh-tools`'s helper.
 *
 * The harness's own `defineTool` lives in a package whose peer graph spans
 * the whole runtime (`dsh-agent`, `dsh-llm`, `dsh-scope`, `dsh-session`, …).
 * A bundle that depends on it would drag that graph into the profile's
 * `node_modules` on every install, so this bundle compiles the tool schema
 * itself and keeps the same contract:
 *
 * - `parameters` becomes a raw JSON Schema object root;
 * - the arguments are validated before `execute` runs;
 * - `output` declares the canonical value's schema and how it renders.
 *
 * The raw schema subset the harness enforces is: `type`, `oneOf`,
 * `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`,
 * plus the annotations `description`, `title`, `default` and `examples`.
 */

/**
 * Compile a parameter specification into a raw JSON Schema.
 * @param {Record<string, { type: string, required?: boolean, description?: string, enum?: Array<any> }>} spec - the per-parameter spec.
 * @returns {object} the raw JSON Schema.
 */
export function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [name, definition] of Object.entries(spec ?? {})) {
    const node = { type: definition.type }
    if (definition.description !== undefined) node.description = definition.description
    if (definition.enum !== undefined) node.enum = definition.enum
    properties[name] = node
    if (definition.required === true) required.push(name)
  }
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

/**
 * Validate one value against a raw JSON Schema node.
 * @param {object} schema - the schema node.
 * @param {unknown} value - the value.
 * @param {string} path - the diagnostic path.
 * @returns {string[]} the violations.
 */
function validateNode(schema, value, path) {
  const violations = []
  const type = schema?.type
  if (type === undefined) return violations
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`"${path}" must be an object`)
      return violations
    }
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) {
        violations.push(`"${path === '' ? key : `${path}.${key}`}" is required`)
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue
      violations.push(...validateNode(child, value[key], path === '' ? key : `${path}.${key}`))
    }
    return violations
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`"${path}" must be an array`)
      return violations
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        violations.push(...validateNode(schema.items, entry, `${path}[${index}]`))
      })
    }
    return violations
  }
  if (type === 'string' && typeof value !== 'string') {
    violations.push(`"${path}" must be a string`)
    return violations
  }
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    violations.push(`"${path}" must be a number`)
    return violations
  }
  if (type === 'integer' && !Number.isInteger(value)) {
    violations.push(`"${path}" must be an integer`)
    return violations
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    violations.push(`"${path}" must be a boolean`)
    return violations
  }
  if (type === 'null' && value !== null) {
    violations.push(`"${path}" must be null`)
    return violations
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    violations.push(`"${path}" must be one of ${JSON.stringify(schema.enum)}`)
  }
  return violations
}

/**
 * Define a model-facing tool.
 * @param {object} options - the tool definition.
 * @param {string} options.name - the model-facing tool name.
 * @param {string} options.description - the model-facing description.
 * @param {Record<string, object>} options.parameters - the parameter spec.
 * @param {{ schema: object, render: (args: any, value: any) => Array<object> }} options.output - the output declaration.
 * @param {(args: any, exec: any) => Promise<any>} options.execute - the tool body.
 * @param {number} [options.timeoutMs] - a cooperative timeout.
 * @returns {object} the registry-ready definition.
 */
export function defineTool({ name, description, parameters, output, execute, timeoutMs }) {
  const schema = compileParameters(parameters)
  return {
    name,
    description,
    parameters: schema,
    output,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    async execute(args, exec) {
      const violations = validateNode(schema, args ?? {}, '')
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return execute(args, exec)
    },
  }
}

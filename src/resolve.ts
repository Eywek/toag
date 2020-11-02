import { SymbolFlags, Type, Node } from 'ts-morph'
import ts from 'typescript'
import { OpenAPIV3 } from 'openapi-types'

export function buildRef (name: string) {
  return `#/components/schemas/${name}`
}

export function stringifyName (rawName: string) {
  let name = rawName
  if (name.startsWith('Promise<')) {
    const nameWithoutPromise = name.substr('Promise<'.length)
    name = nameWithoutPromise.substr(0, nameWithoutPromise.length - 1)
  }
  name = name.replace(/import\(.+\)\./g, '')
  return encodeURIComponent(
    name
      .replace(/<|>/g, '_')
      .replace(/\s+/g, '')
      .replace(/,/g, '.')
      .replace(/\'([^']*)\'/g, '$1')
      .replace(/\"([^"]*)\"/g, '$1')
      .replace(/&/g, '-and-')
      .replace(/\|/g, '-or-')
      .replace(/\[\]/g, '-Array')
      .replace(/{|}/g, '_') // SuccessResponse_{indexesCreated-number}_ -> SuccessResponse__indexesCreated-number__
      .replace(/([a-z]+):([a-z]+)/gi, '$1-$2') // SuccessResponse_indexesCreated:number_ -> SuccessResponse_indexesCreated-number_
      .replace(/;/g, '--')
      .replace(/([a-z]+)\[([a-z]+)\]/gi, '$1-at-$2') // Partial_SerializedDatasourceWithVersion[format]_ -> Partial_SerializedDatasourceWithVersion~format~_,
      .replace(/{|}|\[|\]|\(|\)/g, '_')
      .replace(/:/g, '-')
      .replace(/\?/g, '..')
      .replace(/'|"/g, '')
  )
}

function resolveNullableType (
  nonNullableType: Type,
  isUndefined: boolean,
  spec: OpenAPIV3.Document
): OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject {
  return Object.assign(resolve(nonNullableType, spec), { nullable: true })
}

function retrieveTypeName (
  type: Type
): string {
  const typeName = type.getSymbolOrThrow().getName()
  if (typeName === '__type') {
    const declaration = type.getSymbolOrThrow().getDeclarations()[0]
    if (declaration && Node.isTypeLiteralNode(declaration)) {
      const aliasSymbol = declaration.getType().getAliasSymbol()
      if (aliasSymbol) {
        return aliasSymbol.getName()
      }
    }
  }
  return typeName
}

export function resolve (
  type: Type,
  spec: OpenAPIV3.Document,
  resolveNullableTypeFn = resolveNullableType
): OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject {
  // Promises
  if (type.getSymbol()?.getEscapedName() === 'Promise') {
    return resolve(type.getTypeArguments()[0], spec)
  }
  // Nullable
  // We allow to override the behavior because for undefined values
  // we want to avoid putting it in the `required` prop for objects
  if (type.isNullable()) {
    const isUndefined = type.getUnionTypes().some(t => t.isUndefined())
    return resolveNullableTypeFn(type.getNonNullableType(), isUndefined, spec)
  }
  // JSDoc
  const jsDocTags = type.getSymbol()?.compilerSymbol.getJsDocTags()
  const description = jsDocTags?.find(tag => tag.name === 'description')?.text
  const pattern = jsDocTags?.find(tag => tag.name === 'pattern')?.text
  // Handle types
  if (type.isArray()) {
    return {
      type: 'array',
      items: resolve(type.getArrayElementTypeOrThrow(), spec),
      description
    }
  }
  if (type.isBoolean()) {
    return { type: 'boolean', description }
  }
  if (type.isUnknown()) {
    return { type: 'object', description }
  }
  if (type.isTuple()) { // OpenAPI doesn't support it, so we take it as an union of array
    // tslint:disable-next-line: no-console
    console.warn('typoa warning: Tuple aren\'t supported by OpenAPI, so we\'re transforming it to an array')
    return {
      type: 'array',
      items: {
        oneOf: type.getTupleElements().map(type => resolve(type, spec))
      },
      description
    }
  }
  if (type.isClassOrInterface() || type.isObject()) {
    const typeName = retrieveTypeName(type)
    // Special case for date
    if (typeName === 'Date') {
      return { type: 'string', format: 'date-time', description }
    }
    const resolved = {
      type: 'object' as const,
      ...resolveProperties(type, spec),
      description
    }
    // Special case for anonymous types and generic interfaces
    const typeArguments = type.getTypeArguments()
    if (typeName === '__type' || typeName === '__object' || typeArguments.length > 0) {
      return resolved
    }
    // Use ref for models and other defined types
    const refName = stringifyName(typeName)
    // Add to spec components if not already resolved
    // tslint:disable-next-line: strict-type-predicates
    if (typeof spec.components!.schemas![refName] === 'undefined') {
      spec.components!.schemas![refName] = resolved
    }
    // Return
    return { $ref: buildRef(refName) }
  }
  if (type.isIntersection()) {
    return {
      allOf: type.getIntersectionTypes().map(type => resolve(type, spec)),
      description
    }
  }
  if (type.isUnion()) {
    const values = type.getUnionTypes().map(type => resolve(type, spec))
    if (type.isEnum()) {
      const enumName = stringifyName(type.getSymbolOrThrow().getName())
      // Add to spec components if not already resolved
      // tslint:disable-next-line: strict-type-predicates
      if (typeof spec.components!.schemas![enumName] === 'undefined') {
        const resolvedTypes = type.getUnionTypes().map(type => resolve(type, spec) as OpenAPIV3.NonArraySchemaObject)
        const values = resolvedTypes.map(type => type.enum![0])
        spec.components!.schemas![enumName] = {
          type: resolvedTypes[0].type,
          enum: values,
          description,
          pattern
        }
      }
      return { $ref: buildRef(enumName) }
    }
    return {
      oneOf: values,
      description
    }
  }
  if ((type.isEnumLiteral() || type.isLiteral()) && type.compilerType.isLiteral()) {
    return {
      type: type.isNumberLiteral() ? 'number' : 'string',
      enum: [type.compilerType.value],
      description,
      pattern
    }
  }
  const typeName = type.getText() as 'string' | 'number' | 'void'
  if (typeName === 'void') {
    return { type: 'object' }
  }
  return {
    type: typeName,
    description,
    pattern
  }
}

type ResolvePropertiesReturnType = Required<Pick<OpenAPIV3.BaseSchemaObject, 'properties'>> &
  { required?: string[], additionalProperties?: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject }
function resolveProperties (type: Type, spec: OpenAPIV3.Document): ResolvePropertiesReturnType {
  const result: ResolvePropertiesReturnType = type.getProperties().reduce((schema, property) => {
    const firstDeclaration = property.getDeclarations()[0]
    let propertyType: Type
    // tslint:disable-next-line: strict-type-predicates
    if (typeof firstDeclaration === 'undefined') { // Happen with Record<'foo', string>.foo
      propertyType = property.getTypeAtLocation(type.getSymbolOrThrow().getDeclarations()[0])
    } else {
      propertyType = property.getTypeAtLocation(firstDeclaration)
    }
    const jsDocTags = property.compilerSymbol.getJsDocTags()
    // Handle readonly / getters props / @readonly tag
    const modifierFlags = property.getValueDeclaration()?.getCombinedModifierFlags()
    const isReadonly = modifierFlags === ts.ModifierFlags.Readonly || (
      property.hasFlags(SymbolFlags.GetAccessor) === true &&
      property.hasFlags(SymbolFlags.SetAccessor) === false
    ) || jsDocTags.some(tag => tag.name === 'readonly')
    // Required by default
    let required = true
    // We resolve the property, overriding the behavior for nullable values
    // if the value is optional (isUndefined = true) we don't push in the required array
    const resolvedType = resolve(propertyType, spec, (nonNullableType, isUndefined, spec) => {
      if (isUndefined) {
        required = false
        return resolve(nonNullableType, spec)
      }
      return Object.assign(resolve(nonNullableType, spec), { nullable: true })
    })
    if (isReadonly) {
      Object.assign(resolvedType, { readOnly: true })
    }
    // JSDoc tags
    for (const tag of jsDocTags) {
      if (['format', 'example', 'description', 'pattern', 'minimum', 'maximum'].includes(tag.name) && tag.text) {
        Object.assign(resolvedType, {
          [tag.name]: ['minimum', 'maximum'].includes(tag.name) ? parseFloat(tag.text) : tag.text
        })
      }
    }
    // Add to spec
    schema.properties[property.getName()] = resolvedType
    if (required) {
      schema.required.push(property.getName())
    }
    return schema
  }, { properties: {}, required: [] } as Required<Omit<ResolvePropertiesReturnType, 'additionalProperties'>>)
  if (result.required?.length === 0) {
    // OpenAPI don't want the required[] prop if it's empty
    delete result.required
  }
  if (Object.keys(result.properties).length === 0) {
    const stringIndexType = type.getStringIndexType()
    const numberIndexType = type.getNumberIndexType()
    // This is a mapped type string string or number as key (ex: { [key: string]: any } or Record<string, any>)
    if (stringIndexType || numberIndexType) {
      result.additionalProperties = resolve(
        stringIndexType ?? numberIndexType!,
        spec
      )
    }
  }
  return result
}

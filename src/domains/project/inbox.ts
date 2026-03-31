import type { OwnedMemory, DomainContext } from '../../core/types.ts'
import {
  PROJECT_TAG,
  PROJECT_DOMAIN_ID,
  PROJECT_DECISION_TAG,
  AUDIENCE_TAGS,
} from './types.ts'
import type { MemoryClassification, Audience } from './types.ts'
import { ensureTag, findOrCreateEntity, linkToTopics, classificationToTag } from './utils.ts'

const VALID_CLASSIFICATIONS = new Set<string>([
  'decision', 'rationale', 'clarification', 'direction', 'observation', 'question',
])

const VALID_AUDIENCES = new Set<string>(['technical', 'business'])

const ENTITY_EXTRACTION_SCHEMA = JSON.stringify({
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Entity name' },
      type: {
        type: 'string',
        enum: ['module', 'data_entity', 'concept', 'pattern'],
        description: 'Entity type',
      },
      path: { type: 'string', description: 'File system path (for modules)' },
      kind: {
        type: 'string',
        enum: ['package', 'service', 'lambda', 'subsystem', 'library'],
        description: 'Module kind (only for module type)',
      },
    },
    required: ['name', 'type'],
  },
})

const ENTITY_EXTRACTION_PROMPT =
  'Extract architectural entities referenced in this project knowledge memory. ' +
  'Return only entities explicitly mentioned or clearly implied. ' +
  'Types: module (code packages, services, lambdas), data_entity (domain objects like Order, Payment), ' +
  'concept (business concepts like reconciliation, return flow), pattern (architectural patterns in use). ' +
  'Only extract proper nouns in the project context — specific module names, domain objects, named patterns. ' +
  'Do not extract generic programming terms like "function", "class", "service", "database", "API".'

const CLASSIFICATION_PROMPT =
  'Classify this project knowledge into exactly one category:\n' +
  '- decision: a choice that was made ("we chose X because Y")\n' +
  '- rationale: explanation of why something works a certain way\n' +
  '- clarification: corrects a potential misunderstanding about naming or meaning\n' +
  '- direction: describes where the project is heading\n' +
  '- observation: notes a factual state or change\n' +
  '- question: flags a gap needing human input\n\n' +
  'Respond with ONLY the category name, nothing else.'

export async function processInboxItem(entry: OwnedMemory, context: DomainContext): Promise<void> {
  const attrs = entry.domainAttributes
  const content = entry.memory.content

  // Step 1: Determine classification
  let classification = attrs.classification as string | undefined
  if (!classification || !VALID_CLASSIFICATIONS.has(classification)) {
    const classifyLlm = context.llmAt('low')
    if (classifyLlm.generate) {
      const result = await classifyLlm.generate(
        `${CLASSIFICATION_PROMPT}\n\nText: ${content}`,
      )
      const normalized = result.trim().toLowerCase()
      classification = VALID_CLASSIFICATIONS.has(normalized) ? normalized : 'observation'
    } else {
      classification = 'observation'
    }
  }

  // Step 2: Determine audience
  let audience = attrs.audience as string[] | undefined
  if (!audience || !Array.isArray(audience)) {
    audience = ['technical']
  } else {
    audience = audience.filter(a => VALID_AUDIENCES.has(a))
    if (audience.length === 0) audience = ['technical']
  }

  // Step 3: Update attributes with resolved values
  await context.updateAttributes(entry.memory.id, {
    classification,
    audience,
    superseded: false,
  })

  // Step 4: Ensure tags and tag the memory
  const projectTagId = await ensureTag(context, PROJECT_TAG)
  await context.tagMemory(entry.memory.id, projectTagId)

  const classTag = classificationToTag(classification as MemoryClassification)
  const classTagId = await ensureTag(context, classTag)
  try {
    await context.graph.relate(classTagId, 'child_of', projectTagId)
  } catch { /* already related */ }
  await context.tagMemory(entry.memory.id, classTagId)

  for (const aud of audience) {
    const audTag = AUDIENCE_TAGS[aud as Audience]
    if (audTag) {
      const audTagId = await ensureTag(context, audTag)
      try {
        await context.graph.relate(audTagId, 'child_of', projectTagId)
      } catch { /* already related */ }
      await context.tagMemory(entry.memory.id, audTagId)
    }
  }

  // Step 5: Extract entities via LLM
  const entityLlm = context.llmAt('medium')
  if (entityLlm.extractStructured) {
    try {
      const entities = await entityLlm.extractStructured(
        content,
        ENTITY_EXTRACTION_SCHEMA,
        ENTITY_EXTRACTION_PROMPT,
      ) as Array<{ name: string; type: string; path?: string; kind?: string }>

      for (const entity of entities) {
        if (!entity.name || !entity.type) continue
        const fields: Record<string, unknown> = {}
        if (entity.path) fields.path = entity.path
        if (entity.kind) fields.kind = entity.kind

        const entityId = await findOrCreateEntity(context, entity.type, entity.name, fields)
        await context.graph.relate(entry.memory.id, 'about_entity', entityId, { relevance: 1.0 })
      }
    } catch {
      // Entity extraction is best-effort; continue without it
    }
  }

  // Step 6: Extract and link topics
  await linkToTopics(context, entry.memory.id, content)

  // Step 7: Contradiction detection for decisions
  if (classification === 'decision') {
    await detectContradictions(entry.memory.id, content, context)
  }
}

async function detectContradictions(
  memoryId: string,
  content: string,
  context: DomainContext,
): Promise<void> {
  const contradictionLlm = context.llmAt('low')
  if (!contradictionLlm.generate) return

  // Find existing non-superseded decisions about similar topics
  const searchResult = await context.search({
    text: content,
    tags: [PROJECT_DECISION_TAG],
    minScore: 0.7,
  })

  const existingDecisions = searchResult.entries.filter(e => {
    const attrs = e.domainAttributes[PROJECT_DOMAIN_ID] as Record<string, unknown> | undefined
    return attrs && !attrs.superseded && e.id !== memoryId
  })

  for (const existing of existingDecisions) {
    const prompt =
      'Do these two project decisions contradict each other? ' +
      'The first is the existing decision, the second is the new one.\n\n' +
      `Existing: ${existing.content}\n\n` +
      `New: ${content}\n\n` +
      'Respond with ONLY "yes" or "no".'

    // eslint guard checked above; TypeScript can't narrow across loop iterations
    const result = await contradictionLlm.generate(prompt)
    if (result.trim().toLowerCase().startsWith('yes')) {
      // New decision supersedes the old one
      await context.graph.relate(memoryId, 'supersedes', existing.id)
      await context.updateAttributes(existing.id, {
        ...existing.domainAttributes[PROJECT_DOMAIN_ID],
        superseded: true,
      })
    }
  }
}

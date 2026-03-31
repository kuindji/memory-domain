/**
 * LLM adapter that uses the Claude CLI (`claude`) for all LLM operations.
 * Spawns a subprocess for each call — no API keys needed.
 */

import type { LLMAdapter, ScoredMemory, ModelLevel } from '../../core/types.ts'

interface ClaudeCliConfig {
  command?: string
  model?: string
  modelLevels?: Partial<Record<ModelLevel, string>>
  maxTokens?: number
  timeout?: number
}

const DEFAULT_COMMAND = 'claude'
const DEFAULT_TIMEOUT = 120_000

class ClaudeCliAdapter implements LLMAdapter {
  private command: string
  private model: string | undefined
  private modelLevels: Partial<Record<ModelLevel, string>> | undefined
  private maxTokens: number | undefined
  private timeout: number
  private originalConfig: ClaudeCliConfig | undefined

  constructor(config?: ClaudeCliConfig) {
    this.originalConfig = config
    this.command = config?.command ?? DEFAULT_COMMAND
    this.model = config?.model
    this.modelLevels = config?.modelLevels
    this.maxTokens = config?.maxTokens
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT
  }

  withLevel(level: ModelLevel): LLMAdapter {
    const model = this.modelLevels?.[level] ?? this.model
    return new ClaudeCliAdapter({ ...this.originalConfig, model })
  }

  private async run(prompt: string): Promise<string> {
    const args = ['--print']
    if (this.model) {
      args.push('--model', this.model)
    }
    if (this.maxTokens) {
      args.push('--max-tokens', String(this.maxTokens))
    }

    const proc = Bun.spawn([this.command, ...args], {
      stdin: new TextEncoder().encode(prompt),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const timeoutId = setTimeout(() => {
      proc.kill()
    }, this.timeout)

    try {
      const output = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      clearTimeout(timeoutId)

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        throw new Error(`Claude CLI exited with code ${exitCode}: ${stderr}`)
      }

      return output.trim()
    } catch (err) {
      clearTimeout(timeoutId)
      throw err
    }
  }

  private parseJsonResponse<T>(text: string): T {
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    const jsonStr = jsonMatch ? jsonMatch[1] : text
    return JSON.parse(jsonStr) as T
  }

  async extractStructured(text: string, schema: string, prompt?: string): Promise<unknown[]> {
    const systemPrompt = prompt
      ?? 'Extract structured information from the following text.'

    const fullPrompt = `${systemPrompt}\n\nExpected output schema for each item:\n${schema}\n\n<text>\n${text}\n</text>\n\nReturn ONLY a JSON array of objects matching the schema.`
    const response = await this.run(fullPrompt)
    return this.parseJsonResponse<unknown[]>(response)
  }

  async extract(text: string, prompt?: string): Promise<string[]> {
    const systemPrompt = prompt
      ?? 'Extract the key factual claims from the following text. Return a JSON array of strings, each being one atomic fact.'

    const fullPrompt = `${systemPrompt}\n\n<text>\n${text}\n</text>\n\nReturn ONLY a JSON array of strings.`
    const response = await this.run(fullPrompt)
    return this.parseJsonResponse<string[]>(response)
  }

  async assess(content: string, existingContext: string[]): Promise<number> {
    const contextBlock = existingContext.length > 0
      ? `\n\nExisting memories:\n${existingContext.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : ''

    const prompt = `Rate the novelty and importance of the following content on a scale from 0.0 to 1.0, where 0.0 means completely redundant/trivial and 1.0 means highly novel and important.${contextBlock}

New content: "${content}"

Return ONLY a JSON number between 0.0 and 1.0.`

    const response = await this.run(prompt)
    const score = parseFloat(response.replace(/[^0-9.]/g, ''))
    return Math.max(0, Math.min(1, score))
  }

  async rerank(
    query: string,
    candidates: { id: string; content: string }[],
  ): Promise<string[]> {
    const candidateList = candidates
      .map((c, i) => `[${i}] (id: ${c.id}) ${c.content}`)
      .join('\n')

    const prompt = `Given the query: "${query}"

Rerank these memory candidates by relevance. Return a JSON array of their IDs in order from most to least relevant.

Candidates:
${candidateList}

Return ONLY a JSON array of ID strings.`

    const response = await this.run(prompt)
    return this.parseJsonResponse<string[]>(response)
  }

  async consolidate(memories: string[]): Promise<string> {
    const memoryList = memories.map((m, i) => `${i + 1}. ${m}`).join('\n')

    const prompt = `Consolidate the following related memories into a single, comprehensive summary that preserves all important details:

${memoryList}

Return ONLY the consolidated text (no JSON, no markdown).`

    return this.run(prompt)
  }

  async generate(prompt: string): Promise<string> {
    return this.run(prompt)
  }

  async synthesize(
    query: string,
    memories: ScoredMemory[],
    tagContext?: string[],
  ): Promise<string> {
    const memoryList = memories
      .map((m, i) => `[${i + 1}] (score: ${m.score.toFixed(3)}) ${m.content}`)
      .join('\n')

    const tagBlock = tagContext?.length
      ? `\nRelevant context tags: ${tagContext.join(', ')}`
      : ''

    const prompt = `Given the following query and retrieved memories, provide an analytical synthesis.

Query: "${query}"
${tagBlock}

Retrieved memories:
${memoryList}

Provide a concise, well-structured analytical response that directly addresses the query using the evidence from these memories. Do not invent facts not present in the memories.`

    return this.run(prompt)
  }
}

export { ClaudeCliAdapter }
export type { ClaudeCliConfig }

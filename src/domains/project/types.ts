export type MemoryClassification = 'decision' | 'rationale' | 'clarification' | 'direction' | 'observation' | 'question'

export type Audience = 'technical' | 'business'

export type ModuleKind = 'package' | 'service' | 'lambda' | 'subsystem' | 'library'

export interface ProjectAttributes {
  classification: MemoryClassification
  audience: Audience[]
  superseded: boolean
}

export interface ProjectDomainOptions {
  projectRoot?: string
  commitScanner?: {
    enabled?: boolean
    intervalMs?: number
  }
  driftDetector?: {
    enabled?: boolean
    intervalMs?: number
  }
}

export const PROJECT_DOMAIN_ID = 'project'
export const PROJECT_TAG = 'project'
export const PROJECT_TECHNICAL_TAG = 'project/technical'
export const PROJECT_BUSINESS_TAG = 'project/business'
export const PROJECT_DECISION_TAG = 'project/decision'
export const PROJECT_RATIONALE_TAG = 'project/rationale'
export const PROJECT_CLARIFICATION_TAG = 'project/clarification'
export const PROJECT_DIRECTION_TAG = 'project/direction'
export const PROJECT_OBSERVATION_TAG = 'project/observation'
export const PROJECT_QUESTION_TAG = 'project/question'

export const DEFAULT_SCAN_INTERVAL_MS = 3_600_000 // 1 hour
export const DEFAULT_DRIFT_INTERVAL_MS = 86_400_000 // 24 hours

export const CLASSIFICATION_TAGS: Record<MemoryClassification, string> = {
  decision: PROJECT_DECISION_TAG,
  rationale: PROJECT_RATIONALE_TAG,
  clarification: PROJECT_CLARIFICATION_TAG,
  direction: PROJECT_DIRECTION_TAG,
  observation: PROJECT_OBSERVATION_TAG,
  question: PROJECT_QUESTION_TAG,
}

export const AUDIENCE_TAGS: Record<Audience, string> = {
  technical: PROJECT_TECHNICAL_TAG,
  business: PROJECT_BUSINESS_TAG,
}

// --- Bootstrap types ---

export interface DirEntry {
  name: string
  relativePath: string
  isDirectory: boolean
  children?: DirEntry[]
  files?: string[]
}

export interface TriageResult {
  repoSize?: string
  filesToRead?: string[]
}

export interface AnalysisModule {
  name: string
  path: string
  kind: string
  description?: string
}

export interface AnalysisRelationship {
  from: string
  to: string
  type: string
  description?: string
}

export interface AnalysisResult {
  modules?: AnalysisModule[]
  data_entities?: Array<{ name: string; source?: string }>
  concepts?: Array<{ name: string; description?: string }>
  patterns?: Array<{ name: string; scope?: string }>
  relationships?: AnalysisRelationship[]
}

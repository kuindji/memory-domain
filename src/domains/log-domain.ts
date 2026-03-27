import type { DomainConfig, OwnedMemory, DomainContext } from '../core/types.ts'

export const logDomain: DomainConfig = {
  id: 'log',
  name: 'Log',
  async processInboxItem(_entry: OwnedMemory, _context: DomainContext): Promise<void> {
    // Log domain is a no-op processor — it just keeps the raw memories
  },
  describe() {
    return 'Built-in chronological log. Keeps all ingested memories with no processing.'
  },
}

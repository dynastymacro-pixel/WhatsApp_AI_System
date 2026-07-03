// src/db/repositories/index.ts
// Barrel export for repository layer

export { BaseRepository } from './BaseRepository';
export { ClientRepository } from './ClientRepository';
export { CustomerRepository } from './CustomerRepository';
export { MessageRepository } from './MessageRepository';
export { ProductRepository } from './ProductRepository';
export { ConversationRepository } from './ConversationRepository';
export { ConversationMessageRepository } from './ConversationMessageRepository';

export type { LogMessageInput } from './MessageRepository';
export type { UpdateConversationInput } from './ConversationRepository';
